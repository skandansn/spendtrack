/**
 * Everything the app reads and writes, and the rules it does it by.
 *
 * Firestore bills per document read, so shape matters more here than it did
 * against SQL:
 *
 *   - figures come from one `totals/{month}` document, never from summing
 *     transactions, so opening the dashboard costs a handful of reads
 *   - recurring charges and the review queue come precomputed in one
 *     `insights/current` document, written by the server after each sync
 *   - long lists page and are not live; only short lists (cashback pending,
 *     money owed, Zelle to sort) subscribe, because a live query re-reads
 *     every document it watches whenever any of them changes
 *
 * Every edit that changes what a transaction costs moves that month's totals by
 * the same amount, in the same batch, through `totalsWrite`. That function
 * builds nested objects on purpose: under set+merge a dotted key such as
 * "byCategory.Groceries" is stored as a literal field name and never reaches
 * the totals. An earlier version did exactly that.
 *
 * Edits use a batch rather than a transaction. A sync landing between reading a
 * transaction and writing it could leave a total a few dollars off; the daily
 * server rebuild recomputes every total from the transactions, so that drift
 * lasts at most a day, and in exchange an edit costs half the reads.
 */

import { useEffect, useMemo, useState } from "react";
import {
  DocumentReference, QueryDocumentSnapshot, collection, deleteDoc, doc, getDoc, getDocs,
  increment, limit as qLimit, onSnapshot, orderBy, query, serverTimestamp, setDoc,
  startAfter, where, writeBatch,
} from "firebase/firestore";

import { auth, db } from "./firebase";

export interface Txn {
  txnId: string;
  accountId: string;
  date: string;
  month: string;
  name: string | null;
  merchantName: string | null;
  merchantKey: string;
  amount: number;
  cashback: number;
  cashbackPct: number | null;
  cashbackPayout: string | null;
  cashbackSource: string | null;
  cashbackReceived: boolean;
  splitOwed: number;
  splitNote: string | null;
  splitSource: string | null;
  splitSettled: boolean;
  net: number;
  pending: boolean;
  category: string;
  categorySource: string;
  isTransfer: boolean;
  p2p: boolean;
  logoUrl: string | null;
  search?: string[];
}

export interface MonthTotals {
  month: string;
  total: number;
  income: number;
  byCategory: Record<string, number>;
  txnCount: number;
  byAccount?: Record<string, Omit<MonthTotals, "month" | "byAccount">>;
}

export interface Account {
  accountId: string;
  itemId: string;
  name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  currentBalance: number | null;
  availableBalance: number | null;
  creditLimit: number | null;
  nextPaymentDueDate?: string | null;
  aprPercentage?: number | null;
  isOverdue?: boolean | null;
}

export interface Institution {
  itemId: string;
  name: string | null;
  logo: string | null;
  color: string | null;
  status: string;
}

export interface Recurring {
  merchantKey: string;
  merchantName: string | null;
  logoUrl: string | null;
  category: string;
  cadence: string;
  amount: number;
  monthly: number;
  lastDate: string;
  nextDate: string;
  charges: number;
}

export interface ReviewItem {
  merchantKey: string;
  name: string | null;
  merchantName: string | null;
  logoUrl: string | null;
  category: string;
  categorySource: string;
  txns: number;
  amount: number;
  lastDate: string;
}

export interface Insights {
  recurring: Recurring[];
  recurringMonthly: number;
  review: ReviewItem[];
}

export const CATEGORIES = [
  "Groceries", "Restaurants", "Coffee", "Transport", "Fuel", "Travel", "Shopping",
  "Subscriptions", "Utilities", "Rent", "Health", "Fitness", "Entertainment",
  "Education", "Personal Care", "Fees", "Income", "Transfer", "Other",
] as const;

/** Payout programs, and whether Rakuten pays them in points (one per cent). */
export const PAYOUTS: Record<string, { label: string; points: boolean }> = {
  paypal: { label: "PayPal", points: false },
  amex_mr: { label: "Amex MR", points: true },
  bilt: { label: "Bilt", points: true },
};

const uid = (): string | null => auth.currentUser?.uid ?? null;
const me = (): string => {
  const id = uid();
  if (!id) throw new Error("not signed in");
  return id;
};
const userCol = (name: string) => collection(db, "users", me(), name);
const userRef = (name: string, id: string) => doc(db, "users", me(), name, id);

