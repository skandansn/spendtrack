/**
 * Purchases paid through PayPal arrive twice.
 *
 * Pay with PayPal funded by the Amex and the purchase lands once in PayPal
 * ("Ouraring Inc.", $6.36) and once on the card ("Wea", $6.36). Plaid says
 * which card charges went through PayPal - payment_meta.payment_processor and
 * a "payment_app" counterparty, behind a descriptor of "PAYPAL *OURARING..." -
 * so nothing here guesses from names or amounts.
 *
 * With PayPal linked, its history holds every one of those purchases, under the
 * merchant's real name. So the card's copy is the one set aside: marked
 * `duplicateOf: "paypal"`, it drops out of every total. Purchases paid from the
 * PayPal balance or the PayPal debit card only ever appear in PayPal and count
 * as normal. Card charges older than the start of PayPal's history keep
 * counting, because PayPal's copy of them never arrived.
 */

import { Firestore } from "firebase-admin/firestore";

import { PlaidTransaction } from "./plaid";
import { Txn, userDoc } from "./model";

export const COUNTED_IN_PAYPAL = "paypal";

/** Plaid's own word that this charge was processed by PayPal. */
export const viaPayPal = (t: Pick<PlaidTransaction, "payment_meta" | "counterparties">): boolean =>
  /paypal/i.test(t.payment_meta?.payment_processor ?? "")
  || (t.counterparties ?? []).some((c) => c.type === "payment_app" && /paypal/i.test(c.name ?? ""));

export const isPayPalInstitution = (name: string | null | undefined): boolean => /paypal/i.test(name ?? "");

/** The accounts that belong to a linked PayPal. */
export async function paypalAccounts(db: Firestore, uid: string): Promise<Set<string>> {
  const user = userDoc(db, uid);
  const institutions = await user.collection("institutions").get();
  const items = institutions.docs.filter((d) => isPayPalInstitution(d.get("name"))).map((d) => d.id);
  if (!items.length) return new Set();
  const accounts = await user.collection("accounts").where("itemId", "in", items).get();
  return new Set(accounts.docs.map((d) => d.id));
}

/**
 * What `duplicateOf` should be for each transaction, given all of them: the
 * PayPal marker for card charges PayPal also holds, null for everything else.
 */
export function settleDuplicates(txns: readonly Txn[], paypal: ReadonlySet<string>): Map<string, string | null> {
  let since: string | null = null;
  for (const t of txns) {
    if (paypal.has(t.accountId) && (since === null || t.date < since)) since = t.date;
  }
  const result = new Map<string, string | null>();
  for (const t of txns) {
    const counted = since !== null && !paypal.has(t.accountId) && Boolean(t.viaPayPal) && t.date >= since;
    result.set(t.txnId, counted ? COUNTED_IN_PAYPAL : null);
  }
  return result;
}
