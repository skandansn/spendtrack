"""Dashboard endpoints whose logic is more than a SELECT.

Run: python -m unittest discover -s tests -v
"""

import tempfile
import threading
import unittest
from datetime import date, timedelta
from pathlib import Path

from spendtrack import api, db


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        self._original = db.DB_PATH
        db.DB_PATH = Path(tempfile.mkdtemp()) / "api.db"
        db._local = threading.local()
        self.conn = db.init()
        self.conn.execute("INSERT INTO items (item_id, access_token) VALUES ('i', 't')")
        self.conn.execute("INSERT INTO accounts (account_id, item_id) VALUES ('a', 'i')")
        self._n = 0

    def tearDown(self):
        db.DB_PATH = self._original
        db._local = threading.local()

    def txn(self, day: date, merchant: str, amount: float, category: str = "Shopping") -> None:
        self._n += 1
        self.conn.execute(
            "INSERT INTO transactions (txn_id, account_id, date, merchant_key, amount,"
            " category, category_source) VALUES (?, 'a', ?, ?, ?, ?, 'rule')",
            (f"t{self._n}", day.isoformat(), merchant, amount, category),
        )


class TestShift(unittest.TestCase):
    def test_clamps_to_the_end_of_a_shorter_month(self):
        self.assertEqual(api._shift(date(2026, 3, 31), -1), date(2026, 2, 28))

    def test_crosses_year_boundaries(self):
        self.assertEqual(api._shift(date(2026, 1, 15), -1), date(2025, 12, 15))
        self.assertEqual(api._shift(date(2025, 12, 15), 13), date(2027, 1, 15))


class TestRecurring(ApiTestCase):
    def merchants(self) -> dict[str, dict]:
        return {r["merchant_key"]: r for r in api.recurring()["rows"]}

    def test_steady_monthly_charge_is_found(self):
        last = date.today() - timedelta(days=5)
        for i in range(4):
            self.txn(api._shift(last, -i), "NETFLIX", 15.49, "Subscriptions")
        found = self.merchants()["NETFLIX"]
        self.assertEqual((found["cadence"], found["amount"]), ("monthly", 15.49))

    def test_irregular_visits_are_not_a_subscription(self):
        day = date.today()
        for gap, amount in [(3, 12.0), (21, 30.0), (5, 8.0), (30, 14.0), (2, 25.0)]:
            day -= timedelta(days=gap)
            self.txn(day, "CAFE", amount, "Coffee")
        self.assertNotIn("CAFE", self.merchants())

    def test_varying_amount_is_rejected(self):
        last = date.today() - timedelta(days=3)
        for i, amount in enumerate([40.0, 95.0, 41.0, 120.0]):
            self.txn(api._shift(last, -i), "ELECTRIC", amount, "Utilities")
        self.assertNotIn("ELECTRIC", self.merchants())

    def test_two_yearly_charges_are_enough(self):
        last = date.today() - timedelta(days=20)
        self.txn(last, "DOMAIN", 12.0)
        self.txn(api._shift(last, -12), "DOMAIN", 12.0)
        found = self.merchants()["DOMAIN"]
        self.assertEqual(found["cadence"], "yearly")
        self.assertEqual(found["monthly"], 1.0)

    def test_two_monthly_charges_are_not(self):
        last = date.today() - timedelta(days=4)
        self.txn(last, "TRIAL", 9.99)
        self.txn(api._shift(last, -1), "TRIAL", 9.99)
        self.assertNotIn("TRIAL", self.merchants())

    def test_stopped_charges_drop_out(self):
        last = api._shift(date.today(), -3)
        for i in range(4):
            self.txn(api._shift(last, -i), "OLD GYM", 30.0, "Fitness")
        self.assertNotIn("OLD GYM", self.merchants())


class TestBudgets(ApiTestCase):
    def test_set_report_and_remove(self):
        self.txn(date.today().replace(day=1), "CHIPOTLE", 42.5, "Restaurants")
        api.set_budget("Restaurants", {"monthly": "300"})
        rows = api.budgets()["rows"]
        self.assertEqual(rows, [{"category": "Restaurants", "monthly": 300.0, "spent": 42.5}])
        api.set_budget("Restaurants", {"monthly": ""})
        self.assertEqual(api.budgets()["rows"], [])

    def test_unknown_category_is_rejected(self):
        with self.assertRaises(api.HTTPException):
            api.set_budget("Yachts", {"monthly": 10})


