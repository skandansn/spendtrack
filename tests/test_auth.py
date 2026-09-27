"""The security boundary for a public deployment.

Kept deliberately small but present: everywhere else in this project a bug shows
you a wrong number, here a bug shows a stranger your bank accounts.
"""

import os
import tempfile
import threading
import unittest
from pathlib import Path

from spendtrack import auth, db


class AuthTest(unittest.TestCase):
    def setUp(self):
        self._original = db.DB_PATH
        db.DB_PATH = Path(tempfile.mkdtemp()) / "auth.db"
        db._local = threading.local()
        self.conn = db.init()

    def tearDown(self):
        db.DB_PATH = self._original
        db._local = threading.local()

    def test_password_round_trip(self):
        auth.set_password(self.conn, "a-long-enough-passphrase")
        self.assertTrue(auth.check_password(self.conn, "a-long-enough-passphrase"))
        self.assertFalse(auth.check_password(self.conn, "a-long-enough-passphras"))
        self.assertFalse(auth.check_password(self.conn, ""))

    def test_short_passwords_are_refused(self):
        with self.assertRaises(ValueError):
            auth.set_password(self.conn, "short")

    def test_no_password_means_no_check_passes(self):
        self.assertFalse(auth.has_password(self.conn))
        self.assertFalse(auth.check_password(self.conn, "anything"))

    def test_hash_is_salted(self):
        """Two installs with the same password must not share a hash."""
        auth.set_password(self.conn, "the-same-passphrase")
        first = self.conn.execute(
            "SELECT value FROM settings WHERE key='password'").fetchone()["value"]
        auth.set_password(self.conn, "the-same-passphrase")
        second = self.conn.execute(
            "SELECT value FROM settings WHERE key='password'").fetchone()["value"]
        self.assertNotEqual(first, second)

    def test_session_token_validates(self):
        auth.set_password(self.conn, "a-long-enough-passphrase")
        token = auth.issue(self.conn)
        self.assertTrue(auth.valid(self.conn, token))

    def test_tampered_tokens_are_rejected(self):
        auth.set_password(self.conn, "a-long-enough-passphrase")
        token = auth.issue(self.conn)
        body, _, signature = token.partition(".")
        for bad in (
            None, "", "nonsense", body, f"{body}.",
            f"x{body[1:]}.{signature}",                 # body edited
            f"{body}.{'A' * len(signature)}",           # signature replaced
            f"{body}.{signature[:-1]}",                 # signature truncated
        ):
            with self.subTest(token=bad):
                self.assertFalse(auth.valid(self.conn, bad))

    def test_expired_token_is_rejected(self):
        auth.set_password(self.conn, "a-long-enough-passphrase")
        original = auth.SESSION_DAYS
        try:
            auth.SESSION_DAYS = -1          # issue one that expired yesterday
            expired = auth.issue(self.conn)
        finally:
            auth.SESSION_DAYS = original
        self.assertFalse(auth.valid(self.conn, expired))

    def test_changing_password_invalidates_sessions(self):
        auth.set_password(self.conn, "the-first-passphrase")
        token = auth.issue(self.conn)
        auth.set_password(self.conn, "the-second-passphrase")
        self.assertFalse(auth.valid(self.conn, token))

    def test_lockout_after_repeated_failures(self):
        auth.set_password(self.conn, "a-long-enough-passphrase")
        self.assertEqual(auth.locked_for(self.conn), 0)
        for _ in range(auth.MAX_FAILURES):
            auth.record_failure(self.conn)
        self.assertGreater(auth.locked_for(self.conn), 0)
        auth.clear_failures(self.conn)
        self.assertEqual(auth.locked_for(self.conn), 0)


if __name__ == "__main__":
    unittest.main()
