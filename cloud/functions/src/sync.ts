/**
 * Pull from Plaid into Firestore.
 *
 * Written for the read and write quotas rather than for brevity:
 *
 *   - the cursor means a quiet day transfers nothing and costs one request
 *   - overrides and the merchant cache are read once per sync, not per
 *     transaction, so categorising 500 transactions is 2 reads rather than 1000
 *   - writes go in batches of 500, Firestore's hard limit per batch
 *   - month totals accumulate in memory and land as one write per month
 *
 * A sync of 1,431 transactions across 21 months costs roughly 25 writes for the
 * totals and 3 batched commits for the transactions, not 1,431 of each.
 */

import { Firestore, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";

import { merchantKey, resolve } from "./categorize";
import { needsRepair, rebuildAll } from "./repair";
import {
  TotalsAccumulator, Txn, isP2P, netOf, privateDoc, round2, searchTerms, totalsDoc, txnCol, userDoc,
} from "./model";
import {
  CreditLiability, PlaidAccount, PlaidConfig, PlaidError, PlaidTransaction,
  accountsGet, liabilities, transactionsSync,
} from "./plaid";

const BATCH_LIMIT = 500;

export interface Item {
  itemId: string;
  accessToken: string;
  institutionId: string | null;
  institutionName: string | null;
  cursor: string | null;
  status: "ok" | "login_required";
}

export interface SyncOutcome {
  institution: string;
  added: number;
  modified: number;
  removed: number;
  error?: string;
}

/** Plaid's authorized_date is when you spent; date is when it posted. */
const spentOn = (t: PlaidTransaction): string => t.authorized_date || t.date;

function toTxn(
  t: PlaidTransaction,
  overrides: ReadonlyMap<string, string>,
  cache: ReadonlyMap<string, string>,
): Txn {
  const date = spentOn(t);
  const key = merchantKey(t.name, t.merchant_name);
  const plaidCategory = t.personal_finance_category?.primary ?? null;
  const { category, source, isTransfer } = resolve(key, t.name, plaidCategory, overrides, cache);

  const base = {
    amount: round2(t.amount),
    cashback: 0,
    splitOwed: 0,
  };
  return {
    txnId: t.transaction_id,
    accountId: t.account_id,
    date,
    month: date.slice(0, 7),
    name: t.name,
    merchantName: t.merchant_name,
    merchantKey: key,
    ...base,
    cashbackPct: null,
    cashbackPayout: null,
    cashbackSource: null,
    cashbackReceived: false,
    splitNote: null,
    splitSource: null,
    splitSettled: false,
    net: netOf(base),
    isoCurrency: t.iso_currency_code,
    pending: Boolean(t.pending),
    plaidCategory,
    category,
    categorySource: source,
    isTransfer,
    p2p: isP2P(t.name, key),
    logoUrl: t.logo_url,
    search: searchTerms({ name: t.name, merchantName: t.merchant_name, merchantKey: key }),
  };
}

/**
 * Carry forward what belongs to you, not to Plaid.
 *
 * A modified transaction arrives from Plaid without the cashback you marked,
 * the split you set or the category you corrected. Overwriting it wholesale
 * would silently undo that work, which is the kind of loss nobody notices until
 * the totals look wrong months later.
 */
function preserveLocalEdits(incoming: Txn, existing: Txn): Txn {
  const merged: Txn = {
    ...incoming,
    cashback: existing.cashback ?? 0,
    cashbackPct: existing.cashbackPct ?? null,
    cashbackPayout: existing.cashbackPayout ?? null,
    cashbackSource: existing.cashbackSource ?? null,
    cashbackReceived: existing.cashbackReceived ?? false,
    splitOwed: existing.splitOwed ?? 0,
    splitNote: existing.splitNote ?? null,
    splitSource: existing.splitSource ?? null,
    splitSettled: existing.splitSettled ?? false,
  };
  if (existing.categorySource === "override" || existing.categorySource === "manual") {
    merged.category = existing.category;
    merged.categorySource = existing.categorySource;
    merged.isTransfer = existing.isTransfer;
  }
  merged.net = netOf(merged);
  return merged;
}

async function lookupTables(db: Firestore, uid: string) {
  // Three collection reads for the whole sync, however many transactions it holds.
  const [overrideSnap, cacheSnap, splitSnap] = await Promise.all([
    userDoc(db, uid).collection("overrides").get(),
    userDoc(db, uid).collection("merchantCache").get(),
    userDoc(db, uid).collection("splitRules").get(),
  ]);
  const overrides = new Map<string, string>();
  overrideSnap.forEach((d) => overrides.set(d.id, d.get("category") as string));
  const cache = new Map<string, string>();
  cacheSnap.forEach((d) => cache.set(d.id, d.get("category") as string));
  const splitRules = new Map<string, { myShare: number; note: string | null }>();
  splitSnap.forEach((d) => splitRules.set(d.id, {
    myShare: Number(d.get("myShare")), note: (d.get("note") as string | null) ?? null,
  }));
  return { overrides, cache, splitRules };
}

/**
 * A standing split - rent with a flatmate - applied to a charge that has none.
 * A split set by hand on that one transaction outranks the rule, the same way a
 * category correction outranks a categorisation rule. Credits split too: a
 * refund on a shared bill is half theirs.
 */
function applySplitRule(
  t: Txn, rules: ReadonlyMap<string, { myShare: number; note: string | null }>,
): Txn {
  const rule = rules.get(t.merchantKey);
  if (!rule || t.splitSource === "manual" || t.splitSettled) return t;
  const splitOwed = round2(t.amount * (1 - rule.myShare));
  const next = { ...t, splitOwed, splitNote: rule.note, splitSource: "rule" };
  return { ...next, net: netOf(next) };
}

export async function syncItem(
  db: Firestore,
  uid: string,
  config: PlaidConfig,
  item: Item,
): Promise<SyncOutcome> {
  const label = item.institutionName || item.itemId;
  const result = await transactionsSync(config, item.accessToken, item.cursor);

  const touched = [...result.added, ...result.modified];
  const totals = new TotalsAccumulator();

  if (touched.length || result.removed.length) {
    const { overrides, cache, splitRules } = await lookupTables(db, uid);

    // One read for everything being written, rather than a read per document.
    // getAll takes refs in bulk and is the cheapest way to learn what exists.
    const ids = [...new Set([...touched.map((t) => t.transaction_id), ...result.removed])];
    const existing = new Map<string, Txn>();
    for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
      const refs = ids.slice(i, i + BATCH_LIMIT).map((id) => txnCol(db, uid).doc(id));
      const docs = await db.getAll(...refs);
      for (const doc of docs) if (doc.exists) existing.set(doc.id, doc.data() as Txn);
    }

    let writes = db.batch();
    let pending = 0;
    const commit = async () => {
      if (pending) await writes.commit();
      writes = db.batch();
      pending = 0;
    };

    for (const raw of touched) {
      const previous = existing.get(raw.transaction_id);
      let next = toTxn(raw, overrides, cache);
      if (previous) next = preserveLocalEdits(next, previous);
      next = applySplitRule(next, splitRules);
      if (previous) totals.replace(previous, next);
      else totals.add(next);
      writes.set(txnCol(db, uid).doc(next.txnId), next);
      if (++pending >= BATCH_LIMIT) await commit();
    }

    for (const id of result.removed) {
      const previous = existing.get(id);
      if (previous) totals.remove(previous);
      writes.delete(txnCol(db, uid).doc(id));
      if (++pending >= BATCH_LIMIT) await commit();
    }
    await commit();
  }

  await totals.flush(db, uid);
  await upsertAccounts(db, uid, item.itemId, result.accounts);

  // The cursor is written only after everything it produced has landed, so an
  // interrupted run replays the same page rather than skipping it.
  // Nested, not dotted: set+merge treats "items.X.cursor" as a literal field
  // name, which left every earlier sync restarting from the same cursor.
  await privateDoc(db, uid).set({
    items: {
      [item.itemId]: {
        cursor: result.cursor,
        status: "ok",
        lastSyncedAt: FieldValue.serverTimestamp(),
      },
    },
  }, { merge: true });

  return {
    institution: label,
    added: result.added.length,
    modified: result.modified.length,
    removed: result.removed.length,
  };
}

