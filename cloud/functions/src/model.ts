/**
 * The Firestore data model, and the one piece of it that needs care.
 *
 * SQLite computed every figure on read:
 *
 *     SELECT category, SUM(amount - cashback - split_owed) ... GROUP BY category
 *
 * Firestore has no SUM, no GROUP BY and no JOIN, so that inverts: each
 * transaction stores its own `net`, and a per-month totals document carries the
 * running sums. Reads become a single document fetch, but every write that
 * changes a `net` must move the totals by the same amount, in the same write, or
 * the two drift apart - and a wrong total looks exactly like a right one.
 *
 * WRITE SHAPE - read before touching any totals or `private` write:
 *
 *   set(ref, {...}, { merge: true }) treats a dotted key LITERALLY. Writing
 *   {"byCategory.Groceries": increment(5)} does not touch byCategory at all; it
 *   creates a top-level field whose name contains a dot. Verified against the
 *   emulator. Nested writes under merge must be nested objects:
 *
 *       { byCategory: { Groceries: increment(5) } }      merges, correctly
 *
 *   That is why every totals write in this codebase goes through
 *   `totalsWrite`, and why nothing here builds a dotted key by hand.
 */

import { Firestore, FieldValue, Transaction } from "firebase-admin/firestore";

export interface Txn {
  txnId: string;
  accountId: string;
  date: string;            // YYYY-MM-DD
  month: string;           // YYYY-MM, denormalised so a month query needs no range scan
  name: string | null;
  merchantName: string | null;
  merchantKey: string;
  amount: number;          // Plaid's sign: positive leaves the account
  cashback: number;
  cashbackPct: number | null;      // as entered; null for a flat amount
  cashbackPayout: string | null;   // paypal | amex_mr | bilt
  cashbackSource: string | null;
  cashbackReceived: boolean;
  splitOwed: number;
  splitNote: string | null;
  splitSource: string | null;
  splitSettled: boolean;
  net: number;             // amount - cashback - splitOwed
  isoCurrency: string | null;
  pending: boolean;
  plaidCategory: string | null;
  category: string;
  categorySource: string;
  isTransfer: boolean;
  p2p: boolean;            // Zelle, Venmo and friends - sorted by hand
  logoUrl: string | null;
  search: string[];        // word prefixes, for array-contains search
}

export interface MonthTotals {
  month: string;
  total: number;                          // spend, excluding transfers and income
  income: number;
  byCategory: Record<string, number>;
  txnCount: number;
  // the same figures per account, so filtering the dashboard by account costs
  // no extra reads
  byAccount: Record<string, Omit<MonthTotals, "month" | "byAccount">>;
}

/** Person-to-person apps. The Transfer rule files every one of these as a
 *  transfer, which is right for moving your own money and wrong for paying a
 *  friend back - so they get sorted by hand. */
const P2P_WORDS = ["ZELLE", "VENMO", "CASH APP", "CASHAPP", "SQUARE CASH", "APPLE CASH"];
export const isP2P = (name: string | null, merchantKey: string): boolean => {
  const text = (name || merchantKey || "").toUpperCase();
  return P2P_WORDS.some((w) => text.includes(w));
};

/** Spend means money out that is neither an internal transfer nor income. */
export const countsAsSpend = (t: Pick<Txn, "isTransfer" | "category">): boolean =>
  !t.isTransfer && t.category !== "Income";

/**
 * Firestore has no LIKE, so each transaction carries the prefixes of the words
 * in its description; a search is then one array-contains query. Prefixes stop
 * at 12 characters - nobody types more of a merchant name than that before
 * the list is down to a handful.
 */
export function searchTerms(t: Pick<Txn, "name" | "merchantName" | "merchantKey">): string[] {
  const terms = new Set<string>();
  const text = `${t.merchantName ?? ""} ${t.name ?? ""} ${t.merchantKey ?? ""}`.toLowerCase();
  for (const word of text.split(/[^a-z0-9]+/)) {
    for (let n = 2; n <= Math.min(word.length, 12); n++) terms.add(word.slice(0, n));
  }
  return [...terms];
}

