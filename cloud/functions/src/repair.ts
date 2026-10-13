/**
 * Rebuild every derived figure from the transactions themselves.
 *
 * Running totals are maintained by deltas, and an earlier version wrote those
 * deltas with dotted keys under set+merge - which Firestore stores as literal
 * field names, so they never reached the totals and the sync cursor never
 * advanced. This undoes that, and is the general way back from any drift:
 *
 *   - one read of every transaction
 *   - every month's totals rewritten whole (a plain set, which also drops junk)
 *   - totals documents for months with no transactions deleted
 *   - dotted-name debris removed from the private Plaid document
 *   - insights computed from the same in-memory list, at no extra reads
 */

import { Firestore, FieldValue } from "firebase-admin/firestore";

import { findRecurring, findReview } from "./insights";
import {
  Delta, Txn, emptyDelta, fold, isP2P, privateDoc, removeDottedFields, round2, searchTerms,
  totalsValue, txnCol, userDoc,
} from "./model";

export async function rebuildAll(db: Firestore, uid: string) {
  const user = userDoc(db, uid);
  const [txnSnap, totalsSnap] = await Promise.all([
    txnCol(db, uid).get(),
    user.collection("totals").get(),
  ]);
  const txns = txnSnap.docs.map((d) => d.data() as Txn);

  const months = new Map<string, Delta>();
  for (const t of txns) {
    let delta = months.get(t.month);
    if (!delta) { delta = emptyDelta(); months.set(t.month, delta); }
    fold(delta, t, 1);
  }

  let batch = db.batch();
  let pending = 0;
  const commit = async () => { if (pending) await batch.commit(); batch = db.batch(); pending = 0; };

  for (const [month, delta] of months) {
    batch.set(user.collection("totals").doc(month),
      { ...totalsValue(month, delta), updatedAt: FieldValue.serverTimestamp() });
    if (++pending >= 450) await commit();
  }
  for (const doc of totalsSnap.docs) {
    if (!months.has(doc.id)) {
      batch.delete(doc.ref);
      if (++pending >= 450) await commit();
    }
  }

  // Transactions written by an older version lack fields added since. They are
  // already in memory, so backfilling costs writes for the stragglers only and
  // no extra reads.
  let backfilled = 0;
  for (const doc of txnSnap.docs) {
    const t = doc.data() as Partial<Txn>;
    if (t.p2p === undefined || t.cashbackReceived === undefined || t.search === undefined) {
      batch.set(doc.ref, {
        p2p: isP2P(t.name ?? null, t.merchantKey ?? ""),
        search: searchTerms({
          name: t.name ?? null, merchantName: t.merchantName ?? null, merchantKey: t.merchantKey ?? "",
        }),
        cashbackPct: t.cashbackPct ?? null,
        cashbackPayout: t.cashbackPayout ?? null,
        cashbackSource: t.cashbackSource ?? null,
        cashbackReceived: t.cashbackReceived ?? false,
      }, { merge: true });
      backfilled++;
      if (++pending >= 450) await commit();
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const recurring = findRecurring(txns, today);
  const review = findReview(txns);
  batch.set(user.collection("insights").doc("current"), {
    recurring,
    recurringMonthly: round2(recurring.reduce((sum, r) => sum + r.monthly, 0)),
    review,
    computedAt: FieldValue.serverTimestamp(),
    computedFrom: txns.length,
    schema: SCHEMA,
  });
  pending++;
  await commit();

  const removed = await removeDottedFields(privateDoc(db, uid));
  return {
    transactions: txns.length,
    months: months.size,
    recurring: recurring.length,
    review: review.length,
    junkRemoved: removed.length,
    backfilled,
  };
}

/**
 * Bumped whenever stored data gains something only a full rebuild can fill in
 * for existing transactions. 2: per-account totals and search terms.
 */
const SCHEMA = 2;

/**
 * True when the private document carries debris from the dotted-key bug, or
 * the data was last rebuilt under an older schema. The schema is recorded by
 * the rebuild itself: inferring it from the data misleads, because an
 * incremental sync writes the new fields for new transactions only.
 */
export async function needsRepair(db: Firestore, uid: string): Promise<boolean> {
  const [plaid, insights] = await Promise.all([
    privateDoc(db, uid).get(),
    userDoc(db, uid).collection("insights").doc("current").get(),
  ]);
  if (Object.keys(plaid.data() ?? {}).some((key) => key.includes("."))) return true;
  return (insights.get("schema") ?? 1) < SCHEMA;
}
