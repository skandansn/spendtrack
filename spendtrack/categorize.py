"""Resolve a category for every transaction.

Precedence, highest first:
    0. category_source=manual  - you set this one transaction; nothing here runs
    1. category_overrides      - you corrected it by hand; never revisited
    2. rules.toml              - evaluated live, so editing the file takes effect at once
    3. merchant_category_cache - an LLM answer from some earlier run
    4. the LLM or Laya         - only merchants none of the above resolved;
                                 CATEGORIZER=llm|laya|none picks which, if any
    5. Plaid's own category    - mapped onto our taxonomy
    6. "Other"

Because 1-3 are keyed on the normalised merchant, a given merchant reaches the
LLM at most once in the life of the database.
"""

import json
import os
import re
import sqlite3
import tomllib
from pathlib import Path

import httpx

RULES_PATH = Path(__file__).with_name("rules.toml")
LLM_BATCH = 20
LLM_TIMEOUT = 180.0     # generation is slow on a 27B; be patient once connected
PROBE_TIMEOUT = 2.0     # but fail fast when nothing is listening at all
UNCATEGORIZED = "Other"
BACKENDS = ("llm", "laya", "none")

# Processor junk in front of the real merchant name. The separator is mandatory:
# these codes are short enough that an optional one strips 'SP' off 'SPOTIFY'.
# Code-style prefixes always carry an asterisk; word-style ones, whitespace.
# CREDIT/DEBIT are deliberately absent - they are part of the meaning in
# 'CREDIT CARD PAYMENT', not noise in front of it.
_PREFIX = re.compile(
    r"^(?:(?:SQ|TST|PAYPAL|PY|PP|SP|EIG|IC|WL|CKE)\s*\*+\s*"
    r"|(?:PURCHASE|POS)\s+)",
    re.I,
)
# Genuinely trailing noise - a store number, phone number or date and whatever
# follows it. Everything after the match is junk.
_TRAIL = re.compile(r"\s*(?:#\s*\d+|\b\d{3}-\d{3}-\d{4}\b|\b\d{2}/\d{2}\b).*$", re.I)
# A bare reference number is excised in place, not truncated to: cutting the
# tail turns 'CREDIT CARD 3333 PAYMENT' into 'CARD' and loses the word the
# Transfer rule keys on.
_REFNUM = re.compile(r"\b\d{4,}\b")
# A two-letter state at the very end, once punctuation is already spaces.
_STATE = re.compile(r"\s+[A-Z]{2}\s*$")
# '.' survives so NETFLIX.COM stays intact; '*' does not, because processors use
# it as a separator and 'UBER *EATS' must normalise to the same key as 'UBER EATS'.
_PUNCT = re.compile(r"[^A-Z0-9&. ]+")
_SPACE = re.compile(r"\s+")

# Plaid personal_finance_category primary -> our taxonomy.
PLAID_MAP = {
    "INCOME": "Income",
    "TRANSFER_IN": "Transfer",
    "TRANSFER_OUT": "Transfer",
    "LOAN_PAYMENTS": "Transfer",
    "BANK_FEES": "Fees",
    "ENTERTAINMENT": "Entertainment",
    "FOOD_AND_DRINK": "Restaurants",
    "GENERAL_MERCHANDISE": "Shopping",
    "HOME_IMPROVEMENT": "Shopping",
    "MEDICAL": "Health",
    "PERSONAL_CARE": "Personal Care",
    "GENERAL_SERVICES": "Other",
    "GOVERNMENT_AND_NON_PROFIT": "Other",
    "TRANSPORTATION": "Transport",
    "TRAVEL": "Travel",
    "RENT_AND_UTILITIES": "Utilities",
}

TRANSFER_CATEGORIES = {"Transfer"}


def merchant_key(name: str | None, merchant_name: str | None = None) -> str:
    """Collapse a raw descriptor to a stable key. 'SQ *BLUE BOTTLE #412 SAN
    FRANCISCO CA' and 'SQ *BLUE BOTTLE #77' both land on 'BLUE BOTTLE'."""
    raw = (merchant_name or name or "").upper().strip()
    if not raw:
        return "UNKNOWN"
    raw = _PREFIX.sub("", raw)
    raw = _TRAIL.sub("", raw)
    raw = _REFNUM.sub(" ", raw)
    raw = _PUNCT.sub(" ", raw)
    raw = _SPACE.sub(" ", raw).strip()
    raw = _STATE.sub("", raw)
    return raw or "UNKNOWN"


