/**
 * The only code that holds the Plaid secret.
 *
 * Everything the app can do without that secret - reading transactions, totals,
 * budgets, setting a category - it does straight against Firestore, guarded by
 * the security rules. Functions exist for the three things that cannot happen
 * on a phone: calling Plaid, running on a schedule, and writing to the `private`
 * collection no client may touch.
 */

import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions";

import {
  PlaidConfig, PlaidEnv, createLinkToken, exchangePublicToken, institutionGet, itemGet,
  linkTokenGet,
} from "./plaid";
import { privateDoc, recomputeTotals, userDoc } from "./model";
import { rebuildAll } from "./repair";
import { syncAll } from "./sync";
import { importData } from "./import";
import { publishSnapshot, snapshotMonths } from "./snapshot";

initializeApp();
const db = getFirestore();

// Secrets live in Secret Manager, never in source or environment files. They are
// mounted only into the functions that declare them below.
const PLAID_CLIENT_ID = defineSecret("PLAID_CLIENT_ID");
const PLAID_SECRET = defineSecret("PLAID_SECRET");

const plaidConfig = (): PlaidConfig => ({
  clientId: PLAID_CLIENT_ID.value(),
  secret: PLAID_SECRET.value(),
  env: (process.env.PLAID_ENV as PlaidEnv) || "production",
});

/** Every callable is single-user: signed in, acting only on their own data. */
function requireUid(request: CallableRequest): string {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  return uid;
}

const SNAPSHOT_URL = defineSecret("SNAPSHOT_URL");
const SNAPSHOT_WRITE_TOKEN = defineSecret("SNAPSHOT_WRITE_TOKEN");

const SECRETS = [PLAID_CLIENT_ID, PLAID_SECRET];
// 512MiB and 120s: a first sync of two years of history is the slow case, and a
// timeout halfway through would leave the cursor unadvanced and replay it.
// Callables must be publicly invokable at the Cloud Run layer: the Firebase ID
// token they carry is not a Google identity token, so a private service rejects
// it with a 401 before any code runs. Sign-in is still enforced, by requireUid.
// Stated explicitly because a deploy can otherwise leave a function private.
const PUBLIC = { invoker: "public" as const };
const HEAVY = { secrets: SECRETS, memory: "512MiB" as const, timeoutSeconds: 120 };

export const sync = onCall({ ...PUBLIC, ...HEAVY }, async (request) => {
  const uid = requireUid(request);
  const results = await syncAll(db, uid, plaidConfig());
  return { results };
});

export const linkToken = onCall({ ...PUBLIC, secrets: SECRETS }, async (request) => {
  const uid = requireUid(request);
  const itemId = request.data?.itemId as string | undefined;

  let accessToken: string | undefined;
  if (itemId) {
    // update mode: re-authenticating an existing Item consumes no Item slot
    const snapshot = await userDoc(db, uid).collection("private").doc("plaid").get();
    accessToken = snapshot.get(`items.${itemId}.accessToken`) as string | undefined;
    if (!accessToken) throw new HttpsError("not-found", "No such linked institution.");
  }
  // Only the phone asks for hosted: the browser runs Plaid's Link script itself.
  const redirect = request.data?.hosted ? "spendtrack://plaid-done" : undefined;
  const { link_token, hosted_link_url } =
    await createLinkToken(plaidConfig(), uid, accessToken, redirect);
  return { linkToken: link_token, hostedLinkUrl: hosted_link_url ?? null };
});

export const exchangeToken = onCall({ ...PUBLIC, secrets: SECRETS }, async (request) => {
  const uid = requireUid(request);
  const publicToken = request.data?.publicToken as string | undefined;
  if (!publicToken) throw new HttpsError("invalid-argument", "publicToken is required.");
  return storeItem(uid, plaidConfig(), publicToken);
});

/**
 * Collect what a Hosted Link session produced and store it. Called by the phone
 * once the Custom Tab closes; Plaid keeps the result for six hours.
 */
export const completeHostedLink = onCall({ ...PUBLIC, secrets: SECRETS }, async (request) => {
  const uid = requireUid(request);
  const linkToken = request.data?.linkToken as string | undefined;
  if (!linkToken) throw new HttpsError("invalid-argument", "linkToken is required.");
  const config = plaidConfig();
  const { link_sessions = [] } = await linkTokenGet(config, linkToken);
  const tokens = new Set<string>();
  for (const session of link_sessions) {
    for (const r of session.results?.item_add_results ?? []) tokens.add(r.public_token);
    if (session.on_success?.public_token) tokens.add(session.on_success.public_token);
  }
  const linked = [];
  for (const token of tokens) linked.push(await storeItem(uid, config, token));
  return { linked };
});

