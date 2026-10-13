/**
 * One-off import of the laptop's database.
 *
 * Moves the Plaid access tokens with their cursors, so each institution's sync
 * continues from where the laptop stopped: no refetch, and no re-linking, which
 * would permanently spend Plaid Items. Every transaction comes across with the
 * edits made locally - splits, cashback, corrected categories - intact.
 *
 * Safe to run twice. Documents are written by id, so a repeat overwrites rather
 * than duplicates; totals are rebuilt from the transactions afterwards rather
 * than incremented, so they cannot double; and an edit made in the cloud since
 * the first import - a category, a split, cashback - wins over the laptop's
 * older copy, so a re-import cannot quietly undo it.
 */

import { Firestore, FieldValue } from "firebase-admin/firestore";

import { Txn, isP2P, netOf, privateDoc, round2, searchTerms, txnCol, userDoc } from "./model";
import { rebuildAll } from "./repair";

const BATCH_LIMIT = 500;

/** SQLite named the model cache 'llm'; the cloud calls the same thing 'cache'. */
const SOURCE: Record<string, string> = { llm: "cache" };

interface Exported {
  version: number;
  items: Record<string, unknown>[];
  accounts: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  overrides: { merchant_key: string; category: string }[];
  merchantCache: { merchant_key: string; category: string; model: string | null }[];
  budgets: { category: string; monthly: number }[];
  splitRules: { merchant_key: string; my_share: number; note: string | null }[];
}

const str = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const bool = (v: unknown): boolean => Boolean(Number(v));

/**
 * Firestore document ids cannot be "." or "..", contain "/", or look like
 * __reserved__. Merchant keys are normalised to letters, digits, "&", "." and
 * spaces, so only the first rule can bite - but an id that fails here would
 * abort a whole batch, so it is checked rather than assumed.
 */
const safeId = (id: string): boolean =>
  id.length > 0 && id !== "." && id !== ".." && !id.includes("/") && !/^__.*__$/.test(id);

class Writer {
  private batch;
  private pending = 0;
  written = 0;

  constructor(private readonly db: Firestore) {
    this.batch = db.batch();
  }

  async set(ref: FirebaseFirestore.DocumentReference, data: object, merge = false) {
    this.batch.set(ref, data, { merge });
    if (++this.pending >= BATCH_LIMIT) await this.flush();
  }

  async flush() {
    if (this.pending) {
      await this.batch.commit();
      this.written += this.pending;
    }
    this.batch = this.db.batch();
    this.pending = 0;
  }
}

