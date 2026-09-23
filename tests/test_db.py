"""Connection handling.

Both of the 500s that shipped in this project were the same mistake: a
sqlite3 connection opened on one thread and used on another. The API serves
from a threadpool and `spendtrack link` runs uvicorn on a side thread, so
anything that captures a connection in a closure is a latent crash.
"""

import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

from spendtrack import db


class TestConnectionThreadAffinity(unittest.TestCase):
    def setUp(self):
        self._original = db.DB_PATH
        db.DB_PATH = Path(tempfile.mkdtemp()) / "threads.db"
        db._local = threading.local()

    def tearDown(self):
        db.DB_PATH = self._original
        db._local = threading.local()

    def test_each_thread_gets_a_usable_connection(self):
        db.init()  # main thread, creates the schema
        errors: list[Exception] = []

        def worker(i: int) -> None:
            try:
                conn = db.init()
                conn.execute(
                    "INSERT INTO items (item_id, access_token) VALUES (?, ?)",
                    (f"item_{i}", "token"),
                )
            except Exception as exc:  # noqa: BLE001 - recording it is the point
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(errors, [], f"writes failed across threads: {errors}")
        self.assertEqual(
            db.init().execute("SELECT COUNT(*) AS n FROM items").fetchone()["n"], 8
        )

    def test_a_captured_connection_still_fails(self):
        """Documents the trap: this is what a closure-captured conn does, and
        why handlers must call db.init() rather than close over one."""
        captured = db.init()
        failure: list[Exception] = []

        def worker() -> None:
            try:
                captured.execute("SELECT 1")
            except sqlite3.ProgrammingError as exc:
                failure.append(exc)

        t = threading.Thread(target=worker)
        t.start()
        t.join()
        self.assertEqual(len(failure), 1)
        self.assertIn("same thread", str(failure[0]))

    def test_init_is_idempotent_on_one_thread(self):
        self.assertIs(db.init(), db.init())


if __name__ == "__main__":
    unittest.main()