// --- dates -------------------------------------------------------------------
// Local, not UTC. toISOString() is UTC, so at 9pm in New York on the last day of
// a month it already reports next month - and every figure would shift.

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const ym = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export const thisMonth = (): string => ym(new Date());

/** The last `count` months, newest first. */
export function recentMonths(count: number): string[] {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => ym(new Date(now.getFullYear(), now.getMonth() - i, 1)));
}

// --- money and totals --------------------------------------------------------

export const round2 = (v: number) => Math.round(v * 100) / 100;
const countsAsSpend = (t: Pick<Txn, "isTransfer" | "category">) =>
  !t.isTransfer && t.category !== "Income";
export const netOf = (t: Pick<Txn, "amount" | "cashback" | "splitOwed">) =>
  round2(t.amount - (t.cashback || 0) - (t.splitOwed || 0));

// Mirrors the server's model.ts: the month's figures, and the same per account.
interface Part { total: number; income: number; count: number; byCategory: Map<string, number> }
interface Delta extends Part { byAccount: Map<string, Part> }
const emptyPart = (): Part => ({ total: 0, income: 0, count: 0, byCategory: new Map() });
const emptyDelta = (): Delta => ({ ...emptyPart(), byAccount: new Map() });

function fold(delta: Delta, t: Txn, sign: 1 | -1): void {
  let account = delta.byAccount.get(t.accountId);
  if (!account) { account = emptyPart(); delta.byAccount.set(t.accountId, account); }
  foldPart(delta, t, sign);
  foldPart(account, t, sign);
}

function foldPart(part: Part, t: Txn, sign: 1 | -1): void {
  if (countsAsSpend(t)) part.count += sign;
  if (t.category === "Income") {
    part.income -= sign * t.amount;
  } else if (countsAsSpend(t)) {
    part.total += sign * t.net;
    part.byCategory.set(t.category, (part.byCategory.get(t.category) ?? 0) + sign * t.net);
  }
}

/** The only builder of a totals write: nested objects, increments, nothing dotted. */
function totalsWrite(month: string, delta: Delta): Record<string, unknown> | null {
  const byAccount: Record<string, unknown> = {};
  for (const [accountId, part] of delta.byAccount) {
    const w = partWrite(part);
    if (w) byAccount[accountId] = w;
  }
  const write = partWrite(delta) ?? {};
  if (Object.keys(byAccount).length) write.byAccount = byAccount;
  if (!Object.keys(write).length) return null;
  return { ...write, month, updatedAt: serverTimestamp() };
}

function partWrite(part: Part): Record<string, unknown> | null {
  const write: Record<string, unknown> = {};
  if (round2(part.total)) write.total = increment(round2(part.total));
  if (round2(part.income)) write.income = increment(round2(part.income));
  if (part.count) write.txnCount = increment(part.count);
  const byCategory: Record<string, unknown> = {};
  for (const [category, amount] of part.byCategory) {
    if (round2(amount)) byCategory[category] = increment(round2(amount));
  }
  if (Object.keys(byCategory).length) write.byCategory = byCategory;
  return Object.keys(write).length ? write : null;
}

/**
 * Apply `change` to some transactions and move the totals to match, in batches
 * that stay inside Firestore's 500-write limit. `change` returns the new
 * transaction, or null to leave one alone.
 */
async function editTxns(
  docs: QueryDocumentSnapshot[] | { ref: DocumentReference; data: () => unknown }[],
  change: (t: Txn) => Txn | null,
): Promise<number> {
  let edited = 0;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = writeBatch(db);
    const deltas = new Map<string, Delta>();
    const at = (m: string) => { let d = deltas.get(m); if (!d) { d = emptyDelta(); deltas.set(m, d); } return d; };
    for (const document of docs.slice(i, i + 400)) {
      const before = document.data() as Txn;
      const changed = change(before);
      if (!changed) continue;
      const after = { ...changed, net: netOf(changed) };
      fold(at(before.month), before, -1);
      fold(at(after.month), after, 1);
      batch.set(document.ref, after);
      edited++;
    }
    for (const [month, delta] of deltas) {
      const write = totalsWrite(month, delta);
      if (write) batch.set(userRef("totals", month), write, { merge: true });
    }
    await batch.commit();
  }
  return edited;
}

const oneTxn = async (txnId: string) => {
  const snapshot = await getDoc(userRef("transactions", txnId));
  if (!snapshot.exists()) throw new Error("That transaction no longer exists.");
  return [{ ref: snapshot.ref, data: () => snapshot.data() }];
};

// --- reads -------------------------------------------------------------------

