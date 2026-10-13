/** Money and date formatting, matching the web dashboard so the two never disagree. */

const whole = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0,
});
const cents = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
});

/** Large figures lose the cents: "$8,874" reads faster than "$8,874.31". */
export const money = (value: number): string =>
  (Math.abs(value) >= 1000 ? whole : cents).format(value);
export const money0 = (value: number): string => whole.format(value);
export const moneyExact = (value: number): string => cents.format(value);

export const monthName = (month: string, withYear = false): string => {
  const [year, m] = month.split("-");
  const d = new Date(Number(year), Number(m) - 1, 1);
  return d.toLocaleDateString("en-US", withYear ? { month: "long", year: "numeric" } : { month: "short" });
};

export const shortDate = (date: string): string => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

/**
 * How far through `month` today is. 1 for any month that is over. Local time,
 * deliberately - toISOString() is UTC, and in New York after 8pm on the last of
 * the month it would already report the next one.
 */
export function monthProgress(month: string): number {
  const now = new Date();
  const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  if (month !== current) return 1;
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return now.getDate() / days;
}

export const daysUntil = (date: string): number => {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(y!, m! - 1, d!).getTime();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((target - today.getTime()) / 86_400_000);
};
