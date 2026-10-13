/**
 * Recurring charges and the review queue, precomputed.
 *
 * Both need a GROUP BY over the whole transaction history, which Firestore
 * cannot do on read. Computed on the client they would cost a read per
 * transaction every time the app opened; computed here after a sync, they cost
 * one full read per day and one document read per app open.
 */

import { Firestore, FieldValue } from "firebase-admin/firestore";

import { Txn, countsAsSpend, round2, txnCol, userDoc } from "./model";

/** name, min gap, max gap (days), and how many of them make a month */
const CADENCES: [string, number, number, number][] = [
  ["weekly", 5, 9, 52 / 12],
  ["monthly", 26, 35, 1],
  ["yearly", 350, 380, 1 / 12],
];

const DAY = 86_400_000;
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const addDays = (date: string, n: number) =>
  new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);

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

/**
 * Merchants charging a steady amount on a steady schedule, still active.
 *
 * Needs three or more charges - two for yearly, since three would take over two
 * years to appear. The median gap picks the cadence, and the recent gaps and
 * amounts must all sit near their medians - otherwise a coffee shop visited
 * most weeks would pass as a weekly subscription.
 */
export function findRecurring(txns: Txn[], today: string): Recurring[] {
  const since = addDays(today, -760);
  // one charge per merchant per day: two posts on the same day are one payment
  const byMerchant = new Map<string, Map<string, { amount: number; t: Txn }>>();
  for (const t of txns) {
    if (!countsAsSpend(t) || t.amount <= 0 || t.date < since) continue;
    const dates = byMerchant.get(t.merchantKey) ?? new Map();
    const day = dates.get(t.date);
    dates.set(t.date, { amount: (day?.amount ?? 0) + t.amount, t: day?.t ?? t });
    byMerchant.set(t.merchantKey, dates);
  }

  const found: Recurring[] = [];
  for (const [key, dated] of byMerchant) {
    if (dated.size < 2) continue;
    const charges = [...dated.entries()].sort(([a], [b]) => a.localeCompare(b));
    const dates = charges.map(([d]) => d);
    const gaps = dates.slice(1).map((d, i) => days(dates[i]!, d));
    const gap = median(gaps);
    const cadence = CADENCES.find(([, lo, hi]) => gap >= lo && gap <= hi);
    if (!cadence || (charges.length < 3 && cadence[0] !== "yearly")) continue;
    if (gaps.slice(-4).some((g) => Math.abs(g - gap) > gap * 0.35)) continue;

    const amounts = charges.slice(-4).map(([, c]) => c.amount);
    const typical = median(amounts);
    if (Math.max(...amounts) > typical * 1.25 || Math.min(...amounts) < typical * 0.75) continue;

    const last = dates[dates.length - 1]!;
    if (days(last, today) > gap * 1.5) continue;   // stopped: cancelled, or moved card

    const latest = charges[charges.length - 1]![1].t;
    found.push({
      merchantKey: key,
      merchantName: latest.merchantName,
      logoUrl: latest.logoUrl,
      category: latest.category,
      cadence: cadence[0],
      amount: round2(typical),
      monthly: round2(typical * cadence[3]),
      lastDate: last,
      nextDate: addDays(last, Math.round(gap)),
      charges: charges.length,
    });
  }
  return found.sort((a, b) => a.nextDate.localeCompare(b.nextDate));
}

/**
 * Merchants whose category is only a fallback - Plaid's coarse guess, or
 * nothing - because no rule matched and no model was confident. Biggest spend
 * first. One answer per merchant settles every transaction it has.
 */
export function findReview(txns: Txn[], limit = 50): ReviewItem[] {
  const groups = new Map<string, ReviewItem & { weight: number }>();
  for (const t of txns) {
    if (t.isTransfer || !["uncategorized", "plaid"].includes(t.categorySource)) continue;
    const g = groups.get(t.merchantKey);
    if (!g) {
      groups.set(t.merchantKey, {
        merchantKey: t.merchantKey, name: t.name, merchantName: t.merchantName,
        logoUrl: t.logoUrl, category: t.category, categorySource: t.categorySource,
        txns: 1, amount: t.amount, lastDate: t.date, weight: Math.abs(t.amount),
      });
    } else {
      g.txns += 1;
      g.amount += t.amount;
      g.weight += Math.abs(t.amount);
      if (t.date > g.lastDate) g.lastDate = t.date;
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map(({ weight: _weight, ...item }) => ({ ...item, amount: round2(item.amount) }));
}

export async function computeInsights(db: Firestore, uid: string) {
  const snapshot = await txnCol(db, uid).get();
  const txns = snapshot.docs.map((d) => d.data() as Txn);
  const today = new Date().toISOString().slice(0, 10);
  const recurring = findRecurring(txns, today);
  const review = findReview(txns);
  await userDoc(db, uid).collection("insights").doc("current").set({
    recurring,
    recurringMonthly: round2(recurring.reduce((sum, r) => sum + r.monthly, 0)),
    review,
    computedAt: FieldValue.serverTimestamp(),
    computedFrom: txns.length,
  });
  return { recurring: recurring.length, review: review.length, read: txns.length };
}
