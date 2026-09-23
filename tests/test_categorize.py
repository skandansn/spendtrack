"""Rule coverage over real-world card descriptors.

Run: python -m unittest discover -s tests -v
"""

import json
import os
import sqlite3
import unittest
from unittest import mock

import httpx

from spendtrack.categorize import Categorizer, Rules, merchant_key

# (raw descriptor, expected category or None when it should fall through to the LLM)
CASES = [
    ("SQ *BLUE BOTTLE COFFE #412 SAN FRANCISCO CA", "Coffee"),
    ("TST* SWEETGREEN - BACK BAY  BOSTON MA", "Restaurants"),
    ("AMZN Mktp US*2X4KJ9L03", "Shopping"),
    ("UBER   *EATS 8005928996 CA", "Restaurants"),
    ("UBER *TRIP HELP.UBER.COM", "Transport"),
    ("TRADER JOE'S #512 BOSTON MA", "Groceries"),
    ("STARBUCKS STORE 08842", "Coffee"),
    ("MBTA CHARLIECARD 617-222-3200", "Transport"),
    ("CHASE CREDIT CRD AUTOPAY 12/03", "Transfer"),
    ("PAYMENT THANK YOU-MOBILE", "Transfer"),
    ("NORTHEASTERN UNIV TUITION", "Education"),
    ("SHELL OIL 57445267109", "Fuel"),
    ("CVS/PHARMACY #10334", "Health"),
    ("NETFLIX.COM 8667162598 CA", "Subscriptions"),
    ("APPLE.COM/BILL 866-712-7753", "Subscriptions"),
    ("VENMO PAYMENT 1039485726", "Transfer"),
    ("DIRECT DEP PAYROLL ACME CORP", "Income"),
    ("ZELLE TO JOHN SMITH", "Transfer"),
    ("T-MOBILE POSTPAID 800-937-8997", "Utilities"),
    ("PLANET FITNESS CLUB 4432", "Fitness"),
    ("DELTA AIR LINES 0062374839201", "Travel"),
    ("WHOLE FOODS MKT #10259", "Groceries"),
    ("SPOTIFY USA 877-778-1161 NY", "Subscriptions"),
    ("GOKARTZ RACEWAY LLC 02/14", "Entertainment"),
    # Descriptors seen coming out of Plaid Sandbox
    ("CREDIT CARD 3333 PAYMENT *//", "Transfer"),
    ("AUTOMATIC PAYMENT - THANK YOU", "Transfer"),
    ("Uber 063015 SF**POOL**", "Transport"),
    ("DEBIT CARD PURCHASE WALMART", "Shopping"),
]

# Substring collisions that used to misfire before \b was added.
COLLISIONS = [
    ("PAYMENT THANK YOU MOBILE", "Fuel"),      # MOBIL inside MOBILE
    ("CVS PHARMACY", "Shopping"),              # MACY inside PHARMACY
]


class TestMerchantKey(unittest.TestCase):
    def test_processor_prefix_and_store_number_collapse(self):
        keys = {
            merchant_key("SQ *BLUE BOTTLE #412 SAN FRANCISCO CA"),
            merchant_key("SQ *BLUE BOTTLE #77"),
        }
        self.assertEqual(len(keys), 1, f"variants did not collapse: {keys}")

    def test_asterisk_becomes_separator(self):
        self.assertEqual(merchant_key("UBER   *EATS 800555"), merchant_key("UBER EATS"))

    def test_dot_survives_for_domains(self):
        self.assertIn("NETFLIX.COM", merchant_key("NETFLIX.COM 8667162598 CA"))

    def test_empty_descriptor(self):
        self.assertEqual(merchant_key(None), "UNKNOWN")
        self.assertEqual(merchant_key("   "), "UNKNOWN")

    def test_merchant_name_preferred_over_raw_name(self):
        self.assertEqual(merchant_key("SQ *TJ #9 BOSTON MA", "Trader Joe's"), "TRADER JOE S")

    def test_prefix_strip_requires_a_separator(self):
        """A bare processor code must not be shaved off a longer word."""
        for raw, intact in [
            ("SPOTIFY USA", "SPOTIFY"),
            ("POSITANO RISTORANTE", "POSITANO"),
            ("PPG PAINTS ARENA", "PPG"),
            ("ICELANDAIR", "ICELANDAIR"),
            ("WLMART SUPERCENTER", "WLMART"),
        ]:
            with self.subTest(raw=raw):
                self.assertTrue(
                    merchant_key(raw).startswith(intact),
                    f"{raw!r} normalised to {merchant_key(raw)!r}",
                )

    def test_prefix_strip_still_removes_real_processor_codes(self):
        self.assertTrue(merchant_key("SQ *BLUE BOTTLE").startswith("BLUE BOTTLE"))
        self.assertTrue(merchant_key("TST* SWEETGREEN").startswith("SWEETGREEN"))
        self.assertTrue(merchant_key("PAYPAL *STEAM GAMES").startswith("STEAM GAMES"))

    def test_reference_number_is_excised_not_truncated_to(self):
        """Cutting the tail at a digit run collapsed 'CREDIT CARD 3333 PAYMENT'
        to 'CARD' and lost the word the Transfer rule keys on."""
        self.assertEqual(merchant_key("CREDIT CARD 3333 PAYMENT *//"), "CREDIT CARD PAYMENT")
        self.assertEqual(merchant_key("SHELL OIL 57445267109"), "SHELL OIL")

    def test_trailing_state_is_dropped(self):
        self.assertEqual(merchant_key("NETFLIX.COM 8667162598 CA"), "NETFLIX.COM")


