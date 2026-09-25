"""Plaid ingestion.

Everything goes through /transactions/sync, which is cursor-based: each call
returns only what changed since the cursor we stored last time. The cursor is
committed in the same transaction as the rows it produced, so an interrupted
run resumes exactly where it stopped rather than refetching history.
"""

import os
import sqlite3
from datetime import datetime, timezone

import plaid
from plaid.api import plaid_api
from plaid.model.accounts_get_request import AccountsGetRequest
from plaid.model.country_code import CountryCode
from plaid.model.institutions_get_by_id_request import InstitutionsGetByIdRequest
from plaid.model.institutions_get_by_id_request_options import InstitutionsGetByIdRequestOptions
from plaid.model.item_get_request import ItemGetRequest
from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
from plaid.model.item_remove_request import ItemRemoveRequest
from plaid.model.liabilities_get_request import LiabilitiesGetRequest
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.link_token_transactions import LinkTokenTransactions
from plaid.model.products import Products
from plaid.model.transactions_sync_request import TransactionsSyncRequest

from .categorize import Categorizer, merchant_key

ENVIRONMENTS = {
    "sandbox": plaid.Environment.Sandbox,
    "production": plaid.Environment.Production,
}
PAGE_SIZE = 500
# Plaid's maximum initial history pull. The default is 90 and is unextendable.
HISTORY_DAYS = 730

# Everything below is fixed at link time and cannot be changed without deleting
# the Item and linking again - which permanently costs another of the 10 free
# Trial Items. Hence the belt-and-braces: ask for the most we could ever want.
#
#   products                       hard requirement; Link FAILS if unsupported,
#                                  and bills on creation under a paid plan
#   required_if_supported_products initialised where the bank supports it,
#                                  does not block where it does not
#   additional_consented_products  consent captured now, nothing initialised and
#                                  nothing billed - but the product can be turned
#                                  on later WITHOUT re-linking. This is the field
#                                  that protects the Item slots.
LINK_PRODUCTS = ["transactions"]
LINK_REQUIRED_IF_SUPPORTED = ["liabilities"]
# assets and statements are rejected by additional_consented_products, and
# income_verification needs account approval - all verified against the API.
LINK_CONSENTED = ["investments", "auth", "identity"]

# Only the countries this Plaid account is actually enabled for. The European
# codes are rejected outright until requested through Plaid support, and an
# unapproved code fails the whole link_token_create call. India is not covered
# by Plaid at all.
LINK_COUNTRIES = ["US", "CA"]


def client() -> plaid_api.PlaidApi:
    env = os.environ.get("PLAID_ENV", "sandbox").lower()
    if env not in ENVIRONMENTS:
        raise ValueError(f"PLAID_ENV must be one of {sorted(ENVIRONMENTS)}, got {env!r}")
    client_id = os.environ.get("PLAID_CLIENT_ID")
    # Plaid issues a different secret per environment. Prefer the one named for
    # the active environment so switching is a one-word edit, and a stale secret
    # can never be silently sent to the wrong host.
    secret = os.environ.get(f"PLAID_SECRET_{env.upper()}") or os.environ.get("PLAID_SECRET")
    if not client_id or not secret:
        raise RuntimeError(
            f"PLAID_CLIENT_ID and a secret for {env} must be set. Put the {env} secret in "
            f"PLAID_SECRET_{env.upper()} (or PLAID_SECRET) - see .env.example"
        )
    config = plaid.Configuration(
        host=ENVIRONMENTS[env],
        api_key={"clientId": client_id, "secret": secret},
    )
    return plaid_api.PlaidApi(plaid.ApiClient(config))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _enum(value) -> str | None:
    """Plaid model enums stringify with quotes; take the raw value."""
    if value is None:
        return None
    return str(getattr(value, "value", value))


# --- linking -----------------------------------------------------------------

