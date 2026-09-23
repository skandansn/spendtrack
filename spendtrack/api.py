"""Local dashboard. Binds to 127.0.0.1 only - nothing here is authenticated,
because nothing here is reachable off the machine."""

import base64
import calendar
import sqlite3
from datetime import date, timedelta
from pathlib import Path
from statistics import median
from typing import Annotated

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import db
from .categorize import Categorizer, Rules

WEB = Path(__file__).with_name("web")

app = FastAPI(title="spendtrack", docs_url=None, redoc_url=None)


def conn() -> sqlite3.Connection:
    return db.init()


def _rows(sql: str, params: tuple = ()) -> list[dict]:
    return [dict(r) for r in conn().execute(sql, params)]


# A custom range from the date pickers. When present it replaces `months`.
Start = Annotated[date | None, Query(alias="start")]
End = Annotated[date | None, Query(alias="end")]


def _window(months: int, start: date | None = None, end: date | None = None) -> tuple[str, str]:
    """Inclusive [start, end]: the custom range if one was picked, otherwise the
    last `months` calendar months. A custom range with no end runs to today."""
    today = date.today()
    if start:
        end = end or today
        if end < start:
            raise HTTPException(400, "end date is before start date")
        return start.isoformat(), end.isoformat()
    end = today.isoformat()
    start = (today.replace(day=1) - timedelta(days=31 * (months - 1))).replace(day=1)
    return start.isoformat(), end


def _shift(d: date, months: int) -> date:
    """Same day `months` away, clamped to the end of a shorter month."""
    y, m = divmod(d.year * 12 + d.month - 1 + months, 12)
    m += 1
    return d.replace(year=y, month=m, day=min(d.day, calendar.monthrange(y, m)[1]))


# Spend means money out that is not an internal transfer and not income.
#
# Refunds and statement credits arrive as negative amounts and are deliberately
# left in, so SUM nets them against the original charge - a $350 annual fee
# refunded the same day is $0 of spend, not $350. Excluding them instead (the
# obvious `amount > 0`) silently overstates every total.
#
# Cashback you marked (Rakuten and the like) is subtracted the same way, as
# `amount - cashback`: it pays out off-card - PayPal, Amex MR, Bilt - so it never
# arrives as a credit to net against.
SPEND = "is_transfer = 0 AND category != 'Income'"

# Payout programs, and whether Rakuten pays them in points (1 point per cent).
PAYOUTS = {"paypal": False, "amex_mr": True, "bilt": True}


def _scope(account_id: str | None = None, category: str | None = None,
           q: str | None = None) -> tuple[str, tuple]:
    """SQL fragment and params for the filter bar.

    Every panel honours whatever is set, so the totals on screen always describe
    the same slice of data. The one exception is the by-category chart, which
    skips the category filter - it is the control you pick the category with, so
    narrowing it to the single bar you just clicked would make it unusable.
    """
    sql, params = "", []
    if account_id:
        sql += " AND account_id = ?"
        params.append(account_id)
    if category:
        sql += " AND category = ?"
        params.append(category)
    if q:
        sql += " AND (name LIKE ? OR merchant_key LIKE ?)"
        params += [f"%{q}%", f"%{q}%"]
    return sql, tuple(params)


@app.get("/api/accounts")
def accounts() -> list[dict]:
    # the logo itself is served separately: it is ~20KB of base64 per bank and
    # this endpoint is fetched on every filter change
    return _rows("""
        SELECT a.*, i.institution_name, i.status AS item_status, i.last_synced_at,
               i.institution_color, COALESCE(i.institution_logo, '') != '' AS has_logo,
               c.last_statement_balance, c.next_payment_due_date,
               c.minimum_payment, c.apr_percentage, c.is_overdue
        FROM accounts a
        JOIN items i USING (item_id)
        LEFT JOIN card_details c USING (account_id)
        ORDER BY i.institution_name, a.type, a.name
    """)