/** Live month totals: one document per month, so a dashboard open is a handful
 *  of reads, and a sync landing while you look updates the figures. */
export function useTotals(months: string[]) {
  const [totals, setTotals] = useState<Map<string, MonthTotals>>(new Map());
  const [loading, setLoading] = useState(true);
  const key = months.join(",");
  useEffect(() => {
    if (!uid()) return;
    setLoading(true);
    let pending = months.length;
    const offs = months.map((month) => onSnapshot(userRef("totals", month), (s) => {
      setTotals((prev) => new Map(prev).set(month, {
        month, total: 0, income: 0, byCategory: {}, txnCount: 0, ...(s.data() as object),
      }));
      if (--pending <= 0) setLoading(false);
    }));
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { totals, loading };
}

function useCollection<T>(name: string): T[] {
  const [rows, setRows] = useState<T[]>([]);
  const id = uid();
  useEffect(() => {
    if (!id) return;
    return onSnapshot(userCol(name), (s) => setRows(s.docs.map((d) => ({ id: d.id, ...d.data() }) as T)));
  }, [id, name]);
  return rows;
}

export const useAccounts = () => useCollection<Account>("accounts");
export const useInstitutions = () => useCollection<Institution>("institutions");
export const useBudgets = () => {
  const rows = useCollection<{ id: string; monthly: number }>("budgets");
  return useMemo(() => new Map(rows.map((r) => [r.id, r.monthly])), [rows]);
};

export function useInsights(): Insights | null {
  const [insights, setInsights] = useState<Insights | null>(null);
  const id = uid();
  useEffect(() => {
    if (!id) return;
    return onSnapshot(userRef("insights", "current"),
      (s) => setInsights(s.exists() ? (s.data() as Insights) : null));
  }, [id]);
  return insights;
}

export function useLastSync(): Date | null {
  const [at, setAt] = useState<Date | null>(null);
  const id = uid();
  useEffect(() => {
    if (!id) return;
    return onSnapshot(doc(db, "users", id), (s) => setAt(s.get("lastSyncAt")?.toDate?.() ?? null));
  }, [id]);
  return at;
}

/** A short live list - fine to subscribe to, because it stays short. */
function useLiveQuery(build: () => ReturnType<typeof query> | null, deps: unknown[]): Txn[] {
  const [rows, setRows] = useState<Txn[]>([]);
  const id = uid();
  useEffect(() => {
    if (!id) return;
    const q = build();
    if (!q) return;
    return onSnapshot(q, (s) => setRows(s.docs.map((d) => d.data() as Txn)),
      () => setRows([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ...deps]);
  return rows;
}

/** Zelle and Venmo payments nobody has sorted yet. */
export const useP2P = () => useLiveQuery(() => query(userCol("transactions"),
  where("p2p", "==", true),
  where("categorySource", "in", ["rule", "plaid", "cache", "uncategorized"]),
  orderBy("date", "desc"), qLimit(30)), []);

/** Cashback marked on a purchase but not paid out yet. */
export const useCashbackPending = () => useLiveQuery(() => query(userCol("transactions"),
  where("cashbackReceived", "==", false), where("cashback", ">", 0)), []);

/** Shares of bills you fronted that have not been paid back. */
export const useSplitOwed = () => useLiveQuery(() => query(userCol("transactions"),
  // explicit order to match the deployed index (splitSettled, splitOwed desc);
  // left implicit it would sort ascending and need an index that does not exist
  where("splitSettled", "==", false), where("splitOwed", ">", 0), orderBy("splitOwed", "desc")), []);

export const SORTS = {
  newest: ["date", "desc"], oldest: ["date", "asc"],
  largest: ["amount", "desc"], smallest: ["amount", "asc"],
  merchant: ["merchantKey", "asc"],
} as const;
export type Sort = keyof typeof SORTS;

export interface TxnFilter {
  month?: string | null;
  category?: string | null;
  accountId?: string | null;
  includeTransfers?: boolean;
  q?: string | null;
  sort?: Sort;
}

const PAGE = 50;
// A search is answered whole and sorted on the phone: it matches a few dozen
// rows, and array-contains alongside other filters and sorts would need an
// index for every combination.
const SEARCH_CAP = 500;

/** The search words, each cut to the 12-character prefix the server stores. */
export const searchWords = (q: string | null | undefined): string[] =>
  (q ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2).map((w) => w.slice(0, 12));

const matches = (t: Txn, words: string[]) => words.every((w) => t.search?.includes(w));

/**
 * A page at a time. Deliberately not live: a subscription over a long list
 * re-reads every document it watches whenever any one changes.
 */
export function useTransactions(filter: TxnFilter) {
  const [rows, setRows] = useState<Txn[]>([]);
  const [cursor, setCursor] = useState<QueryDocumentSnapshot | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(filter);
  const words = searchWords(filter.q);
  const [field, direction] = SORTS[filter.sort ?? "newest"];

  const keep = (t: Txn) =>
    (!filter.month || t.month === filter.month)
    && (!filter.category || t.category === filter.category)
    && (!filter.accountId || t.accountId === filter.accountId)
    && (filter.includeTransfers || filter.category || !t.isTransfer)
    && matches(t, words);

  const fetchSearch = async () => {
    const snapshot = await getDocs(query(userCol("transactions"),
      where("search", "array-contains", words[0]!), orderBy("date", "desc"), qLimit(SEARCH_CAP)));
    const sign = direction === "asc" ? 1 : -1;
    const found = snapshot.docs.map((d) => d.data() as Txn).filter(keep)
      .sort((a, b) => {
        const x = a[field], y = b[field];
        return sign * (typeof x === "number" ? x - (y as number) : String(x).localeCompare(String(y)));
      });
    setRows(found);
    setDone(true);
  };

  const fetchPage = async (after: QueryDocumentSnapshot | null) => {
    if (!uid()) return;
    setLoading(true);
    setError(null);
    try {
      if (words.length) { await fetchSearch(); return; }
      const clauses = [];
      if (filter.month) clauses.push(where("month", "==", filter.month));
      if (filter.category) clauses.push(where("category", "==", filter.category));
      if (filter.accountId) clauses.push(where("accountId", "==", filter.accountId));
      if (!filter.includeTransfers && !filter.category) clauses.push(where("isTransfer", "==", false));
      const snapshot = await getDocs(query(userCol("transactions"), ...clauses,
        orderBy(field, direction), ...(after ? [startAfter(after)] : []), qLimit(PAGE)));
      const page = snapshot.docs.map((d) => d.data() as Txn);
      setRows((prev) => (after ? [...prev, ...page] : page));
      setCursor(snapshot.docs[snapshot.docs.length - 1] ?? null);
      setDone(page.length < PAGE);
    } catch (e) {
      setError((e as Error).message);
      setDone(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setRows([]); setCursor(null); setDone(false);
    void fetchPage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /** Swap in an edited row without refetching the page. */
  const patch = (next: Txn) => setRows((prev) => prev.map((t) => (t.txnId === next.txnId ? next : t)));

  return {
    rows, loading, done, error, patch,
    more: () => { if (!done && !loading) void fetchPage(cursor); },
    reload: () => void fetchPage(null),
  };
}

/**
 * Month totals for the transactions a search matches, shaped like the stored
 * ones so the dashboard renders them the same way. Computed on the phone from
 * one query: a search covers too few transactions to be worth storing totals
 * for, and the words are arbitrary.
 */
export function useSearchTotals(q: string | null | undefined, months: string[]) {
  const [totals, setTotals] = useState<Map<string, MonthTotals> | null>(null);
  const words = searchWords(q);
  const key = `${words.join(" ")}|${months[months.length - 1]}`;
  useEffect(() => {
    if (!uid() || !words.length || !months.length) { setTotals(null); return; }
    let live = true;
    void getDocs(query(userCol("transactions"), where("search", "array-contains", words[0]!),
      where("date", ">=", `${months[months.length - 1]}-01`), orderBy("date", "desc"), qLimit(SEARCH_CAP)))
      .then((snapshot) => {
        const deltas = new Map<string, Delta>();
        for (const d of snapshot.docs) {
          const t = d.data() as Txn;
          if (!matches(t, words)) continue;
          let delta = deltas.get(t.month);
          if (!delta) { delta = emptyDelta(); deltas.set(t.month, delta); }
          fold(delta, t, 1);
        }
        const plain = (p: Part) => ({
          total: round2(p.total), income: round2(p.income), txnCount: p.count,
          byCategory: Object.fromEntries([...p.byCategory].map(([c, v]) => [c, round2(v)])),
        });
        if (live) {
          setTotals(new Map([...deltas].map(([month, delta]) => [month, {
            month, ...plain(delta),
            byAccount: Object.fromEntries([...delta.byAccount].map(([a, p]) => [a, plain(p)])),
          }])));
        }
      })
      .catch(() => { if (live) setTotals(new Map()); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return totals;
}

// --- writes ------------------------------------------------------------------

/**
 * Recategorise. "merchant" covers that merchant's past and future - the answer
 * becomes an override the sync respects; "one" changes just this transaction,
 * for things like a single Zelle payment that was dinner.
 */
export async function setCategory(
  target: Txn, category: string, scope: "merchant" | "one",
): Promise<number> {
  const isTransfer = category === "Transfer";
  const docs = scope === "one"
    ? await oneTxn(target.txnId)
    : (await getDocs(query(userCol("transactions"),
        where("merchantKey", "==", target.merchantKey)))).docs;
  const edited = await editTxns(docs, (t) =>
    t.category === category && t.categorySource === (scope === "one" ? "manual" : "override")
      ? null
      : { ...t, category, isTransfer, categorySource: scope === "one" ? "manual" : "override" });
  if (scope === "merchant") await setDoc(userRef("overrides", target.merchantKey), { category });
  return edited;
}

/**
 * Record somebody else's share of a bill you fronted. `myShare` is the fraction
 * you keep (0.5 = half, 0 = none of it was yours); `owed` is a flat amount.
 * `everyCharge` makes it a standing rule the sync applies to future charges.
 */
export async function setSplit(target: Txn, opts: {
  myShare?: number; owed?: number; note?: string; everyCharge?: boolean;
}): Promise<number> {
  const note = opts.note?.trim() || null;
  if (opts.everyCharge) {
    if (opts.myShare == null) throw new Error("A standing split needs a share, not a dollar amount.");
    await setDoc(userRef("splitRules", target.merchantKey), { myShare: opts.myShare, note });
    const docs = (await getDocs(query(userCol("transactions"),
      where("merchantKey", "==", target.merchantKey)))).docs;
    return editTxns(docs, (t) => {
      // settled ones are history; a hand-set split on another charge outranks the rule
      if (t.splitSettled || (t.splitSource === "manual" && t.txnId !== target.txnId)) return null;
      return { ...t, splitOwed: round2(t.amount * (1 - opts.myShare!)), splitNote: note,
               splitSource: t.txnId === target.txnId ? "manual" : "rule" };
    });
  }
  const owed = opts.owed != null ? round2(opts.owed) : round2(target.amount * (1 - (opts.myShare ?? 1)));
  if (owed < 0 || owed > target.amount) throw new Error("That is more than the charge.");
  return editTxns(await oneTxn(target.txnId),
    (t) => ({ ...t, splitOwed: owed, splitNote: note, splitSource: "manual" }));
}

export async function clearSplit(target: Txn, dropRule: boolean): Promise<void> {
  await editTxns(await oneTxn(target.txnId),
    (t) => ({ ...t, splitOwed: 0, splitNote: null, splitSource: null, splitSettled: false }));
  if (dropRule) await deleteDoc(userRef("splitRules", target.merchantKey));
}

/** Paid back. The split stays - it still is not your spend - but stops showing as owed. */
export const markSettled = async (target: Txn, settled = true) =>
  editTxns(await oneTxn(target.txnId), (t) => ({ ...t, splitSettled: settled }));

export async function setCashback(target: Txn, opts: {
  percent?: number; amount?: number; payout: string; source: string; received: boolean;
}): Promise<void> {
  const value = opts.percent != null ? round2(target.amount * opts.percent / 100) : round2(opts.amount ?? 0);
  if (!(value > 0) || value > target.amount) {
    throw new Error(`Cashback must be between $0 and the $${target.amount.toFixed(2)} spent.`);
  }
  await editTxns(await oneTxn(target.txnId), (t) => ({
    ...t, cashback: value, cashbackPct: opts.percent ?? null, cashbackPayout: opts.payout,
    cashbackSource: opts.source.trim() || "Rakuten", cashbackReceived: opts.received,
  }));
}

export const clearCashback = async (target: Txn) =>
  editTxns(await oneTxn(target.txnId), (t) => ({
    ...t, cashback: 0, cashbackPct: null, cashbackPayout: null, cashbackSource: null,
    cashbackReceived: false,
  }));

export const markCashbackReceived = async (target: Txn) =>
  editTxns(await oneTxn(target.txnId), (t) => ({ ...t, cashbackReceived: true }));

export async function setBudget(category: string, monthly: number | null): Promise<void> {
  if (monthly == null || !(monthly > 0)) await deleteDoc(userRef("budgets", category));
  else await setDoc(userRef("budgets", category), { monthly: round2(monthly) });
}