def create_link_token(api: plaid_api.PlaidApi, user_id: str = "spendtrack-local",
                      access_token: str | None = None) -> str:
    """Token for the browser-side Plaid Link handshake.

    Transactions and Liabilities are both requested up front: adding a product
    to an existing Item later needs a re-link, and Liabilities is what supplies
    statement balances, due dates and APRs for credit cards.

    days_requested is asked for at the maximum, and it matters: Plaid defaults
    to 90 days, and an Item's history window CANNOT be extended afterwards -
    not by update mode, not by re-syncing. Getting more history means deleting
    the Item and linking again, which costs another slot against the free
    Trial's 10. Ask for everything the first time.
    """
    days = int(os.environ.get("PLAID_DAYS_REQUESTED", HISTORY_DAYS))
    kwargs = dict(
        products=[Products(p) for p in LINK_PRODUCTS],
        required_if_supported_products=[Products(p) for p in LINK_REQUIRED_IF_SUPPORTED],
        additional_consented_products=[Products(p) for p in LINK_CONSENTED],
        client_name="spendtrack",
        country_codes=[CountryCode(c) for c in LINK_COUNTRIES],
        language="en",
        user=LinkTokenCreateRequestUser(client_user_id=user_id),
        transactions=LinkTokenTransactions(days_requested=days),
    )
    if access_token:
        # Update mode: re-authenticate an existing Item in place. This does NOT
        # create a new Item, so a bank forcing re-login costs no slot. Product
        # and country fields are rejected here - the Item already has them.
        return api.link_token_create(LinkTokenCreateRequest(
            client_name="spendtrack",
            country_codes=[CountryCode(c) for c in LINK_COUNTRIES],
            language="en",
            user=LinkTokenCreateRequestUser(client_user_id=user_id),
            access_token=access_token,
        )).link_token
    return api.link_token_create(LinkTokenCreateRequest(**kwargs)).link_token


def exchange_public_token(conn: sqlite3.Connection, api: plaid_api.PlaidApi, public_token: str) -> str:
    """Trade Link's public_token for a long-lived access_token and store the Item."""
    exchange = api.item_public_token_exchange(
        ItemPublicTokenExchangeRequest(public_token=public_token)
    )
    access_token, item_id = exchange.access_token, exchange.item_id

    institution_id = api.item_get(ItemGetRequest(access_token=access_token)).item.institution_id
    name = logo = color = None
    if institution_id:
        name, logo, color = _institution(api, institution_id)

    conn.execute(
        "INSERT OR REPLACE INTO items (item_id, access_token, institution_id, institution_name,"
        " institution_logo, institution_color) VALUES (?, ?, ?, ?, ?, ?)",
        (item_id, access_token, institution_id, name, logo, color),
    )
    _sync_accounts(conn, api, access_token, item_id)
    return item_id


def _institution(api: plaid_api.PlaidApi, institution_id: str) -> tuple[str, str | None, str | None]:
    """Name, base64 PNG logo and brand color. Not every institution has a logo."""
    inst = api.institutions_get_by_id(InstitutionsGetByIdRequest(
        institution_id=institution_id, country_codes=[CountryCode("US")],
        options=InstitutionsGetByIdRequestOptions(include_optional_metadata=True),
    )).institution
    return inst.name, inst.get("logo"), inst.get("primary_color")


def backfill_institutions(conn: sqlite3.Connection, api: plaid_api.PlaidApi) -> None:
    """Items linked before logos were stored. Plaid always returns a color, even
    a generated one, so a NULL color means this item was never asked."""
    for item in conn.execute(
        "SELECT item_id, institution_id FROM items"
        " WHERE institution_color IS NULL AND institution_id IS NOT NULL"
    ).fetchall():
        try:
            _, logo, color = _institution(api, item["institution_id"])
        except plaid.ApiException:
            continue
        conn.execute(
            "UPDATE items SET institution_logo = ?, institution_color = ? WHERE item_id = ?",
            (logo, color or "", item["item_id"]),
        )


