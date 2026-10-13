/**
 * The ~1KB spend snapshot SpendWatch reads before you buy something.
 *
 * The same shape the laptop's /api/snapshot publishes, built from the totals
 * documents instead of SQL: this month and last month per category, plus
 * budgets. Aggregates only - no transactions, merchants or account numbers -
 * because the Worker it goes to is on the public internet.
 */

import { Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";

import { MonthTotals, round2, totalsDoc, userDoc } from "./model";

// Months turn over at local midnight, not UTC's: at 9pm in New York on the
// 31st, UTC is already in next month.
const TIME_ZONE = "America/New_York";

function localDate(now: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

const ym = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

/** The two months a snapshot reads, in local time. */
export function snapshotMonths(now = new Date()): { current: string; previous: string } {
  const { year, month } = localDate(now);
  return { current: ym(year, month), previous: month === 1 ? ym(year - 1, 12) : ym(year, month - 1) };
}

export async function buildSnapshot(db: Firestore, uid: string, now = new Date()) {
  const { year, month, day } = localDate(now);
  const { current, previous } = snapshotMonths(now);

  const [cur, prev, budgetSnap] = await Promise.all([
    totalsDoc(db, uid, current).get(),
    totalsDoc(db, uid, previous).get(),
    userDoc(db, uid).collection("budgets").get(),
  ]);
  const spent = (cur.data() as MonthTotals | undefined)?.byCategory ?? {};
  const last = (prev.data() as MonthTotals | undefined)?.byCategory ?? {};
  const budgets = new Map(budgetSnap.docs.map((d) => [d.id, d.get("monthly") as number]));

  const categories = [...new Set([...Object.keys(spent), ...Object.keys(last), ...budgets.keys()])]
    .map((category) => ({
      category,
      spent: round2(spent[category] ?? 0),
      last_month: round2(last[category] ?? 0),
      budget: budgets.get(category) ?? null,
    }))
    .filter((c) => c.spent || c.last_month || c.budget)
    .sort((a, b) => b.spent - a.spent);

  return {
    generated_at: now.toISOString(),
    month: current,
    day_of_month: day,
    days_in_month: new Date(Date.UTC(year, month, 0)).getUTCDate(),
    total: round2(categories.reduce((sum, c) => sum + c.spent, 0)),
    categories,
  };
}

/**
 * PUT the snapshot to the Worker. Never throws: a failed publish leaves the
 * phone showing the previous snapshot, which beats failing the sync over it.
 */
export async function publishSnapshot(
  db: Firestore, uid: string, url: string, token: string,
): Promise<void> {
  if (!url || !token) return;
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        // Cloudflare refuses requests with no recognisable agent (error 1010)
        "User-Agent": "spendtrack/1.0",
      },
      body: JSON.stringify(await buildSnapshot(db, uid)),
    });
    if (!response.ok) logger.warn("snapshot publish refused", { status: response.status });
  } catch (error) {
    logger.warn("snapshot publish failed", { error: String(error) });
  }
}