class Rules:
    """Compiled rules.toml, reloaded when the file changes on disk."""

    def __init__(self, path: Path = RULES_PATH):
        self.path = path
        self._mtime = -1.0
        self.categories: list[str] = []
        self._compiled: list[tuple[re.Pattern[str], str]] = []
        self.reload()

    def reload(self) -> None:
        mtime = self.path.stat().st_mtime
        if mtime == self._mtime:
            return
        with self.path.open("rb") as fh:
            doc = tomllib.load(fh)
        self.categories = doc["categories"]["list"]
        self.descriptions: dict[str, str] = doc["categories"].get("describe", {})
        # One alternation per category beats one regex per pattern: 18 searches
        # per merchant instead of 194.
        self._compiled = [
            (re.compile("|".join(f"(?:{p})" for p in pats), re.I), cat)
            for cat, pats in doc["rules"].items()
        ]
        self._mtime = mtime

    def match(self, key: str, raw: str | None = None) -> str | None:
        """Match the normalised key first, then the raw statement text.

        Plaid's merchant_name is cleaned and truncated - 'GglPay TST*
        T.I.T.T.MIAMI' arrives as 'I.t.t', losing the TST* marker that
        identifies a Toast restaurant terminal. The raw descriptor keeps those
        processor markers, so it is worth a second pass.
        """
        for pattern, category in self._compiled:
            if pattern.search(key):
                return category
        if raw:
            for pattern, category in self._compiled:
                if pattern.search(raw):
                    return category
        return None