def remove_item(conn: sqlite3.Connection, api: plaid_api.PlaidApi, item_id: str) -> dict:
    """Delete an Item at Plaid and drop its local rows.

    Note what this does NOT do: free the Item slot. The free Trial's limit of 10
    counts Items ever created, so removing and re-linking an institution costs a
    second slot permanently. Removal is still correct - it stops Plaid updating a
    connection you have replaced - but it is not a way to reclaim quota.

    Your categorisation work survives: overrides and the LLM cache are keyed on
    merchant, not on transaction or account, so they are untouched.
    """
    row = conn.execute(
        "SELECT access_token, institution_name FROM items WHERE item_id = ?", (item_id,)
    ).fetchone()
    if row is None:
        raise ValueError(f"no such item {item_id!r}")

    removed_remotely = True
    try:
        api.item_remove(ItemRemoveRequest(access_token=row["access_token"]))
    except plaid.ApiException as exc:
        # An Item already gone at Plaid should still be cleaned up locally
        if "ITEM_NOT_FOUND" not in str(exc):
            raise
        removed_remotely = False

    counts = conn.execute("""
        SELECT (SELECT COUNT(*) FROM accounts WHERE item_id = ?) AS accts,
               (SELECT COUNT(*) FROM transactions WHERE account_id IN
                    (SELECT account_id FROM accounts WHERE item_id = ?)) AS txns
    """, (item_id, item_id)).fetchone()

    conn.execute("BEGIN")
    try:
        # card_details and transactions cascade from accounts
        conn.execute("DELETE FROM accounts WHERE item_id = ?", (item_id,))
        conn.execute("DELETE FROM items WHERE item_id = ?", (item_id,))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    return {"institution": row["institution_name"] or item_id,
            "accounts": counts["accts"], "transactions": counts["txns"],
            "removed_at_plaid": removed_remotely}


# --- accounts and balances ---------------------------------------------------

def _sync_accounts(conn: sqlite3.Connection, api: plaid_api.PlaidApi,
                   access_token: str, item_id: str) -> None:
    accounts = api.accounts_get(AccountsGetRequest(access_token=access_token)).accounts
    _upsert_accounts(conn, item_id, accounts)


def _upsert_accounts(conn: sqlite3.Connection, item_id: str, accounts) -> None:
    now = _now()
    conn.executemany(
        """INSERT INTO accounts (account_id, item_id, name, official_name, mask, type,
                                 subtype, current_balance, available_balance, credit_limit,
                                 iso_currency, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
               name=excluded.name, official_name=excluded.official_name,
               mask=excluded.mask, type=excluded.type, subtype=excluded.subtype,
               current_balance=excluded.current_balance,
               available_balance=excluded.available_balance,
               credit_limit=excluded.credit_limit,
               iso_currency=excluded.iso_currency, updated_at=excluded.updated_at""",
        [
            (a.account_id, item_id, a.name, a.official_name, a.mask,
             _enum(a.type), _enum(a.subtype),
             a.balances.current, a.balances.available, a.balances.limit,
             a.balances.iso_currency_code, now)
            for a in accounts
        ],
    )