async function storeItem(uid: string, config: PlaidConfig, publicToken: string) {
  const { access_token, item_id } = await exchangePublicToken(config, publicToken);

  let name: string | null = null;
  let logo: string | null = null;
  let color: string | null = null;
  const { item } = await itemGet(config, access_token);
  if (item.institution_id) {
    const { institution } = await institutionGet(config, item.institution_id);
    name = institution.name;
    logo = institution.logo;
    color = institution.primary_color;
  }

  // The access token can read every account at this institution, so it goes to
  // `private`, which the security rules deny to every client unconditionally.
  // Nested, not dotted: set+merge stores a dotted key as a literal field name.
  await privateDoc(db, uid).set({
    items: {
      [item_id]: {
        accessToken: access_token,
        institutionId: item.institution_id,
        institutionName: name,
        cursor: null,
        status: "ok",
      },
    },
  }, { merge: true });

  // The display copy is separate and safe to read: no token in it.
  await userDoc(db, uid).collection("institutions").doc(item_id).set({
    itemId: item_id, name, logo, color, status: "ok",
    linkedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { itemId: item_id, institution: name };
}

/**
 * Daily sync. The schedule is the whole point of hosting this: it runs whether
 * or not a phone or laptop is awake, which is what the local version could never
 * promise.
 */
export const scheduledSync = onSchedule(
  { schedule: "30 7 * * *", timeZone: "America/New_York", ...HEAVY },
  async () => {
    // The full recount reads every transaction, so it runs weekly; daily syncs
    // keep the totals current through deltas in between.
    const sunday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" })
      .format(new Date()) === "Sun";
    const users = await db.collection("users").listDocuments();
    for (const user of users) {
      try {
        const results = await syncAll(db, user.id, plaidConfig(), sunday);
        logger.info("scheduled sync", { uid: user.id, results });
      } catch (error) {
        logger.error("scheduled sync failed", { uid: user.id, error: String(error) });
      }
    }
  },
);

/**
 * Rebuild a month's totals from its transactions.
 *
 * The running totals are maintained by deltas, and a delta that goes missing is
 * invisible - a wrong total looks exactly like a right one. This is the way back.
 */
export const rebuildTotals = onCall(PUBLIC, async (request) => {
  const uid = requireUid(request);
  const month = request.data?.month as string | undefined;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new HttpsError("invalid-argument", "month must look like 2026-10.");
  }
  const totals = await recomputeTotals(db, uid, month);
  return { month, total: totals.total, categories: Object.keys(totals.byCategory).length };
});

/**
 * One-off: bring the laptop's database across. Large payload and many writes,
 * so it gets the generous memory and time limits; it runs once, not daily.
 */
export const importLaptop = onCall(
  { ...PUBLIC, memory: "1GiB", timeoutSeconds: 300 },
  async (request) => {
    const uid = requireUid(request);
    try {
      return await importData(db, uid, request.data);
    } catch (error) {
      throw new HttpsError("invalid-argument", String((error as Error).message || error));
    }
  },
);

/** Rebuild every total and insight from the transactions. The general repair. */
export const repair = onCall({ ...PUBLIC, memory: "512MiB", timeoutSeconds: 120 }, async (request) => {
  const uid = requireUid(request);
  return rebuildAll(db, uid);
});

/**
 * Keep SpendWatch's snapshot current. It is built from this month's and last
 * month's totals plus budgets, so those writes are what republish it - a sync,
 * an edit on the phone and a budget change all land here, and nothing else
 * has to remember to publish. A sync moves the current month's totals once,
 * so this runs once per sync, not once per transaction.
 */
const SNAPSHOT = { secrets: [SNAPSHOT_URL, SNAPSHOT_WRITE_TOKEN] };
const publish = (uid: string) =>
  publishSnapshot(db, uid, SNAPSHOT_URL.value(), SNAPSHOT_WRITE_TOKEN.value());

export const snapshotOnTotals = onDocumentWritten(
  { document: "users/{uid}/totals/{month}", ...SNAPSHOT },
  async (event) => {
    const { current, previous } = snapshotMonths();
    if (event.params.month !== current && event.params.month !== previous) return;
    await publish(event.params.uid);
  },
);

export const snapshotOnBudgets = onDocumentWritten(
  { document: "users/{uid}/budgets/{category}", ...SNAPSHOT },
  (event) => publish(event.params.uid),
);
