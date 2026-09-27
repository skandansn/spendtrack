/**
 * Publishes spendtrack's ~1KB spend snapshot so the phone can read it without
 * the laptop being awake or Tailscale being connected.
 *
 * Only aggregates live here - month-to-date per category, budgets, last month's
 * comparison. No transactions, no merchants, no account numbers, no Plaid
 * tokens. That is deliberate: this endpoint is on the public internet, so
 * nothing worth stealing should ever reach it.
 *
 * Two separate tokens, because the laptop and the phone need different rights:
 * the phone can only read, so extracting its token from the APK gains nobody
 * the ability to write nonsense into your dashboard.
 *
 *   PUT /snapshot   Authorization: Bearer $WRITE_TOKEN
 *   GET /snapshot   Authorization: Bearer $READ_TOKEN
 */

const KEY = "snapshot";

// Compare in constant time so a wrong token cannot be guessed a byte at a time.
function tokenMatches(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function bearer(request) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname !== "/snapshot") return json({ error: "not found" }, 404);

    const token = bearer(request);

    if (request.method === "GET") {
      if (!tokenMatches(token, env.READ_TOKEN)) return json({ error: "unauthorized" }, 401);
      const stored = await env.SNAPSHOT.get(KEY);
      if (!stored) return json({ error: "nothing published yet" }, 404);
      return new Response(stored, {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    if (request.method === "PUT") {
      if (!tokenMatches(token, env.WRITE_TOKEN)) return json({ error: "unauthorized" }, 401);
      const body = await request.text();
      // Reject anything that is not the shape we expect, so a bad publish
      // cannot leave the phone parsing garbage at a checkout screen.
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json({ error: "body is not JSON" }, 400);
      }
      if (!Array.isArray(parsed.categories) || typeof parsed.month !== "string") {
        return json({ error: "expected {month, categories[]}" }, 400);
      }
      if (body.length > 64 * 1024) return json({ error: "snapshot too large" }, 413);

      await env.SNAPSHOT.put(KEY, body);
      return json({ ok: true, bytes: body.length, categories: parsed.categories.length });
    }

    return json({ error: "use GET or PUT" }, 405);
  },
};