@app.get("/api/summary")
def summary(months: int = Query(6, ge=1, le=60), account_id: str | None = None,
            category: str | None = None, q: str | None = None,
            start_date: Start = None, end_date: End = None) -> dict:
    start, end = _window(months, start_date, end_date)
    acct, acct_p = _scope(account_id, category, q)
    # balances belong to the account, not to a category or search term
    bal, bal_p = _scope(account_id)

    totals = _rows(f"""
        SELECT COALESCE(SUM(amount - cashback), 0) AS spend, COUNT(*) AS txns
        FROM transactions WHERE {SPEND} AND date BETWEEN ? AND ?{acct}
    """, (start, end) + acct_p)[0]

    today = date.today()
    this_month = today.replace(day=1)
    spend_between = f"""
        SELECT COALESCE(SUM(amount - cashback), 0) AS spend
        FROM transactions WHERE {SPEND} AND date BETWEEN ? AND ?{acct}
    """
    # "this month" is the calendar month whatever range is picked - a custom
    # range can end long before today
    current = _rows(spend_between, (this_month.isoformat(), today.isoformat()) + acct_p)[0]["spend"]
    # Compared to the same span a period earlier - 23 days of this month against
    # 23 days of last month, not against all 30 - or every month reads as a drop.
    last_mtd = _rows(spend_between, (_shift(this_month, -1).isoformat(),
                                     _shift(today, -1).isoformat()) + acct_p)[0]["spend"]
    # The period before: the same months a period back, or for a custom range
    # the same number of days ending the day before it starts.
    if start_date:
        days = (date.fromisoformat(end) - start_date).days + 1
        prev_span = (start_date - timedelta(days=days), start_date - timedelta(days=1))
    else:
        prev_span = (_shift(date.fromisoformat(start), -months), _shift(today, -months))
    prev_window = _rows(spend_between, tuple(d.isoformat() for d in prev_span) + acct_p)[0]["spend"]

    trend_start = _shift(this_month, -11)
    by_month = {r["month"]: r["spend"] for r in _rows(f"""
        SELECT substr(date, 1, 7) AS month, SUM(amount - cashback) AS spend
        FROM transactions WHERE {SPEND} AND date >= ?{acct} GROUP BY month
    """, (trend_start.isoformat(),) + acct_p)}
    trend_months = [_shift(trend_start, i).isoformat()[:7] for i in range(12)]

    balances = _rows(f"""
        SELECT COALESCE(SUM(CASE WHEN type = 'depository' THEN current_balance END), 0) AS cash,
               COALESCE(SUM(CASE WHEN type = 'credit'     THEN current_balance END), 0) AS card_debt
        FROM accounts {"WHERE " + bal[5:] if bal else ""}
    """, bal_p)[0]

    # Income ignores the category filter - it is its own category - but honours
    # the account and search. Inflows are negative in Plaid's convention.
    inc, inc_p = _scope(account_id, None, q)
    income_between = f"""
        SELECT COALESCE(-SUM(amount), 0) AS income FROM transactions
        WHERE category = 'Income' AND is_transfer = 0 AND date BETWEEN ? AND ?{inc}
    """
    income = _rows(income_between, (this_month.isoformat(), today.isoformat()) + inc_p)[0]["income"]
    income_window = _rows(income_between, (start, end) + inc_p)[0]["income"]
    income_prev_window = _rows(income_between,
                               tuple(d.isoformat() for d in prev_span) + inc_p)[0]["income"]
    # Cards alone carry no paycheck, only the odd reward credit filed as Income;
    # an income tile built from that would say you earn $0 and save nothing.
    has_bank = bool(_rows(
        "SELECT 1 FROM accounts WHERE type = 'depository' LIMIT 1"))

    uncategorized = _rows(f"""
        SELECT COUNT(*) AS n FROM transactions
        WHERE category_source = 'uncategorized' AND date BETWEEN ? AND ?{acct}
    """, (start, end) + acct_p)[0]["n"]

    return {
        "window": {"start": start, "end": end, "months": months, "custom": bool(start_date)},
        "spend_window": totals["spend"],
        "spend_this_month": current,
        "spend_last_month_to_date": last_mtd,
        "spend_prev_window": prev_window,
        "trend": [{"month": m, "spend": by_month.get(m, 0)} for m in trend_months],
        "has_bank": has_bank,
        "income_this_month": income,
        "income_window": income_window,
        "income_prev_window": income_prev_window,
        "txns": totals["txns"],
        "cash": balances["cash"],
        "card_debt": balances["card_debt"],
        "uncategorized": uncategorized,
        "last_sync": _rows(
            "SELECT MAX(finished_at) AS at FROM sync_log WHERE error IS NULL")[0]["at"],
    }


