"""SQLite store. Amounts follow Plaid's sign convention: positive leaves the
account (spend), negative is a credit or refund."""

import os
import sqlite3
import threading
from pathlib import Path

DB_PATH = Path(os.environ.get("SPENDTRACK_DB", Path.home() / ".spendtrack" / "spendtrack.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    item_id          TEXT PRIMARY KEY,
    access_token     TEXT NOT NULL,
    institution_id   TEXT,
    institution_name TEXT,
    cursor           TEXT,
    status           TEXT NOT NULL DEFAULT 'ok',
    last_synced_at   TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
    account_id        TEXT PRIMARY KEY,
    item_id           TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
    name              TEXT,
    official_name     TEXT,
    mask              TEXT,
    type              TEXT,
    subtype           TEXT,
    current_balance   REAL,
    available_balance REAL,
    credit_limit      REAL,
    iso_currency      TEXT,
    updated_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_accounts_item ON accounts(item_id);

-- /liabilities detail, credit cards only
CREATE TABLE IF NOT EXISTS card_details (
    account_id             TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
    last_statement_balance REAL,
    last_statement_date    TEXT,
    next_payment_due_date  TEXT,
    minimum_payment        REAL,
    apr_percentage         REAL,
    is_overdue             INTEGER,
    updated_at             TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
    txn_id          TEXT PRIMARY KEY,
    account_id      TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    date            TEXT NOT NULL,
    name            TEXT,
    merchant_name   TEXT,
    merchant_key    TEXT NOT NULL,
    amount          REAL NOT NULL,
    iso_currency    TEXT,
    pending         INTEGER NOT NULL DEFAULT 0,
    plaid_category  TEXT,
    category        TEXT,
    category_source TEXT,
    is_transfer     INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_date     ON transactions(date DESC);
CREATE INDEX IF NOT EXISTS idx_txn_account  ON transactions(account_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_txn_merchant ON transactions(merchant_key);
-- the dashboard's hot query: spend by category over a date range
CREATE INDEX IF NOT EXISTS idx_txn_spend    ON transactions(is_transfer, date, category);

-- One row per merchant the LLM has ever been asked about, so it is asked once.
CREATE TABLE IF NOT EXISTS merchant_category_cache (
    merchant_key TEXT PRIMARY KEY,
    category     TEXT NOT NULL,
    model        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Manual corrections. Outrank rules and the cache, and never expire.
CREATE TABLE IF NOT EXISTS category_overrides (
    merchant_key TEXT PRIMARY KEY,
    category     TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Monthly spending limit per category.
CREATE TABLE IF NOT EXISTS budgets (
    category TEXT PRIMARY KEY,
    monthly  REAL NOT NULL CHECK (monthly > 0)
);

-- A merchant you always split the same way - rent with a flatmate, a shared
-- utility. Keyed on merchant like category_overrides, so it applies to every
-- future charge without you touching it again.
CREATE TABLE IF NOT EXISTS split_rules (
    merchant_key TEXT PRIMARY KEY,
    -- 0 is legitimate: a charge that is entirely someone else's, like paying
    -- a friend's subscription on your card every month.
    my_share     REAL NOT NULL CHECK (my_share >= 0 AND my_share <= 1),
    note         TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     TEXT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    added       INTEGER DEFAULT 0,
    modified    INTEGER DEFAULT 0,
    removed     INTEGER DEFAULT 0,
    error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_started ON sync_log(started_at DESC);
"""


# Columns added after the first release. CREATE TABLE IF NOT EXISTS never
# alters a table that already exists, so databases created earlier get them here.
COLUMNS = [
    ("items", "institution_logo", "TEXT"),      # base64 PNG from Plaid
    ("items", "institution_color", "TEXT"),
    ("transactions", "logo_url", "TEXT"),
    # Dollars back from Rakuten-style portals. Spend totals use amount - cashback.
    ("transactions", "cashback", "REAL NOT NULL DEFAULT 0"),
    ("transactions", "cashback_pct", "REAL"),        # as entered; NULL for a flat amount
    ("transactions", "cashback_payout", "TEXT"),     # paypal | amex_mr | bilt
    ("transactions", "cashback_source", "TEXT"),
    ("transactions", "cashback_received", "INTEGER NOT NULL DEFAULT 0"),
    # Someone else's share of a bill you fronted. Same shape as cashback: spend
    # totals use amount - cashback - split_owed, so a $120 dinner split in half
    # costs you $60 rather than $120.
    ("transactions", "split_owed", "REAL NOT NULL DEFAULT 0"),
    ("transactions", "split_note", "TEXT"),          # who it was with
    ("transactions", "split_source", "TEXT"),        # manual | rule
    ("transactions", "split_settled", "INTEGER NOT NULL DEFAULT 0"),
]

_local = threading.local()


def _migrate(conn: sqlite3.Connection) -> None:
    for table, column, decl in COLUMNS:
        have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if column not in have:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def _relax_split_rule_check(conn: sqlite3.Connection) -> None:
    """Rebuild split_rules if it still carries the original my_share > 0 check.

    SQLite cannot alter a CHECK in place. The table is small and rows are copied
    across, so this is safe to run on every start - it does nothing once done.
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='split_rules'").fetchone()
    if not row or "my_share > 0" not in row["sql"]:
        return
    conn.executescript("""
        BEGIN;
        CREATE TABLE split_rules_new (
            merchant_key TEXT PRIMARY KEY,
            my_share     REAL NOT NULL CHECK (my_share >= 0 AND my_share <= 1),
            note         TEXT,
            created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO split_rules_new SELECT merchant_key, my_share, note, created_at
          FROM split_rules;
        DROP TABLE split_rules;
        ALTER TABLE split_rules_new RENAME TO split_rules;
        COMMIT;
    """)


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    # timeout, not failure, when a writer holds the lock
    conn = sqlite3.connect(DB_PATH, isolation_level=None, timeout=15.0)
    conn.row_factory = sqlite3.Row
    # WAL lets the dashboard read while a sync writes
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init() -> sqlite3.Connection:
    """The connection for this thread, schema applied.

    One per thread is not an optimisation - a sqlite3 connection may only be
    used on the thread that created it, and the API serves sync endpoints from
    a threadpool, so a single shared connection dies on the first two
    concurrent requests.
    """
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _local.conn = connect()
        conn.executescript(SCHEMA)
        _migrate(conn)
        _relax_split_rule_check(conn)
    return conn
