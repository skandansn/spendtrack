"""Single-user authentication for a publicly reachable deployment.

The dashboard was written for a tailnet, where the network was the boundary and
no login existed. On a public address that boundary is gone, so this file is it.

Everything here is standard library on purpose - no new dependency sits on the
security path:

  password   scrypt with a per-install random salt (RFC 7914 parameters)
  session    an HMAC-SHA256 signed token, verified in constant time
  storage    a settings table in the same SQLite database

The threat being defended against is someone finding the host and trying
passwords, so: slow hashing, signed opaque cookies, and a lockout after
repeated failures.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time

# scrypt cost. n=2**15 keeps a single verification around 100ms on a small VM -
# slow enough to make guessing expensive, fast enough that login feels instant.
SCRYPT_N = 1 << 15
SCRYPT_R = 8
SCRYPT_P = 1
SALT_BYTES = 16
KEY_BYTES = 32
# 128 * N * r is exactly 32 MiB at these parameters, which is OpenSSL's default
# ceiling, so it refuses without an explicit higher limit. Not a cost factor -
# just permission to use the memory the cost factor implies.
SCRYPT_MAXMEM = 96 * 1024 * 1024

SESSION_DAYS = 30
MAX_FAILURES = 8
LOCKOUT_SECONDS = 15 * 60


def _get(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def _put(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


# --- password ----------------------------------------------------------------

def set_password(conn: sqlite3.Connection, password: str) -> None:
    if len(password) < 10:
        raise ValueError("password must be at least 10 characters")
    salt = os.urandom(SALT_BYTES)
    key = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R,
                         p=SCRYPT_P, dklen=KEY_BYTES, maxmem=SCRYPT_MAXMEM)
    _put(conn, "password", f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}$"
                           f"{base64.b64encode(salt).decode()}${base64.b64encode(key).decode()}")
    # Changing the password invalidates every existing session, which is the
    # only way "log out everywhere" can work without a session table.
    _put(conn, "session_key", secrets.token_hex(32))
    conn.execute("DELETE FROM settings WHERE key = 'failures'")


def has_password(conn: sqlite3.Connection) -> bool:
    return _get(conn, "password") is not None


def check_password(conn: sqlite3.Connection, password: str) -> bool:
    stored = _get(conn, "password")
    if not stored:
        return False
    try:
        scheme, n, r, p, salt_b64, key_b64 = stored.split("$")
        if scheme != "scrypt":
            return False
        candidate = hashlib.scrypt(
            password.encode(), salt=base64.b64decode(salt_b64),
            n=int(n), r=int(r), p=int(p), dklen=len(base64.b64decode(key_b64)),
            maxmem=SCRYPT_MAXMEM)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(candidate, base64.b64decode(key_b64))


# --- lockout -----------------------------------------------------------------

def locked_for(conn: sqlite3.Connection) -> int:
    """Seconds remaining before another attempt is allowed, 0 if unlocked."""
    raw = _get(conn, "failures")
    if not raw:
        return 0
    try:
        count, last = json.loads(raw)
    except (ValueError, TypeError):
        return 0
    if count < MAX_FAILURES:
        return 0
    return max(0, int(last + LOCKOUT_SECONDS - time.time()))


def record_failure(conn: sqlite3.Connection) -> None:
    raw = _get(conn, "failures")
    count = 0
    if raw:
        try:
            count, _ = json.loads(raw)
        except (ValueError, TypeError):
            count = 0
    _put(conn, "failures", json.dumps([count + 1, int(time.time())]))


def clear_failures(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM settings WHERE key = 'failures'")


# --- session -----------------------------------------------------------------

def _session_key(conn: sqlite3.Connection) -> bytes:
    key = _get(conn, "session_key")
    if not key:
        key = secrets.token_hex(32)
        _put(conn, "session_key", key)
    return key.encode()


def issue(conn: sqlite3.Connection) -> str:
    """A signed opaque token. No server-side session store: the signature and
    the embedded expiry are the whole of it."""
    payload = json.dumps({"exp": int(time.time()) + SESSION_DAYS * 86400,
                          "jti": secrets.token_hex(8)}, separators=(",", ":")).encode()
    body = base64.urlsafe_b64encode(payload).rstrip(b"=")
    signature = hmac.new(_session_key(conn), body, hashlib.sha256).digest()
    return f"{body.decode()}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"


def valid(conn: sqlite3.Connection, token: str | None) -> bool:
    if not token or "." not in token:
        return False
    body, _, signature = token.partition(".")
    expected = hmac.new(_session_key(conn), body.encode(), hashlib.sha256).digest()
    given = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4)) \
        if _is_b64(signature) else b""
    # constant time, so a valid prefix cannot be found a character at a time
    if not hmac.compare_digest(expected, given):
        return False
    try:
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except (ValueError, TypeError):
        return False
    return int(payload.get("exp", 0)) > time.time()


def _is_b64(value: str) -> bool:
    try:
        base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        return True
    except (ValueError, TypeError):
        return False