@app.get("/api/spend/by-category")
def spend_by_category(months: int = Query(6, ge=1, le=60),
                      account_id: str | None = None,
                      q: str | None = None,
                      start_date: Start = None, end_date: End = None) -> list[dict]:
    start, end = _window(months, start_date, end_date)
    acct, acct_p = _scope(account_id, None, q)
    return _rows(f"""
        SELECT category, SUM(amount - cashback) AS amount, COUNT(*) AS txns
        FROM transactions WHERE {SPEND} AND date BETWEEN ? AND ?{acct}
        GROUP BY category HAVING SUM(amount - cashback) > 0 ORDER BY amount DESC
    """, (start, end) + acct_p)


@app.get("/api/spend/by-month")
def spend_by_month(months: int = Query(6, ge=1, le=60),
                   account_id: str | None = None,
                   category: str | None = None, q: str | None = None,
                   start_date: Start = None, end_date: End = None) -> list[dict]:
    start, end = _window(months, start_date, end_date)
    acct, acct_p = _scope(account_id, category, q)
    return _rows(f"""
        SELECT substr(date, 1, 7) AS month, category, SUM(amount - cashback) AS amount
        FROM transactions WHERE {SPEND} AND date BETWEEN ? AND ?{acct}
        GROUP BY month, category HAVING SUM(amount - cashback) > 0 ORDER BY month, amount DESC
    """, (start, end) + acct_p)


@app.get("/api/spend/top-merchants")
def top_merchants(months: int = Query(6, ge=1, le=60),
                  account_id: str | None = None,
                  category: str | None = None, q: str | None = None,
                  limit: int = Query(15, ge=1, le=100),
                  start_date: Start = None, end_date: End = None) -> list[dict]:
    start, end = _window(months, start_date, end_date)
    acct, acct_p = _scope(account_id, category, q)
    return _rows(f"""
        SELECT merchant_key, category, SUM(amount - cashback) AS amount, COUNT(*) AS txns
        FROM transactions WHERE {SPEND} AND date BETWEEN ? AND ?{acct}
        GROUP BY merchant_key HAVING SUM(amount - cashback) > 0 ORDER BY amount DESC LIMIT ?
    """, (start, end) + acct_p + (limit,))


# Whitelist: the sort key never reaches SQL as text from the client.
SORTS = {
    "date": "t.date",
    "merchant": "COALESCE(t.merchant_name, t.merchant_key)",
    "account": "a.name",
    "category": "t.category",
    "amount": "t.amount",
}


@app.get("/api/transactions")
def transactions(
    months: int = Query(6, ge=1, le=60),
    category: str | None = None,
    account_id: str | None = None,
    q: str | None = None,
    include_transfers: bool = False,
    sort: str = Query("date"),
    desc: bool = True,
    limit: int = Query(200, ge=1, le=2000),
    offset: int = Query(0, ge=0),
    start_date: Start = None,
    end_date: End = None,
) -> dict:
    start, end = _window(months, start_date, end_date)
    where = ["t.date BETWEEN ? AND ?"]
    params: list = [start, end]
    if not include_transfers:
        where.append("t.is_transfer = 0")
    if category:
        where.append("t.category = ?")
        params.append(category)
    if account_id:
        where.append("t.account_id = ?")
        params.append(account_id)
    if q:
        where.append("(t.name LIKE ? OR t.merchant_key LIKE ?)")
        params += [f"%{q}%", f"%{q}%"]
    clause = " AND ".join(where)

    if sort not in SORTS:
        raise HTTPException(400, f"sort must be one of {sorted(SORTS)}")
    direction = "DESC" if desc else "ASC"
    # date breaks ties so paging stays stable across requests
    order = f"{SORTS[sort]} {direction}" + ("" if sort == "date" else f", t.date {direction}")

    total = _rows(f"SELECT COUNT(*) AS n FROM transactions t WHERE {clause}",
                  tuple(params))[0]["n"]
    rows = _rows(f"""
        SELECT t.*, a.name AS account_name, a.mask, a.type AS account_type
        FROM transactions t JOIN accounts a USING (account_id)
        WHERE {clause} ORDER BY {order} LIMIT ? OFFSET ?
    """, tuple(params) + (limit, offset))
    return {"total": total, "rows": rows}


@app.get("/api/categories")
def categories() -> list[str]:
    return Rules().categories