export async function importData(db: Firestore, uid: string, data: Exported) {
  if (data?.version !== 1 || !Array.isArray(data.transactions)) {
    throw new Error("Not a spendtrack export (expected version 1).");
  }
  const user = userDoc(db, uid);
  const out = new Writer(db);
  let skipped = 0;

  // The tokens go to `private`, which the rules deny to every client. The
  // display copy beside it carries no token.
  // A cursor the cloud has already moved past is newer than the laptop's; going
  // back to the laptop's would only refetch what is already here.
  const existingItems = ((await privateDoc(db, uid).get()).get("items") ?? {}) as
    Record<string, { cursor?: string | null }>;
  const items: Record<string, object> = {};
  for (const i of data.items) {
    const itemId = String(i.item_id);
    items[itemId] = {
      accessToken: str(i.access_token),
      institutionId: str(i.institution_id),
      institutionName: str(i.institution_name),
      cursor: existingItems[itemId]?.cursor || str(i.cursor),
      status: str(i.status) ?? "ok",
    };
    await out.set(user.collection("institutions").doc(itemId), {
      itemId,
      name: str(i.institution_name),
      logo: str(i.institution_logo),
      color: str(i.institution_color),
      status: str(i.status) ?? "ok",
    }, true);
  }
  await out.set(privateDoc(db, uid), { items }, true);

  for (const a of data.accounts) {
    await out.set(user.collection("accounts").doc(String(a.account_id)), {
      accountId: str(a.account_id),
      itemId: str(a.item_id),
      name: str(a.name),
      officialName: str(a.official_name),
      mask: str(a.mask),
      type: str(a.type),
      subtype: str(a.subtype),
      currentBalance: num(a.current_balance),
      availableBalance: num(a.available_balance),
      creditLimit: num(a.credit_limit),
      isoCurrency: str(a.iso_currency),
      lastStatementBalance: num(a.last_statement_balance),
      lastStatementDate: str(a.last_statement_date),
      nextPaymentDueDate: str(a.next_payment_due_date),
      minimumPayment: num(a.minimum_payment),
      aprPercentage: num(a.apr_percentage),
      isOverdue: a.is_overdue == null ? null : bool(a.is_overdue),
    }, true);
  }

  const cloud = new Map<string, Txn>();
  const ids = data.transactions.map((t) => String(t.txn_id));
  for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
    const refs = ids.slice(i, i + BATCH_LIMIT).map((id) => txnCol(db, uid).doc(id));
    for (const doc of await db.getAll(...refs)) {
      if (doc.exists) cloud.set(doc.id, doc.data() as Txn);
    }
  }

  for (const t of data.transactions) {
    const date = String(t.date);
    const amount = round2(Number(t.amount));
    const cashback = round2(Number(t.cashback ?? 0));
    const splitOwed = round2(Number(t.split_owed ?? 0));
    const source = String(t.category_source ?? "uncategorized");
    let txn: Txn = {
      txnId: String(t.txn_id),
      accountId: String(t.account_id),
      date,
      month: date.slice(0, 7),
      name: str(t.name),
      merchantName: str(t.merchant_name),
      merchantKey: String(t.merchant_key),
      amount,
      cashback,
      splitOwed,
      cashbackPct: num(t.cashback_pct),
      cashbackPayout: str(t.cashback_payout),
      cashbackSource: str(t.cashback_source),
      cashbackReceived: bool(t.cashback_received),
      splitNote: str(t.split_note),
      splitSource: str(t.split_source),
      splitSettled: bool(t.split_settled),
      net: netOf({ amount, cashback, splitOwed }),
      isoCurrency: str(t.iso_currency),
      pending: bool(t.pending),
      plaidCategory: str(t.plaid_category),
      category: String(t.category ?? "Other"),
      categorySource: SOURCE[source] ?? source,
      isTransfer: bool(t.is_transfer),
      p2p: isP2P(str(t.name), String(t.merchant_key)),
      logoUrl: str(t.logo_url),
      search: searchTerms({
        name: str(t.name), merchantName: str(t.merchant_name), merchantKey: String(t.merchant_key),
      }),
    };
    const there = cloud.get(txn.txnId);
    if (there) txn = keepCloudEdits(txn, there);
    await out.set(txnCol(db, uid).doc(txn.txnId), txn);
  }

  for (const o of data.overrides) {
    if (!safeId(o.merchant_key)) { skipped++; continue; }
    await out.set(user.collection("overrides").doc(o.merchant_key), { category: o.category });
  }
  for (const c of data.merchantCache) {
    if (!safeId(c.merchant_key)) { skipped++; continue; }
    await out.set(user.collection("merchantCache").doc(c.merchant_key),
      { category: c.category, model: c.model });
  }
  for (const b of data.budgets) {
    await out.set(user.collection("budgets").doc(b.category), { monthly: Number(b.monthly) });
  }
  for (const r of data.splitRules) {
    if (!safeId(r.merchant_key)) { skipped++; continue; }
    await out.set(user.collection("splitRules").doc(r.merchant_key),
      { myShare: Number(r.my_share), note: r.note });
  }
  await out.flush();

  // Rebuilt from what is now stored, not accumulated - which is what makes a
  // second import harmless rather than a doubling of every figure.
  const rebuilt = await rebuildAll(db, uid);
  await user.set({ importedAt: FieldValue.serverTimestamp() }, { merge: true });

  return {
    institutions: data.items.length,
    accounts: data.accounts.length,
    transactions: data.transactions.length,
    months: rebuilt.months,
    writes: out.written,
    skipped,
  };
}

/**
 * The laptop's copy, except where the cloud copy carries a deliberate edit.
 * Cloud edits are newer by construction: they were made after the first import.
 */
function keepCloudEdits(laptop: Txn, cloud: Txn): Txn {
  const merged: Txn = { ...laptop };
  if (cloud.categorySource === "override" || cloud.categorySource === "manual") {
    merged.category = cloud.category;
    merged.categorySource = cloud.categorySource;
    merged.isTransfer = cloud.isTransfer;
  }
  if (cloud.splitOwed) {
    merged.splitOwed = cloud.splitOwed;
    merged.splitNote = cloud.splitNote;
    merged.splitSource = cloud.splitSource;
    merged.splitSettled = cloud.splitSettled;
  }
  // only a cloud mark with a payout is a real edit; an amount alone is what the
  // first import brought across without its metadata
  if (cloud.cashback && cloud.cashbackPayout) {
    merged.cashback = cloud.cashback;
    merged.cashbackPct = cloud.cashbackPct;
    merged.cashbackPayout = cloud.cashbackPayout;
    merged.cashbackSource = cloud.cashbackSource;
    merged.cashbackReceived = cloud.cashbackReceived;
  }
  merged.net = netOf(merged);
  return merged;
}