export const netOf = (t: Pick<Txn, "amount" | "cashback" | "splitOwed">): number =>
  round2(t.amount - (t.cashback || 0) - (t.splitOwed || 0));

/**
 * Money is decimal and doubles are not. Every figure that lands in Firestore or
 * moves a total goes through this, so repeated deltas cannot accumulate the
 * 0.000000001 drift that makes a balance end in seven cents of nothing.
 */
export const round2 = (value: number): number => Math.round(value * 100) / 100;

export const userDoc = (db: Firestore, uid: string) => db.collection("users").doc(uid);
export const txnCol = (db: Firestore, uid: string) => userDoc(db, uid).collection("transactions");
export const totalsDoc = (db: Firestore, uid: string, month: string) =>
  userDoc(db, uid).collection("totals").doc(month);
export const privateDoc = (db: Firestore, uid: string) =>
  userDoc(db, uid).collection("private").doc("plaid");

interface Part {
  total: number;
  income: number;
  count: number;
  byCategory: Map<string, number>;
}

/** One month's pending change, before it is turned into a write. */
export interface Delta extends Part {
  byAccount: Map<string, Part>;
}

const emptyPart = (): Part => ({ total: 0, income: 0, count: 0, byCategory: new Map() });
export const emptyDelta = (): Delta => ({ ...emptyPart(), byAccount: new Map() });

/**
 * Fold one transaction into a delta, in (+1) or out (-1). The count is of spend
 * transactions only, matching the web dashboard - transfers and income are not
 * things you bought.
 */
export function fold(delta: Delta, t: Txn, sign: 1 | -1, countIt = true): void {
  let account = delta.byAccount.get(t.accountId);
  if (!account) { account = emptyPart(); delta.byAccount.set(t.accountId, account); }
  foldPart(delta, t, sign, countIt);
  foldPart(account, t, sign, countIt);
}

function foldPart(part: Part, t: Txn, sign: 1 | -1, countIt: boolean): void {
  if (countIt && countsAsSpend(t)) part.count += sign;
  if (t.category === "Income") {
    part.income -= sign * t.amount;            // inflows are negative in Plaid's sign
  } else if (countsAsSpend(t)) {
    part.total += sign * t.net;
    part.byCategory.set(t.category, (part.byCategory.get(t.category) ?? 0) + sign * t.net);
  }
}

/**
 * The only function that builds a totals write. Nested objects, increments
 * throughout, so it is correct under merge and under concurrent writers.
 * Returns null when nothing actually moved, so callers skip the write.
 */
export function totalsWrite(month: string, delta: Delta): Record<string, unknown> | null {
  const byAccount: Record<string, unknown> = {};
  for (const [accountId, part] of delta.byAccount) {
    const w = partWrite(part);
    if (w) byAccount[accountId] = w;
  }
  // A move between accounts at the same amount leaves the month's figures
  // alone but still shifts them between accounts.
  const write = partWrite(delta) ?? {};
  if (Object.keys(byAccount).length) write.byAccount = byAccount;
  if (!Object.keys(write).length) return null;
  return { ...write, month, updatedAt: FieldValue.serverTimestamp() };
}

function partWrite(part: Part): Record<string, unknown> | null {
  const write: Record<string, unknown> = {};
  if (round2(part.total)) write.total = FieldValue.increment(round2(part.total));
  if (round2(part.income)) write.income = FieldValue.increment(round2(part.income));
  if (part.count) write.txnCount = FieldValue.increment(part.count);
  const byCategory: Record<string, FieldValue> = {};
  for (const [category, amount] of part.byCategory) {
    if (round2(amount)) byCategory[category] = FieldValue.increment(round2(amount));
  }
  if (Object.keys(byCategory).length) write.byCategory = byCategory;
  return Object.keys(write).length ? write : null;
}

/** A month's totals as plain figures, for writing a document whole. */
export function totalsValue(month: string, delta: Delta): MonthTotals {
  const plain = (part: Part) => ({
    total: round2(part.total),
    income: round2(part.income),
    txnCount: part.count,
    byCategory: Object.fromEntries(
      [...part.byCategory].map(([k, v]) => [k, round2(v)]).filter(([, v]) => v !== 0)),
  });
  return {
    month,
    ...plain(delta),
    byAccount: Object.fromEntries([...delta.byAccount].map(([id, part]) => [id, plain(part)])),
  };
}