@app.post("/api/transactions/{txn_id}/category")
def set_category(txn_id: str, payload: dict = Body(...)) -> dict:
    """Recategorise.

    scope "merchant" (the default) stores the correction against the merchant,
    so it applies to that merchant's past and future transactions alike - except
    any you set one at a time, which are more specific and win.

    scope "one" changes this transaction alone. That is what a Zelle needs: the
    same person can be paid back for dinner one week and for rent the next.
    """
    category = payload.get("category")
    if category not in Rules().categories:
        raise HTTPException(400, f"unknown category {category!r}")
    scope = payload.get("scope", "merchant")
    if scope not in ("merchant", "one"):
        raise HTTPException(400, "scope must be 'merchant' or 'one'")

    row = conn().execute(
        "SELECT merchant_key FROM transactions WHERE txn_id = ?", (txn_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(404, "no such transaction")
    key = row["merchant_key"]

    is_transfer = int(category == "Transfer")
    if scope == "one":
        conn().execute(
            "UPDATE transactions SET category = ?, category_source = 'manual', is_transfer = ?"
            " WHERE txn_id = ?", (category, is_transfer, txn_id))
        return {"merchant_key": key, "category": category, "updated": 1}

    c = conn()
    c.execute("BEGIN")
    try:
        c.execute(
            "INSERT OR REPLACE INTO category_overrides (merchant_key, category) VALUES (?, ?)",
            (key, category),
        )
        cur = c.execute(
            "UPDATE transactions SET category = ?, category_source = 'override',"
            " is_transfer = ? WHERE merchant_key = ? AND category_source != 'manual'",
            (category, is_transfer, key),
        )
        c.execute("COMMIT")
    except Exception:
        c.execute("ROLLBACK")
        raise
    return {"merchant_key": key, "category": category, "updated": cur.rowcount}


@app.put("/api/transactions/{txn_id}/cashback")
def set_cashback(txn_id: str, payload: dict = Body(...)) -> dict:
    """Mark money coming back on a purchase: {"percent": 100} or {"amount": 25},
    plus payout, source and received. The percent is kept so the mark can be
    re-applied if the posted amount differs from the pending one."""
    row = conn().execute("SELECT amount FROM transactions WHERE txn_id = ?", (txn_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "no such transaction")
    if row["amount"] <= 0:
        raise HTTPException(400, "cashback only applies to a purchase, not a credit")
    payout = payload.get("payout")
    if payout not in PAYOUTS:
        raise HTTPException(400, f"payout must be one of {sorted(PAYOUTS)}")
    try:
        percent = float(payload["percent"]) if payload.get("percent") not in (None, "") else None
        amount = (round(row["amount"] * percent / 100, 2) if percent is not None
                  else float(payload.get("amount") or 0))
    except (TypeError, ValueError):
        raise HTTPException(400, "percent and amount must be numbers")
    if not 0 < amount <= row["amount"]:
        raise HTTPException(400, f"cashback must be between $0 and the ${row['amount']:.2f} spent")

    conn().execute(
        "UPDATE transactions SET cashback = ?, cashback_pct = ?, cashback_payout = ?,"
        " cashback_source = ?, cashback_received = ? WHERE txn_id = ?",
        (amount, percent, payout, (payload.get("source") or "Rakuten").strip(),
         int(bool(payload.get("received"))), txn_id),
    )
    return {"txn_id": txn_id, "cashback": amount, "net": round(row["amount"] - amount, 2)}


@app.delete("/api/transactions/{txn_id}/cashback")
def clear_cashback(txn_id: str) -> dict:
    conn().execute(
        "UPDATE transactions SET cashback = 0, cashback_pct = NULL, cashback_payout = NULL,"
        " cashback_source = NULL, cashback_received = 0 WHERE txn_id = ?", (txn_id,))
    return {"txn_id": txn_id}


@app.get("/api/cashback/pending")
def cashback_pending() -> dict:
    """Cashback marked but not yet paid out, oldest first - Rakuten pays
    quarterly, so the oldest are the ones to chase."""
    rows = _rows("""
        SELECT txn_id, date, COALESCE(merchant_name, merchant_key) AS merchant, logo_url,
               amount, cashback, cashback_pct, cashback_payout, cashback_source
        FROM transactions WHERE cashback > 0 AND cashback_received = 0
        ORDER BY date
    """)
    points: dict[str, int] = {}
    for r in rows:
        if PAYOUTS[r["cashback_payout"]]:
            points[r["cashback_payout"]] = points.get(r["cashback_payout"], 0) + round(r["cashback"] * 100)
    return {"total": round(sum(r["cashback"] for r in rows), 2), "points": points, "rows": rows}


# Person-to-person apps. The Transfer rule files every one of these as a
# transfer, which is right for moving your own money and wrong for paying a
# friend back or being paid back - so they get sorted by hand, one at a time.
P2P = ("ZELLE", "VENMO", "CASH APP", "CASHAPP", "SQUARE CASH", "APPLE CASH")
P2P_WHERE = "(" + " OR ".join(f"UPPER(COALESCE(t.name, t.merchant_key)) LIKE '%{w}%'"
                              for w in P2P) + ")"


@app.get("/api/p2p")
def p2p(months: int = Query(6, ge=1, le=60), limit: int = Query(50, ge=1, le=500),
        start_date: Start = None, end_date: End = None) -> list[dict]:
    """Zelle / Venmo / Cash App payments you have not sorted yet, newest first.
    Anything you categorised - for the person, or for that one payment - is done."""
    start, end = _window(months, start_date, end_date)
    return _rows(f"""
        SELECT t.txn_id, t.date, t.name, t.merchant_key, t.amount, t.category,
               a.name AS account_name, a.mask
        FROM transactions t JOIN accounts a USING (account_id)
        WHERE {P2P_WHERE} AND t.category_source NOT IN ('manual', 'override')
          AND t.date BETWEEN ? AND ?
        ORDER BY t.date DESC LIMIT ?
    """, (start, end, limit))


@app.get("/api/review")
def review(limit: int = Query(50, ge=1, le=500)) -> list[dict]:
    """Merchants whose category is only a fallback - Plaid's coarse guess, or
    nothing - because no rule matched and no model was confident. Biggest spend
    first. One answer per merchant settles every transaction it has."""
    return _rows("""
        SELECT merchant_key, MAX(name) AS name, MAX(merchant_name) AS merchant_name,
               MAX(logo_url) AS logo_url, category, category_source,
               COUNT(*) AS txns, SUM(amount) AS amount, MAX(date) AS last_date,
               MAX(txn_id) AS txn_id
        FROM transactions
        WHERE category_source IN ('uncategorized', 'plaid') AND is_transfer = 0
        GROUP BY merchant_key
        ORDER BY SUM(ABS(amount)) DESC
        LIMIT ?
    """, (limit,))


@app.get("/api/budgets")
def budgets() -> dict:
    """This month's spend against each budget. Budgets are monthly and cover
    every account, so the filter bar deliberately does not apply."""
    today = date.today()
    rows = _rows(f"""
        SELECT b.category, b.monthly, COALESCE(s.spent, 0) AS spent
        FROM budgets b LEFT JOIN (
            SELECT category, SUM(amount - cashback) AS spent FROM transactions
            WHERE {SPEND} AND date >= ? GROUP BY category
        ) s USING (category)
        ORDER BY b.monthly DESC
    """, (today.replace(day=1).isoformat(),))
    days = calendar.monthrange(today.year, today.month)[1]
    return {"month_progress": today.day / days, "rows": rows}


@app.put("/api/budgets/{category}")
def set_budget(category: str, payload: dict = Body(...)) -> dict:
    """A positive amount sets the budget; 0 or empty removes it."""
    if category not in Rules().categories:
        raise HTTPException(400, f"unknown category {category!r}")
    try:
        monthly = float(payload.get("monthly") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "monthly must be a number")
    if monthly > 0:
        conn().execute("INSERT OR REPLACE INTO budgets (category, monthly) VALUES (?, ?)",
                       (category, monthly))
    else:
        conn().execute("DELETE FROM budgets WHERE category = ?", (category,))
    return {"category": category, "monthly": monthly or None}


# (name, shortest and longest median gap in days, charges per month)
CADENCES = [("weekly", 5, 9, 52 / 12), ("monthly", 26, 35, 1.0), ("yearly", 350, 380, 1 / 12)]


@app.get("/api/recurring")
def recurring() -> dict:
    """Merchants charging a steady amount on a steady schedule, still active.

    Needs three or more charges - two for yearly, since three would take over two
    years to appear. The median gap picks the cadence, and the recent gaps and
    amounts must all sit near their medians - otherwise a coffee shop visited
    most weeks would pass as a weekly subscription.
    """
    today = date.today()
    by_merchant: dict[str, list] = {}
    for r in conn().execute(f"""
        SELECT merchant_key, merchant_name, logo_url, category, date, SUM(amount) AS amount
        FROM transactions
        WHERE {SPEND} AND amount > 0 AND date >= ?
        GROUP BY merchant_key, date
        ORDER BY merchant_key, date
    """, (_shift(today, -25).isoformat(),)):
        by_merchant.setdefault(r["merchant_key"], []).append(r)

    found = []
    for key, charges in by_merchant.items():
        if len(charges) < 2:
            continue
        dates = [date.fromisoformat(c["date"]) for c in charges]
        gaps = [(b - a).days for a, b in zip(dates, dates[1:])]
        gap = median(gaps)
        cadence = next((c for c in CADENCES if c[1] <= gap <= c[2]), None)
        if cadence is None or (len(charges) < 3 and cadence[0] != "yearly"):
            continue
        if any(abs(g - gap) > gap * 0.35 for g in gaps[-4:]):
            continue
        amounts = [c["amount"] for c in charges[-4:]]
        typical = median(amounts)
        if max(amounts) > typical * 1.25 or min(amounts) < typical * 0.75:
            continue
        if (today - dates[-1]).days > gap * 1.5:
            continue    # stopped: cancelled, or moved to another card
        latest = charges[-1]
        found.append({
            "merchant_key": key,
            "merchant_name": latest["merchant_name"],
            "logo_url": latest["logo_url"],
            "category": latest["category"],
            "cadence": cadence[0],
            "amount": round(typical, 2),
            "monthly": round(typical * cadence[3], 2),
            "last_date": dates[-1].isoformat(),
            "next_date": (dates[-1] + timedelta(days=round(gap))).isoformat(),
            "charges": len(charges),
        })
    found.sort(key=lambda r: r["next_date"])
    return {"monthly_total": round(sum(r["monthly"] for r in found), 2), "rows": found}


@app.get("/api/items/{item_id}/logo")
def institution_logo(item_id: str) -> Response:
    row = conn().execute(
        "SELECT institution_logo FROM items WHERE item_id = ?", (item_id,)).fetchone()
    if not row or not row["institution_logo"]:
        raise HTTPException(404, "no logo")
    return Response(base64.b64decode(row["institution_logo"]), media_type="image/png",
                    headers={"Cache-Control": "max-age=604800"})


@app.post("/api/recategorize")
def recategorize(use_llm: bool = True) -> dict:
    """Re-resolve everything. Cheap after a rules.toml edit: merchants already
    in the cache or matched by a rule never reach the LLM."""
    # name is not decoration: it is the raw statement text the LLM needs when
    # Plaid's merchant_name is a fragment ('WEA' for 'OURARING 8333630010')
    rows = _rows("SELECT txn_id, name, merchant_key, plaid_category FROM transactions")
    if not rows:
        return {"updated": 0}
    Categorizer(conn()).resolve(rows, use_llm=use_llm)
    c = conn()
    c.execute("BEGIN")
    try:
        c.executemany(
            "UPDATE transactions SET category = :category,"
            " category_source = :category_source, is_transfer = :is_transfer"
            " WHERE txn_id = :txn_id AND category_source NOT IN ('override', 'manual')",
            rows,
        )
        c.execute("COMMIT")
    except Exception:
        c.execute("ROLLBACK")
        raise
    return {"updated": len(rows)}


@app.post("/api/sync")
def sync(use_llm: bool = True) -> dict:
    from . import plaid_sync
    return {"results": plaid_sync.sync_all(conn(), plaid_sync.client(), use_llm=use_llm)}


# --- Plaid Link handshake ----------------------------------------------------

@app.get("/api/link/token")
def link_token() -> dict:
    from . import plaid_sync
    return {"link_token": plaid_sync.create_link_token(plaid_sync.client())}


@app.post("/api/link/exchange")
def link_exchange(payload: dict = Body(...)) -> dict:
    from . import plaid_sync
    public_token = payload.get("public_token")
    if not public_token:
        raise HTTPException(400, "public_token required")
    item_id = plaid_sync.exchange_public_token(conn(), plaid_sync.client(), public_token)
    return {"item_id": item_id}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB / "index.html")


@app.get("/sw.js")
def service_worker() -> FileResponse:
    """Served from the root deliberately: a service worker can only control
    pages at or below its own path, so one under /static/ could not cache "/"."""
    return FileResponse(WEB / "sw.js", media_type="application/javascript",
                        headers={"Service-Worker-Allowed": "/",
                                 "Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=WEB), name="static")