class TestCashback(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.day = date.today().replace(day=1)
        self.txn(self.day, "NORDVPN", 599.76, "Subscriptions")   # t1
        self.txn(self.day, "TARGET", 80.0)                        # t2

    def spend(self) -> float:
        return api.summary(months=1, account_id=None, category=None, q=None)["spend_this_month"]

    def test_percent_nets_out_of_every_total(self):
        api.set_cashback("t1", {"percent": 100, "payout": "amex_mr"})
        self.assertAlmostEqual(self.spend(), 80.0)
        by_cat = {r["category"] for r in api.spend_by_category(months=1, account_id=None, q=None)}
        self.assertNotIn("Subscriptions", by_cat, "fully refunded category should drop out")

    def test_flat_amount(self):
        got = api.set_cashback("t2", {"amount": 8, "payout": "paypal"})
        self.assertEqual(got["net"], 72.0)
        self.assertAlmostEqual(self.spend(), 599.76 + 72.0)

    def test_more_than_was_spent_is_rejected(self):
        with self.assertRaises(api.HTTPException):
            api.set_cashback("t2", {"percent": 150, "payout": "paypal"})

    def test_unknown_payout_is_rejected(self):
        with self.assertRaises(api.HTTPException):
            api.set_cashback("t2", {"percent": 10, "payout": "venmo"})

    def test_pending_counts_points_until_received(self):
        api.set_cashback("t1", {"percent": 100, "payout": "amex_mr"})
        api.set_cashback("t2", {"amount": 8, "payout": "paypal"})
        owed = api.cashback_pending()
        self.assertEqual(owed["total"], 607.76)
        self.assertEqual(owed["points"], {"amex_mr": 59976})
        api.set_cashback("t1", {"percent": 100, "payout": "amex_mr", "received": True})
        self.assertEqual(api.cashback_pending()["total"], 8.0)
        # received still counts against spend - it was always a saving
        self.assertAlmostEqual(self.spend(), 72.0)

    def test_clearing_restores_full_spend(self):
        api.set_cashback("t1", {"percent": 100, "payout": "bilt"})
        api.clear_cashback("t1")
        self.assertAlmostEqual(self.spend(), 679.76)

    def test_mark_follows_a_pending_charge_to_its_posted_row(self):
        from spendtrack.plaid_sync import carry_marks
        api.set_cashback("t2", {"percent": 10, "payout": "paypal", "source": "TopCashback"})
        self.txn(self.day, "TARGET", 95.0)          # t3: posted, with a tip
        carry_marks(self.conn, [("t2", "t3")])
        row = self.conn.execute(
            "SELECT cashback, cashback_source FROM transactions WHERE txn_id = 't3'").fetchone()
        self.assertEqual((row["cashback"], row["cashback_source"]), (9.5, "TopCashback"))


class TestZelleAndIncome(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.day = date.today().replace(day=1)
        self.conn.execute("UPDATE accounts SET type = 'depository'")
        for merchant, amount, cat in [
            ("ZELLE TO JOHN SMITH", 60.0, "Transfer"),      # t1: dinner you covered
            ("ZELLE FROM JOHN SMITH", -30.0, "Transfer"),   # t2: his half back
            ("ZELLE TO JOHN SMITH", 800.0, "Transfer"),     # t3: rent, another week
            ("ACME PAYROLL", -3000.0, "Income"),            # t4
            ("CHIPOTLE", 40.0, "Restaurants"),              # t5
        ]:
            self.txn(self.day, merchant, amount, cat)
        self.conn.execute("UPDATE transactions SET is_transfer = 1 WHERE category = 'Transfer'")

    def summary(self) -> dict:
        return api.summary(months=1, account_id=None, category=None, q=None)

    def test_unsorted_zelle_is_listed_and_excluded_from_spend(self):
        self.assertEqual({r["txn_id"] for r in api.p2p(months=1, limit=50)}, {"t1", "t2", "t3"})
        self.assertAlmostEqual(self.summary()["spend_this_month"], 40.0)

    def test_sorting_one_payment_leaves_the_rest_of_that_person_alone(self):
        api.set_category("t1", {"category": "Restaurants", "scope": "one"})
        api.set_category("t2", {"category": "Restaurants", "scope": "one"})
        # 40 chipotle + 60 dinner - 30 paid back
        self.assertAlmostEqual(self.summary()["spend_this_month"], 70.0)
        self.assertEqual({r["txn_id"] for r in api.p2p(months=1, limit=50)}, {"t3"})

    def test_merchant_wide_change_does_not_overwrite_a_one_off(self):
        api.set_category("t1", {"category": "Restaurants", "scope": "one"})
        api.set_category("t3", {"category": "Rent"})
        cats = dict(self.conn.execute(
            "SELECT txn_id, category FROM transactions WHERE txn_id IN ('t1', 't3')").fetchall())
        self.assertEqual(cats, {"t1": "Restaurants", "t3": "Rent"})

    def test_one_off_survives_a_resync(self):
        from spendtrack.plaid_sync import _UPSERT_TXN
        api.set_category("t1", {"category": "Restaurants", "scope": "one"})
        self.conn.execute(_UPSERT_TXN, {
            "txn_id": "t1", "account_id": "a", "date": self.day.isoformat(), "name": "ZELLE",
            "merchant_name": None, "merchant_key": "ZELLE TO JOHN SMITH", "amount": 60.0,
            "iso_currency": "USD", "pending": 0, "plaid_category": "TRANSFER_OUT",
            "logo_url": None, "category": "Transfer", "category_source": "rule",
            "is_transfer": 1, "updated_at": "now",
        })
        row = self.conn.execute(
            "SELECT category, category_source FROM transactions WHERE txn_id = 't1'").fetchone()
        self.assertEqual(tuple(row), ("Restaurants", "manual"))

    def test_income_and_bank_flag(self):
        s = self.summary()
        self.assertTrue(s["has_bank"])
        self.assertEqual(s["income_this_month"], 3000.0)

    def test_income_follows_the_period(self):
        earlier = api._shift(self.day, -2)
        self.txn(earlier, "ACME PAYROLL", -3000.0, "Income")
        wide = api.summary(months=6, account_id=None, category=None, q=None)
        self.assertEqual(wide["income_window"], 6000.0)
        past = api.summary(months=6, account_id=None, category=None, q=None,
                           start_date=earlier, end_date=earlier)
        self.assertEqual(past["income_window"], 3000.0)
        # the calendar-month tiles ignore a range that ends before this month
        self.assertEqual(past["income_this_month"], 3000.0)
        self.assertAlmostEqual(past["spend_this_month"], 40.0)

    def test_bad_scope_is_rejected(self):
        with self.assertRaises(api.HTTPException):
            api.set_category("t1", {"category": "Rent", "scope": "everything"})


class TestCustomRange(ApiTestCase):
    def test_range_replaces_months(self):
        self.assertEqual(api._window(6, date(2026, 1, 5), date(2026, 2, 10)),
                         ("2026-01-05", "2026-02-10"))

    def test_open_ended_range_runs_to_today(self):
        self.assertEqual(api._window(6, date(2026, 1, 5))[1], date.today().isoformat())

    def test_backwards_range_is_rejected(self):
        with self.assertRaises(api.HTTPException):
            api._window(6, date(2026, 3, 1), date(2026, 2, 1))

    def test_compares_to_the_same_number_of_days_before(self):
        self.txn(date(2026, 3, 10), "IN RANGE", 100.0)
        self.txn(date(2026, 2, 25), "DAY BEFORE", 40.0)     # inside the 10 days before
        self.txn(date(2026, 2, 18), "TOO EARLY", 999.0)     # outside them
        s = api.summary(months=6, account_id=None, category=None, q=None,
                        start_date=date(2026, 3, 1), end_date=date(2026, 3, 10))
        self.assertEqual((s["spend_window"], s["spend_prev_window"]), (100.0, 40.0))
        self.assertTrue(s["window"]["custom"])

    def test_transactions_honour_the_range(self):
        self.txn(date(2026, 3, 10), "IN", 1.0)
        self.txn(date(2026, 4, 10), "OUT", 1.0)
        got = api.transactions(months=6, category=None, account_id=None, q=None,
                               include_transfers=False, sort="date", desc=True, limit=50,
                               offset=0, start_date=date(2026, 3, 1), end_date=date(2026, 3, 31))
        self.assertEqual([r["merchant_key"] for r in got["rows"]], ["IN"])


class TestSummary(ApiTestCase):
    def test_this_month_is_compared_to_the_same_span_of_last_month(self):
        today = date.today()
        self.txn(api._shift(today, -1), "A", 100.0)          # counts: same day last month
        if today.day < 28:
            self.txn(api._shift(today, -1) + timedelta(days=1), "B", 900.0)  # after it: excluded
        s = api.summary(months=6, account_id=None, category=None, q=None)
        self.assertEqual(s["spend_last_month_to_date"], 100.0)
        self.assertEqual(len(s["trend"]), 12)
        self.assertEqual(s["trend"][-1]["month"], today.isoformat()[:7])


if __name__ == "__main__":
    unittest.main()