class Categorizer:
    def __init__(self, conn: sqlite3.Connection, rules: Rules | None = None):
        self.conn = conn
        self.rules = rules or Rules()
        self.backend = os.environ.get("CATEGORIZER", "llm").lower()
        if self.backend not in BACKENDS:
            raise ValueError(f"CATEGORIZER must be one of {', '.join(BACKENDS)}, "
                             f"not {self.backend!r}")
        if self.backend == "laya":
            self.base_url = os.environ.get("LAYA_BASE_URL", "http://127.0.0.1:8090").rstrip("/")
            self.model = "laya"
            self.min_confidence = float(os.environ.get("LAYA_MIN_CONFIDENCE", "0.7"))
        else:
            self.base_url = os.environ.get("LLM_BASE_URL", "http://127.0.0.1:11434/v1").rstrip("/")
            self.model = os.environ.get("LLM_MODEL", "huihui_ai/qwen3.5-abliterated:9b")

    def _lookup_tables(self) -> tuple[dict[str, str], dict[str, str]]:
        overrides = {r["merchant_key"]: r["category"] for r in self.conn.execute(
            "SELECT merchant_key, category FROM category_overrides")}
        cache = {r["merchant_key"]: r["category"] for r in self.conn.execute(
            "SELECT merchant_key, category FROM merchant_category_cache")}
        return overrides, cache

    def resolve(self, rows: list[dict], use_llm: bool = True) -> list[dict]:
        """Annotate rows with category / category_source / is_transfer.

        Each row needs merchant_key and may carry plaid_category. Resolution
        happens once per distinct merchant, not once per transaction.
        """
        self.rules.reload()
        overrides, cache = self._lookup_tables()

        resolved: dict[str, tuple[str, str]] = {}
        unknown: list[str] = []
        # Plaid's merchant_name is often truncated ('Clipper', 'First Cl'), so
        # keep one raw descriptor per merchant as context for the LLM - the full
        # statement text is what disambiguates them.
        samples: dict[str, str] = {}
        for row in rows:
            key = row["merchant_key"]
            if (raw := row.get("name")) and key not in samples:
                samples[key] = raw
            if key in resolved or key in unknown:
                continue
            if (cat := overrides.get(key)):
                resolved[key] = (cat, "override")
            elif (cat := self.rules.match(key, samples.get(key))):
                resolved[key] = (cat, "rule")
            elif (cat := cache.get(key)):
                resolved[key] = (cat, "llm")
            else:
                unknown.append(key)

        if unknown and use_llm and self.backend != "none":
            for key, cat in self._ask_llm(unknown, samples).items():
                resolved[key] = (cat, "llm")

        for row in rows:
            cat, source = resolved.get(row["merchant_key"], (None, None))
            if cat is None:
                cat = PLAID_MAP.get(row.get("plaid_category") or "", UNCATEGORIZED)
                source = "plaid" if cat != UNCATEGORIZED else "uncategorized"
            row["category"] = cat
            row["category_source"] = source
            row["is_transfer"] = int(cat in TRANSFER_CATEGORIES)
        return rows

    def available(self) -> bool:
        """Is a model server actually listening? Checked with a short timeout.

        Without this an unattended sync stalls for LLM_TIMEOUT per batch against
        a dead port. Unresolved merchants simply stay uncategorised and are
        retried on the next sync, so skipping is always safe.
        """
        probe = "/health" if self.backend == "laya" else "/models"
        try:
            with httpx.Client(timeout=PROBE_TIMEOUT) as client:
                return client.get(f"{self.base_url}{probe}").status_code < 500
        except httpx.HTTPError:
            return False

    def _ask_llm(self, keys: list[str], samples: dict[str, str] | None = None) -> dict[str, str]:
        """One request per LLM_BATCH merchants. Answers are cached as each
        batch returns, so a crash mid-run never re-asks what already succeeded."""
        if not self.available():
            print(f"  no model server at {self.base_url} - leaving {len(keys)} "
                  f"merchant(s) uncategorised, will retry next sync")
            return {}

        answers: dict[str, str] = {}
        allowed = set(self.rules.categories)
        request = self._request_laya if self.backend == "laya" else self._request
        with httpx.Client(timeout=LLM_TIMEOUT) as client:
            for i in range(0, len(keys), LLM_BATCH):
                chunk = keys[i:i + LLM_BATCH]
                try:
                    got = request(client, chunk, allowed, samples or {})
                except (httpx.HTTPError, json.JSONDecodeError, KeyError, ValueError) as exc:
                    print(f"  LLM batch failed ({exc.__class__.__name__}: {exc}); "
                          f"{len(chunk)} merchants left uncategorised")
                    continue
                if got:
                    self.conn.executemany(
                        "INSERT OR REPLACE INTO merchant_category_cache"
                        " (merchant_key, category, model) VALUES (?, ?, ?)",
                        [(k, v, self.model) for k, v in got.items()],
                    )
                    answers.update(got)
        return answers

    def _request(self, client: httpx.Client, chunk: list[str], allowed: set[str],
                 samples: dict[str, str]) -> dict[str, str]:
        prompt = (
            "Classify each card/bank transaction merchant into exactly one category.\n"
            f"Allowed categories: {', '.join(sorted(allowed))}\n"
            'Use "Other" when genuinely unclear. Reply with JSON only: an object '
            "mapping each merchant string verbatim to its category.\n\n"
            "Merchants:\n" + "\n".join(f"- {k}" for k in chunk)
        )
        resp = client.post(
            f"{self.base_url}/chat/completions",
            json={
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0,
                "response_format": {"type": "json_object"},
                # Bonsai's llama-server runs with thinking off; be explicit so a
                # differently-configured server does not burn tokens on it either.
                "chat_template_kwargs": {"enable_thinking": False},
            },
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        parsed = json.loads(_strip_fence(content))
        chunk_set = set(chunk)
        return {k: v for k, v in parsed.items() if k in chunk_set and v in allowed}

    def _request_laya(self, client: httpx.Client, chunk: list[str], allowed: set[str],
                      samples: dict[str, str]) -> dict[str, str]:
        """Laya scores one state per request but answers in milliseconds, so a
        request per merchant is cheap. Answers under LAYA_MIN_CONFIDENCE are
        dropped rather than cached: the merchant stays uncategorised for review
        instead of being filed under a guess forever."""
        descriptions = self.rules.descriptions
        question = {
            "type": "choice",
            "instructions": "Which spending category does this card or bank "
                            "transaction merchant belong to?",
            "criteria": {c: descriptions.get(c, c) for c in self.rules.categories},
        }
        # Measured against rule-matched merchants: a prose state beat a
        # {"merchant": ...} object (46% vs 34%), and typed-decisions was the only
        # checkpoint whose confidence meant anything - 79% right at >= 0.7.
        # Pinned, too: left to itself the router reads a bare 'GYU KAKU' as
        # not-English and loads the multilingual checkpoint to answer it.
        answers: dict[str, str] = {}
        for key in chunk:
            state = {"body": f"Credit card charge from merchant {key}. "
                             f"Statement text: {samples.get(key) or key}"}
            resp = client.post(f"{self.base_url}/v1/systemone", json={
                "model": "typed-decisions", "state": state,
                "questions": {"category": question}})
            resp.raise_for_status()
            got = resp.json()["answers"]["category"]
            if got["choice"] in allowed and got["confidence"] >= self.min_confidence:
                answers[key] = got["choice"]
        return answers


def _strip_fence(text: str) -> str:
    text = text.strip()
    start, end = text.find("{"), text.rfind("}")
    return text[start:end + 1] if start != -1 and end > start else text
