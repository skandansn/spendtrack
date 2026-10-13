/**
 * Merchant normalisation and categorisation, ported from the Python app.
 *
 * Precedence, highest first: a correction you made by hand, then rules, then a
 * cached answer from an earlier model call, then Plaid's own guess. Because the
 * first three are keyed on the normalised merchant, a given merchant is
 * classified once and never reconsidered.
 *
 * The normalisation here is load-bearing and every line of it was earned by a
 * bug - see the comments. It must stay byte-identical to the Python version or
 * the two will disagree about which merchant a transaction belongs to.
 */

import { CATEGORIES, Category, RULES } from "./rules";

// Processor junk in front of the real merchant name. The separator is mandatory:
// these codes are short enough that an optional one strips "SP" off "SPOTIFY".
const PREFIX = /^(?:(?:SQ|TST|PAYPAL|PY|PP|SP|EIG|IC|WL|CKE)\s*\*+\s*|(?:PURCHASE|POS)\s+)/i;
// Genuinely trailing noise: a store number, phone number or date, and whatever
// follows it.
const TRAIL = /\s*(?:#\s*\d+|\b\d{3}-\d{3}-\d{4}\b|\b\d{2}\/\d{2}\b).*$/i;
// A bare reference number is excised in place, not truncated to: cutting the
// tail turns "CREDIT CARD 3333 PAYMENT" into "CARD" and loses the word the
// Transfer rule keys on.
const REFNUM = /\b\d{4,}\b/g;
// A two-letter state at the very end, once punctuation is already spaces.
const STATE = /\s+[A-Z]{2}\s*$/;
// "." survives so NETFLIX.COM stays intact; "*" does not, because processors use
// it as a separator and "UBER *EATS" must normalise to the same key as "UBER EATS".
const PUNCT = /[^A-Z0-9&. ]+/g;
const SPACE = /\s+/g;

export const TRANSFER_CATEGORIES = new Set<string>(["Transfer"]);

/** Plaid's personal_finance_category primary, mapped onto our taxonomy. */
const PLAID_MAP: Readonly<Record<string, Category>> = {
  INCOME: "Income",
  TRANSFER_IN: "Transfer",
  TRANSFER_OUT: "Transfer",
  LOAN_PAYMENTS: "Transfer",
  BANK_FEES: "Fees",
  ENTERTAINMENT: "Entertainment",
  FOOD_AND_DRINK: "Restaurants",
  GENERAL_MERCHANDISE: "Shopping",
  HOME_IMPROVEMENT: "Shopping",
  MEDICAL: "Health",
  PERSONAL_CARE: "Personal Care",
  GENERAL_SERVICES: "Other",
  GOVERNMENT_AND_NON_PROFIT: "Other",
  TRANSPORTATION: "Transport",
  TRAVEL: "Travel",
  RENT_AND_UTILITIES: "Utilities",
};

/**
 * Collapse a raw descriptor to a stable key. "SQ *BLUE BOTTLE #412 SAN
 * FRANCISCO CA" and "SQ *BLUE BOTTLE #77" both land on "BLUE BOTTLE".
 */
export function merchantKey(name?: string | null, merchantName?: string | null): string {
  let raw = (merchantName || name || "").toUpperCase().trim();
  if (!raw) return "UNKNOWN";
  raw = raw.replace(PREFIX, "");
  raw = raw.replace(TRAIL, "");
  raw = raw.replace(REFNUM, " ");
  raw = raw.replace(PUNCT, " ");
  raw = raw.replace(SPACE, " ").trim();
  raw = raw.replace(STATE, "");
  return raw || "UNKNOWN";
}

/**
 * Match the normalised key first, then the raw statement text.
 *
 * Plaid's merchant_name is cleaned and truncated - "GglPay TST* T.I.T.T.MIAMI"
 * arrives as "I.t.t", losing the TST* marker that identifies a Toast restaurant
 * terminal. The raw descriptor keeps those processor markers, so it earns a
 * second pass.
 */
export function matchRules(key: string, raw?: string | null): Category | null {
  for (const [category, pattern] of RULES) {
    if (pattern.test(key)) return category;
  }
  if (raw) {
    const upper = raw.toUpperCase();
    for (const [category, pattern] of RULES) {
      if (pattern.test(upper)) return category;
    }
  }
  return null;
}

export interface Resolution {
  category: Category;
  source: "override" | "rule" | "cache" | "plaid" | "uncategorized";
  isTransfer: boolean;
}

/**
 * Decide one merchant's category. Pure: the caller supplies the override and
 * cache lookups, so this needs no database access and is trivially testable.
 */
export function resolve(
  key: string,
  raw: string | null,
  plaidCategory: string | null,
  overrides: ReadonlyMap<string, string>,
  cache: ReadonlyMap<string, string>,
): Resolution {
  const done = (category: string, source: Resolution["source"]): Resolution => ({
    category: category as Category,
    source,
    isTransfer: TRANSFER_CATEGORIES.has(category),
  });

  const override = overrides.get(key);
  if (override) return done(override, "override");

  const rule = matchRules(key, raw);
  if (rule) return done(rule, "rule");

  const cached = cache.get(key);
  if (cached) return done(cached, "cache");

  const fromPlaid = plaidCategory ? PLAID_MAP[plaidCategory] : undefined;
  if (fromPlaid) return done(fromPlaid, "plaid");

  return done("Other", "uncategorized");
}

export const isCategory = (value: string): value is Category =>
  (CATEGORIES as readonly string[]).includes(value);