async function upsertAccounts(
  db: Firestore, uid: string, itemId: string, accounts: PlaidAccount[],
): Promise<void> {
  if (!accounts.length) return;
  const writes = db.batch();
  for (const a of accounts) {
    writes.set(userDoc(db, uid).collection("accounts").doc(a.account_id), {
      accountId: a.account_id,
      itemId,
      name: a.name,
      officialName: a.official_name,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
      currentBalance: a.balances.current,
      availableBalance: a.balances.available,
      creditLimit: a.balances.limit,
      isoCurrency: a.balances.iso_currency_code,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await writes.commit();
}

export async function syncLiabilities(
  db: Firestore, uid: string, config: PlaidConfig, accessToken: string,
): Promise<number> {
  const cards: CreditLiability[] = await liabilities(config, accessToken);
  if (!cards.length) return 0;
  const writes = db.batch();
  for (const card of cards) {
    const aprs = card.aprs ?? [];
    const purchase = aprs.find((a) => a.apr_type === "purchase_apr") ?? aprs[0];
    writes.set(userDoc(db, uid).collection("accounts").doc(card.account_id), {
      lastStatementBalance: card.last_statement_balance,
      lastStatementDate: card.last_statement_issue_date,
      nextPaymentDueDate: card.next_payment_due_date,
      minimumPayment: card.minimum_payment_amount,
      aprPercentage: purchase?.apr_percentage ?? null,
      isOverdue: Boolean(card.is_overdue),
    }, { merge: true });
  }
  await writes.commit();
  return cards.length;
}

// A week, matching the Sunday recount: inside that, a change waits for it.
const INSIGHTS_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sync every linked institution. One failing item must not stop the others.
 *
 * `rebuild` decides whether to finish with a full read of every transaction
 * (rebuilding totals and recomputing insights). The Sunday scheduled sync does;
 * the other days and a manual sync do not, because each full read is ~1,800 documents against a
 * 50,000-a-day quota, and the running totals are kept right by deltas anyway.
 * Any sync still rebuilds when repair is needed or insights have gone stale.
 */
export async function syncAll(
  db: Firestore, uid: string, config: PlaidConfig, rebuild = false,
): Promise<SyncOutcome[]> {
  const snapshot = await privateDoc(db, uid).get();
  const items = (snapshot.get("items") ?? {}) as Record<string, Omit<Item, "itemId">>;
  const outcomes: SyncOutcome[] = [];

  for (const [itemId, stored] of Object.entries(items)) {
    const item: Item = { itemId, ...stored };
    try {
      const outcome = await syncItem(db, uid, config, item);
      await syncLiabilities(db, uid, config, item.accessToken);
      outcomes.push(outcome);
    } catch (error) {
      const message = error instanceof PlaidError
        ? `${error.code}: ${error.message}` : String(error);
      logger.error("sync failed", { itemId, message });
      // The user changed a password or MFA expired; Link must be re-run in
      // update mode, which costs no Item.
      if (error instanceof PlaidError && error.code === "ITEM_LOGIN_REQUIRED") {
        await privateDoc(db, uid).set(
          { items: { [itemId]: { status: "login_required" } } }, { merge: true },
        );
      }
      outcomes.push({
        institution: item.institutionName || itemId,
        added: 0, modified: 0, removed: 0,
        error: message.slice(0, 200),
      });
    }
  }

  await userDoc(db, uid).set({
    lastSyncAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  let shouldRebuild = rebuild || await needsRepair(db, uid);
  if (!shouldRebuild && outcomes.some((o) => o.added || o.modified || o.removed)) {
    const insights = await userDoc(db, uid).collection("insights").doc("current").get();
    const at = insights.get("computedAt")?.toMillis?.() ?? 0;
    shouldRebuild = Date.now() - at > INSIGHTS_STALE_MS;
  }
  if (shouldRebuild) {
    const rebuilt = await rebuildAll(db, uid);
    logger.info("rebuilt", { uid, ...rebuilt });
  }
  return outcomes;
}

export { totalsDoc };
