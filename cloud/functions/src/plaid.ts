/**
 * Plaid, over plain fetch.
 *
 * The official SDK pulls in a large generated client for what are a handful of
 * JSON POSTs. Skipping it keeps the deployed bundle small, which is what cold
 * start time is mostly made of - and this function runs once a day, so it is
 * nearly always a cold start.
 *
 * Everything here runs in Cloud Functions and nowhere else: the client secret
 * can read every linked account, so it must never reach a phone or a browser.
 */

export type PlaidEnv = "sandbox" | "production";

const HOSTS: Record<PlaidEnv, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export interface PlaidConfig {
  clientId: string;
  secret: string;
  env: PlaidEnv;
}

export class PlaidError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PlaidError";
  }
}

async function call<T>(config: PlaidConfig, path: string, body: object): Promise<T> {
  const response = await fetch(`${HOSTS[config.env]}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "PLAID-CLIENT-ID": config.clientId,
      "PLAID-SECRET": config.secret,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    let code = "UNKNOWN";
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error_code?: string; error_message?: string };
      code = parsed.error_code ?? code;
      message = parsed.error_message ?? message;
    } catch {
      // a non-JSON body means an edge/proxy error; the raw text is the message
    }
    throw new PlaidError(code, response.status, message);
  }
  return JSON.parse(text) as T;
}

// --- shapes we actually read -------------------------------------------------

export interface PlaidAccount {
  account_id: string;
  name: string | null;
  official_name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  balances: {
    current: number | null;
    available: number | null;
    limit: number | null;
    iso_currency_code: string | null;
  };
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  date: string;
  authorized_date: string | null;
  name: string | null;
  merchant_name: string | null;
  amount: number;
  iso_currency_code: string | null;
  pending: boolean;
  logo_url: string | null;
  personal_finance_category: { primary: string } | null;
}

interface SyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  accounts: PlaidAccount[];
  next_cursor: string;
  has_more: boolean;
}

export interface SyncResult {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: string[];
  accounts: PlaidAccount[];
  cursor: string;
}

/**
 * Drain /transactions/sync for one institution.
 *
 * The cursor is what makes a daily sync cheap: each call returns only what
 * changed since last time, so a run that finds nothing new transfers nothing
 * and costs one request.
 */
export async function transactionsSync(
  config: PlaidConfig,
  accessToken: string,
  cursor: string | null,
): Promise<SyncResult> {
  const result: SyncResult = {
    added: [], modified: [], removed: [], accounts: [], cursor: cursor ?? "",
  };
  let hasMore = true;

  while (hasMore) {
    const page = await call<SyncPage>(config, "/transactions/sync", {
      access_token: accessToken,
      cursor: result.cursor || undefined,
      count: 500,
    });
    result.added.push(...page.added);
    result.modified.push(...page.modified);
    result.removed.push(...page.removed.map((r) => r.transaction_id));
    if (page.accounts?.length) result.accounts = page.accounts;
    // Plaid hands back an empty cursor while a fresh Item's transactions are
    // still being prepared. Keep the previous one rather than resetting to the
    // beginning of history.
    result.cursor = page.next_cursor || result.cursor;
    hasMore = page.has_more;
  }
  return result;
}

export interface CreditLiability {
  account_id: string;
  last_statement_balance: number | null;
  last_statement_issue_date: string | null;
  next_payment_due_date: string | null;
  minimum_payment_amount: number | null;
  is_overdue: boolean | null;
  aprs: { apr_type: string; apr_percentage: number }[] | null;
}

/**
 * Statement balance, due date and APR per credit card.
 *
 * An institution with only current accounts and investments has no liabilities
 * to return, and saying so is the correct answer rather than a failure. Treating
 * it as one marks the whole item failed even though its transactions arrived.
 */
export async function liabilities(
  config: PlaidConfig,
  accessToken: string,
): Promise<CreditLiability[]> {
  try {
    const body = await call<{ liabilities: { credit: CreditLiability[] | null } }>(
      config, "/liabilities/get", { access_token: accessToken },
    );
    return body.liabilities.credit ?? [];
  } catch (error) {
    if (error instanceof PlaidError && [
      "PRODUCT_NOT_READY", "PRODUCTS_NOT_SUPPORTED",
      "NO_LIABILITY_ACCOUNTS", "NO_ACCOUNTS",
    ].includes(error.code)) {
      return [];
    }
    throw error;
  }
}

export const accountsGet = (config: PlaidConfig, accessToken: string) =>
  call<{ accounts: PlaidAccount[] }>(config, "/accounts/get", { access_token: accessToken });

export const exchangePublicToken = (config: PlaidConfig, publicToken: string) =>
  call<{ access_token: string; item_id: string }>(
    config, "/item/public_token/exchange", { public_token: publicToken },
  );

export const itemGet = (config: PlaidConfig, accessToken: string) =>
  call<{ item: { institution_id: string | null } }>(
    config, "/item/get", { access_token: accessToken },
  );

export const institutionGet = (config: PlaidConfig, institutionId: string) =>
  call<{ institution: { name: string; logo: string | null; primary_color: string | null } }>(
    config, "/institutions/get_by_id", {
      institution_id: institutionId,
      country_codes: ["US", "CA"],
      options: { include_optional_metadata: true },
    },
  );

/**
 * days_requested is asked for at the maximum, and it matters: Plaid defaults to
 * 90 days and an Item's history window cannot be extended afterwards. Getting
 * more means deleting the Item and linking again, which permanently costs
 * another of the free Trial's 10 Items.
 */
export const createLinkToken = (
  config: PlaidConfig, userId: string, accessToken?: string, hostedRedirect?: string,
) => call<{ link_token: string; hosted_link_url?: string }>(config, "/link/token/create", {
  client_name: "spendtrack",
  language: "en",
  country_codes: ["US", "CA"],
  user: { client_user_id: userId },
  // Hosted Link: Plaid serves the whole flow at a URL the phone opens in a
  // Custom Tab, so no native SDK is needed - and a Custom Tab, unlike a
  // webview, is where OAuth banks such as Chase can complete their sign-in.
  ...(hostedRedirect
    ? { hosted_link: { is_mobile_app: true, completion_redirect_uri: hostedRedirect } }
    : {}),
  ...(accessToken
    // update mode: re-authenticate an existing Item in place, consuming no slot
    ? { access_token: accessToken }
    : {
      products: ["transactions"],
      required_if_supported_products: ["liabilities"],
      additional_consented_products: ["investments", "auth", "identity"],
      transactions: { days_requested: 730 },
    }),
});

/**
 * What happened in a Link session. Polled after Hosted Link closes, because a
 * webhook would need a public endpoint this app does not otherwise have.
 */
export const linkTokenGet = (config: PlaidConfig, linkToken: string) =>
  call<{
    link_sessions?: {
      results?: { item_add_results?: { public_token: string }[] };
      on_success?: { public_token: string } | null;
    }[];
  }>(config, "/link/token/get", { link_token: linkToken });