class TestRules(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rules = Rules()

    def test_every_rule_category_is_in_the_taxonomy(self):
        taxonomy = set(self.rules.categories)
        for _, category in self.rules._compiled:
            self.assertIn(category, taxonomy)

    def test_descriptors_map_to_expected_category(self):
        for raw, expected in CASES:
            with self.subTest(raw=raw):
                self.assertEqual(self.rules.match(merchant_key(raw)), expected)

    def test_raw_descriptor_is_matched_when_the_key_alone_is_not(self):
        """Plaid cleans 'GglPay TST* T.I.T.T.MIAMI' down to 'I.t.t', dropping the
        TST* Toast-terminal marker. The raw text still carries it."""
        key, raw = merchant_key("GglPay TST* T.I.T.T.MIAMI", "I.t.t"), "GGLPAY TST* T.I.T.T.MIAMI"
        self.assertIsNone(self.rules.match(key), "key alone should not match")
        self.assertEqual(self.rules.match(key, raw), "Restaurants")

    def test_key_match_outranks_raw_match(self):
        """A confident key match must not be overridden by noise in the raw text."""
        self.assertEqual(
            self.rules.match("STARBUCKS STORE", "SQ *STARBUCKS INSIDE SAFEWAY"), "Coffee")

    def test_raw_is_optional(self):
        self.assertEqual(self.rules.match("CHIPOTLE", None), "Restaurants")

    def test_substring_collisions_do_not_misfire(self):
        for raw, wrong in COLLISIONS:
            with self.subTest(raw=raw):
                self.assertNotEqual(self.rules.match(merchant_key(raw)), wrong)

    def test_reload_picks_up_a_changed_file(self):
        before = self.rules._mtime
        self.rules.reload()
        self.assertEqual(self.rules._mtime, before, "reload refetched an unchanged file")

    def test_every_category_is_described(self):
        """Laya picks between the descriptions, so a missing one degrades it to
        guessing from the bare label."""
        self.assertEqual(set(self.rules.descriptions), set(self.rules.categories))


class TestBackend(unittest.TestCase):
    def _categorizer(self, backend: str) -> Categorizer:
        with mock.patch.dict(os.environ, {"CATEGORIZER": backend}):
            return Categorizer(sqlite3.connect(":memory:"))

    def test_unknown_backend_is_rejected(self):
        with self.assertRaises(ValueError):
            self._categorizer("gpt")

    def test_none_never_asks_a_model(self):
        cat = self._categorizer("none")
        cat._lookup_tables = lambda: ({}, {})
        with mock.patch.object(cat, "_ask_llm") as ask:
            rows = cat.resolve([{"merchant_key": "ZZ UNKNOWN SHOP", "plaid_category": "TRAVEL"}])
        ask.assert_not_called()
        self.assertEqual((rows[0]["category"], rows[0]["category_source"]), ("Travel", "plaid"))

    def test_laya_drops_low_confidence_answers(self):
        cat = self._categorizer("laya")
        confidence = {"BLUE BOTTLE": 0.93, "FIRST CL": 0.31}
        sent = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            sent.append(body["state"])
            key = next(k for k in confidence if k in body["state"]["body"])
            return httpx.Response(200, json={"answers": {"category": {
                "choice": "Coffee", "confidence": confidence[key]}}})

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            got = cat._request_laya(client, list(confidence), set(cat.rules.categories),
                                    {"FIRST CL": "FIRST CL 0042 BOSTON MA"})
        self.assertEqual(got, {"BLUE BOTTLE": "Coffee"})
        self.assertIn("FIRST CL 0042 BOSTON MA", sent[1]["body"])


if __name__ == "__main__":
    unittest.main()