/**
 * Move a month's totals by the difference one change makes, inside the same
 * Firestore transaction as the change. `before: null` is an add, `after: null`
 * a delete, both together a recategorisation or a re-netting.
 */
export function applyDelta(
  tx: Transaction, db: Firestore, uid: string, before: Txn | null, after: Txn | null,
): void {
  const deltas = new Map<string, Delta>();
  const at = (month: string) => {
    let d = deltas.get(month);
    if (!d) { d = emptyDelta(); deltas.set(month, d); }
    return d;
  };
  // A change that keeps the transaction in the same month must not move the
  // count: it is one transaction throughout.
  const sameMonth = before && after && before.month === after.month;
  if (before) fold(at(before.month), before, -1, !sameMonth);
  if (after) fold(at(after.month), after, 1, !sameMonth);
  for (const [month, delta] of deltas) {
    const write = totalsWrite(month, delta);
    if (write) tx.set(totalsDoc(db, uid, month), write, { merge: true });
  }
}

/**
 * Accumulates many deltas in memory, then writes one update per month.
 *
 * A sync touches hundreds of transactions spread over two years. Running a
 * Firestore transaction for each would be hundreds of round trips and billed
 * writes to the same handful of documents. This collapses them: 1,811
 * transactions across 25 months become 25 writes.
 */
export class TotalsAccumulator {
  private readonly months = new Map<string, Delta>();

  private at(month: string): Delta {
    let delta = this.months.get(month);
    if (!delta) { delta = emptyDelta(); this.months.set(month, delta); }
    return delta;
  }

  add(t: Txn): void { fold(this.at(t.month), t, 1); }
  remove(t: Txn): void { fold(this.at(t.month), t, -1); }

  replace(before: Txn, after: Txn): void {
    const sameMonth = before.month === after.month;
    fold(this.at(before.month), before, -1, !sameMonth);
    fold(this.at(after.month), after, 1, !sameMonth);
  }

  async flush(db: Firestore, uid: string): Promise<number> {
    const batch = db.batch();
    let count = 0;
    for (const [month, delta] of this.months) {
      const write = totalsWrite(month, delta);
      if (write) {
        batch.set(totalsDoc(db, uid, month), write, { merge: true });
        count += 1;
      }
    }
    if (count) await batch.commit();
    this.months.clear();
    return count;
  }
}

/**
 * Rebuild a month's totals from its transactions.
 *
 * A plain set, deliberately not a merge: it replaces the whole document, which
 * also clears any field a bad write left behind. The way back when a running
 * total has drifted. Reads every transaction in the month, so it is not on any
 * hot path.
 */
export async function recomputeTotals(db: Firestore, uid: string, month: string): Promise<MonthTotals> {
  const snapshot = await txnCol(db, uid).where("month", "==", month).get();
  const delta = emptyDelta();
  for (const doc of snapshot.docs) fold(delta, doc.data() as Txn, 1);
  const totals = totalsValue(month, delta);
  await totalsDoc(db, uid, month).set({ ...totals, updatedAt: FieldValue.serverTimestamp() });
  return totals;
}

/**
 * Remove fields whose names contain a dot - the debris an earlier dotted-key
 * merge left behind. A name with a dot cannot be addressed as a plain string
 * path, so each is deleted through a single-segment FieldPath.
 */
export async function removeDottedFields(
  ref: FirebaseFirestore.DocumentReference,
): Promise<string[]> {
  const snapshot = await ref.get();
  if (!snapshot.exists) return [];
  const junk = Object.keys(snapshot.data() ?? {}).filter((key) => key.includes("."));
  if (!junk.length) return [];
  const { FieldPath } = await import("firebase-admin/firestore");
  const args: unknown[] = [];
  for (const key of junk) args.push(new FieldPath(key), FieldValue.delete());
  await (ref.update as (...a: unknown[]) => Promise<unknown>)(...args);
  return junk;
}