def sync_liabilities(conn: sqlite3.Connection, api: plaid_api.PlaidApi, access_token: str) -> int:
    """Statement balance, due date, minimum payment and APR per credit card.

    Not every institution supports Liabilities; a product-unsupported error is
    expected and is not worth failing the whole sync over.
    """
    try:
        credit = api.liabilities_get(LiabilitiesGetRequest(access_token=access_token)).liabilities.credit
    except plaid.ApiException as exc:
        if "PRODUCT_NOT_READY" in str(exc) or "PRODUCTS_NOT_SUPPORTED" in str(exc):
            return 0
        raise
    if not credit:
        return 0

    now = _now()
    rows = []
    for card in credit:
        aprs = card.aprs or []
        purchase_apr = next(
            (a.apr_percentage for a in aprs if _enum(a.apr_type) == "purchase_apr"),
            aprs[0].apr_percentage if aprs else None,
        )
        rows.append((
            card.account_id, card.last_statement_balance,
            str(card.last_statement_issue_date) if card.last_statement_issue_date else None,
            str(card.next_payment_due_date) if card.next_payment_due_date else None,
            card.minimum_payment_amount, purchase_apr,
            int(bool(card.is_overdue)), now,
        ))
    conn.executemany(
        """INSERT OR REPLACE INTO card_details
           (account_id, last_statement_balance, last_statement_date,
            next_payment_due_date, minimum_payment, apr_percentage, is_overdue, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        rows,
    )
    return len(rows)


# --- transactions ------------------------------------------------------------

def _to_row(txn) -> dict:
    pfc = getattr(txn, "personal_finance_category", None)
    return {
        "txn_id": txn.transaction_id,
        "account_id": txn.account_id,
        # authorized_date is when you actually spent; date is when it posted
        "date": str(txn.authorized_date or txn.date),
        "name": txn.name,
        "merchant_name": txn.merchant_name,
        "merchant_key": merchant_key(txn.name, txn.merchant_name),
        "amount": float(txn.amount),
        "iso_currency": txn.iso_currency_code,
        "pending": int(bool(txn.pending)),
        "plaid_category": _enum(pfc.primary) if pfc else None,
        "logo_url": txn.get("logo_url"),
        # not stored; only used to carry cashback from a pending row to its posted one
        "pending_transaction_id": txn.get("pending_transaction_id"),
    }


_UPSERT_TXN = """
INSERT INTO transactions (txn_id, account_id, date, name, merchant_name, merchant_key,
                          amount, iso_currency, pending, plaid_category, logo_url,
                          category, category_source, is_transfer, updated_at)
VALUES (:txn_id, :account_id, :date, :name, :merchant_name, :merchant_key,
        :amount, :iso_currency, :pending, :plaid_category, :logo_url, :category,
        :category_source, :is_transfer, :updated_at)
ON CONFLICT(txn_id) DO UPDATE SET
    date=excluded.date, name=excluded.name, merchant_name=excluded.merchant_name,
    merchant_key=excluded.merchant_key, amount=excluded.amount,
    pending=excluded.pending, plaid_category=excluded.plaid_category,
    logo_url=excluded.logo_url, updated_at=excluded.updated_at,
    -- a category you fixed by hand, for the merchant or this one transaction,
    -- survives every later sync
    category=CASE WHEN transactions.category_source IN ('override', 'manual')
                  THEN transactions.category ELSE excluded.category END,
    category_source=CASE WHEN transactions.category_source IN ('override', 'manual')
                         THEN transactions.category_source ELSE excluded.category_source END,
    is_transfer=CASE WHEN transactions.category_source IN ('override', 'manual')
                     THEN transactions.is_transfer ELSE excluded.is_transfer END
"""


def carry_marks(conn: sqlite3.Connection, pairs: list[tuple[str, str]]) -> None:
    """A pending charge posts under a new transaction_id and the pending row is
    removed in the same sync, so anything you set while it was pending - a
    one-off category, a cashback mark - would vanish with it. Move each to its
    posted row, re-applying a cashback percentage to the posted amount, since a
    tip changes the total."""
    if not pairs:
        return
    conn.executemany("""
        UPDATE transactions SET (category, category_source, is_transfer) =
            (SELECT category, category_source, is_transfer
             FROM transactions WHERE txn_id = :pending)
        WHERE txn_id = :posted
          AND EXISTS (SELECT 1 FROM transactions
                      WHERE txn_id = :pending AND category_source = 'manual')
    """, [{"pending": p, "posted": q} for p, q in pairs])
    conn.executemany("""
        UPDATE transactions SET
            (cashback, cashback_pct, cashback_payout, cashback_source, cashback_received) =
            (SELECT cashback, cashback_pct, cashback_payout, cashback_source, cashback_received
             FROM transactions WHERE txn_id = :pending)
        WHERE txn_id = :posted AND cashback = 0
          AND EXISTS (SELECT 1 FROM transactions WHERE txn_id = :pending AND cashback > 0)
    """, [{"pending": p, "posted": q} for p, q in pairs])
    conn.executemany(
        "UPDATE transactions SET cashback = MIN(amount, ROUND(amount * cashback_pct / 100, 2))"
        " WHERE txn_id = ? AND cashback_pct IS NOT NULL AND amount > 0",
        [(q,) for _, q in pairs],
    )


def apply_split_rules(conn: sqlite3.Connection, txn_ids: list[str]) -> int:
    """Split newly arrived charges from merchants you have a standing rule for.

    This is what makes a shared rent or utility net itself every month without
    you touching it. A split you set by hand is left alone - `split_source` of
    'manual' outranks the rule, the same way a category override outranks a
    categorisation rule.
    """
    if not txn_ids:
        return 0
    marks = ",".join("?" * len(txn_ids))
    cur = conn.execute(f"""
        UPDATE transactions
           SET split_owed  = ROUND(amount * (1 - (
                   SELECT my_share FROM split_rules r WHERE r.merchant_key = transactions.merchant_key)), 2),
               split_note   = (SELECT note FROM split_rules r WHERE r.merchant_key = transactions.merchant_key),
               split_source = 'rule'
         WHERE txn_id IN ({marks})
           AND COALESCE(split_source, '') != 'manual'
           AND merchant_key IN (SELECT merchant_key FROM split_rules)
    """, txn_ids)
    return cur.rowcount


def sync_item(conn: sqlite3.Connection, api: plaid_api.PlaidApi,
              item_id: str, access_token: str, cursor: str | None,
              use_llm: bool = True) -> dict:
    """Drain /transactions/sync for one institution. Returns change counts."""
    added, modified, removed, accounts = [], [], [], None
    has_more = True
    while has_more:
        resp = api.transactions_sync(TransactionsSyncRequest(
            access_token=access_token,
            cursor=cursor or "",
            count=PAGE_SIZE,
        ))
        added.extend(resp.added)
        modified.extend(resp.modified)
        removed.extend(resp.removed)
        accounts = resp.accounts or accounts
        cursor, has_more = resp.next_cursor, resp.has_more

    rows = [_to_row(t) for t in added + modified]
    if rows:
        Categorizer(conn).resolve(rows, use_llm=use_llm)
        now = _now()
        for row in rows:
            row["updated_at"] = now

    # Rows, balances and the cursor land together: if this fails, the next run
    # replays the same page instead of skipping it.
    conn.execute("BEGIN")
    try:
        if accounts:
            _upsert_accounts(conn, item_id, accounts)
        if rows:
            conn.executemany(_UPSERT_TXN, rows)
            carry_marks(conn, [(r["pending_transaction_id"], r["txn_id"])
                                  for r in rows if r["pending_transaction_id"]])
            apply_split_rules(conn, [r["txn_id"] for r in rows])
        if removed:
            conn.executemany(
                "DELETE FROM transactions WHERE txn_id = ?",
                [(t.transaction_id,) for t in removed],
            )
        # Plaid hands back an empty cursor while a fresh Item's transactions are
        # still being prepared. Keep the previous one rather than resetting to
        # the beginning of history.
        conn.execute(
            "UPDATE items SET cursor = COALESCE(NULLIF(?, ''), cursor),"
            " last_synced_at = ?, status = 'ok' WHERE item_id = ?",
            (cursor, _now(), item_id),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    return {"added": len(added), "modified": len(modified), "removed": len(removed)}


def sync_all(conn: sqlite3.Connection, api: plaid_api.PlaidApi, use_llm: bool = True,
             full: bool = False) -> list[dict]:
    """Sync every linked institution. One failing Item does not stop the others.

    full=True ignores the stored cursors and replays the whole history - free,
    costs no Items, and is how rows stored before a new column existed get it.
    """
    backfill_institutions(conn, api)
    results = []
    for item in conn.execute(
        "SELECT item_id, access_token, cursor, institution_name FROM items"
    ).fetchall():
        label = item["institution_name"] or item["item_id"]
        started = _now()
        try:
            counts = sync_item(conn, api, item["item_id"], item["access_token"],
                               None if full else item["cursor"], use_llm=use_llm)
            sync_liabilities(conn, api, item["access_token"])
            conn.execute(
                "INSERT INTO sync_log (item_id, started_at, finished_at, added, modified, removed)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (item["item_id"], started, _now(),
                 counts["added"], counts["modified"], counts["removed"]),
            )
            results.append({"institution": label, **counts})
        except plaid.ApiException as exc:
            message = str(exc)
            # The user changed a password or MFA expired; Link must be re-run.
            if "ITEM_LOGIN_REQUIRED" in message:
                conn.execute(
                    "UPDATE items SET status = 'login_required' WHERE item_id = ?",
                    (item["item_id"],),
                )
            conn.execute(
                "INSERT INTO sync_log (item_id, started_at, finished_at, error)"
                " VALUES (?, ?, ?, ?)",
                (item["item_id"], started, _now(), message[:500]),
            )
            results.append({"institution": label, "error": message[:200]})
    return results
