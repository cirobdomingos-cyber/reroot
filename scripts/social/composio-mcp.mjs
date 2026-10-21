/**
 * Ported from template-niche-brand (scripts/composio-mcp.mjs, 2026-10-21); keep the two in step.
 *
 * Minimal client for the Composio MCP server (streamable HTTP, JSON-RPC), so scheduled jobs
 * can run Composio tools with the account's consumer key, the same way Claude Code does.
 *
 *   COMPOSIO_CONSUMER_KEY   the ck_... key from dashboard -> Sessions & API Key
 *   COMPOSIO_MCP_URL        default https://connect.composio.dev/mcp
 *   COMPOSIO_ACCOUNT        which connected account runs the tools (alias or id, e.g. the
 *                           Instagram connection's alias). Required as soon as a toolkit has
 *                           two accounts, which happens with the second niche: without it
 *                           Composio refuses ("Multiple instagram accounts connected").
 *
 * Direct REST route (preferred when configured, because the MCP gateway answers 502 on about
 * two calls in three since 2026-10-06):
 *
 *   COMPOSIO_API_KEY_AK       the Platform project key (ak_...), header x-api-key
 *   COMPOSIO_CONNECTED_ACCOUNT the connected account id (ca_...) of this site's Instagram
 *   COMPOSIO_USER_ID          the Composio user id that owns that account
 *   COMPOSIO_REST_URL         default https://backend.composio.dev/api/v3.1
 *
 * A call goes by REST when all three are set, COMPOSIO_CONNECTED_ACCOUNT starts with `ca_` and
 * the tool is an INSTAGRAM_* or GMAIL_* one (the only toolkits with a REST connection; EXA and
 * the rest stay on MCP). Otherwise it goes by MCP exactly as before. Same retry rules on both
 * routes. The route taken is logged at debug level (DEBUG=composio).
 *
 * runTool(slug, args) executes one Composio tool through COMPOSIO_MULTI_EXECUTE_TOOL and
 * returns its `data` (throws when the tool reports failure).
 *
 * Retry: the endpoint answers 502/503/504 on roughly one call in three at times (2026-10-06), so
 * every request is tried up to 3 times in all (backoff ~1 s, then ~3 s) on HTTP 502/503/504 or a
 * network error (fetch throws). 4xx and JSON-RPC errors are never retried: the request is wrong.
 * Publish rule: a `tools/call` whose tool slug publishes (*PUBLISH*, INSTAGRAM_CREATE_POST) is
 * NEVER retried, not after a 5xx and not after a network error, because the server may already
 * have published and a second attempt would post twice. Only `initialize`, the initialized
 * notification and read-only tool calls retry. A failed publish surfaces to the caller, who
 * decides (post-next.mjs records state before and after instead of guessing).
 */

const URL_ = process.env.COMPOSIO_MCP_URL || "https://connect.composio.dev/mcp";
let session = null;
let nextId = 1;

function key() {
  const k = process.env.COMPOSIO_CONSUMER_KEY;
  if (!k) throw new Error("missing env COMPOSIO_CONSUMER_KEY");
  return k;
}

const RETRY_STATUS = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
let backoffMs = [1000, 3000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Test hook: replace the waits between attempts (an array of ms, one per retry). */
export function setRetryBackoff(ms) {
  backoffMs = ms;
}

/** True when running this slug may have side effects that must not happen twice. */
export function isPublishSlug(slug) {
  return /PUBLISH|CREATE_POST/i.test(String(slug));
}

/** POST with the retry policy above; `retry: false` makes it a single attempt. Returns the Response. */
async function post(headers, body, retry) {
  const attempts = retry ? MAX_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(URL_, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (err) {
      if (attempt >= attempts) throw err;
      await sleep(backoffMs[attempt - 1] ?? 3000);
      continue;
    }
    if (!RETRY_STATUS.has(res.status) || attempt >= attempts) return res;
    await res.text().catch(() => "");
    await sleep(backoffMs[attempt - 1] ?? 3000);
  }
}

async function rpc(method, params, { notify = false, retry = true } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-consumer-api-key": key(),
  };
  if (session) headers["mcp-session-id"] = session;
  const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: nextId++, method, params };
  const res = await post(headers, body, retry);
  const sid = res.headers.get("mcp-session-id");
  if (sid) session = sid;
  if (notify) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP ${method} HTTP ${res.status}: ${text.slice(0, 300)}`);
  // streamable HTTP may answer as SSE: take the last `data:` line that parses
  const payload = (res.headers.get("content-type") || "").includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).pop()
    : text;
  const msg = JSON.parse(payload);
  if (msg.error) throw new Error(`MCP ${method}: ${JSON.stringify(msg.error).slice(0, 300)}`);
  return msg.result;
}

async function ensureSession() {
  if (session) return;
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "niche-site-cron", version: "1.0" } });
  await rpc("notifications/initialized", {}, { notify: true });
}

const REST_URL = () => (process.env.COMPOSIO_REST_URL || "https://backend.composio.dev/api/v3.1").replace(/\/+$/, "");

/** True when this slug should run on the direct REST route (see the header). */
export function useRest(slug) {
  const acct = process.env.COMPOSIO_CONNECTED_ACCOUNT || "";
  return acct.startsWith("ca_") && !!process.env.COMPOSIO_API_KEY_AK && !!process.env.COMPOSIO_USER_ID &&
    /^(INSTAGRAM|GMAIL)_/i.test(String(slug));
}

/** True when the slug creates or changes something, so a repeat could duplicate it. */
export function isWriteSlug(slug) {
  return /PUBLISH|CREATE|POST_|DELETE|UPDATE/i.test(String(slug));
}

function debug(msg) {
  if (/composio|\*/.test(process.env.DEBUG || "")) console.error(`[composio] ${msg}`);
}

async function runToolRest(slug, args) {
  const attempts = isWriteSlug(slug) ? 1 : MAX_ATTEMPTS;
  const url = `${REST_URL()}/tools/execute/${encodeURIComponent(slug)}`;
  const init = {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.COMPOSIO_API_KEY_AK },
    body: JSON.stringify({ connected_account_id: process.env.COMPOSIO_CONNECTED_ACCOUNT, user_id: process.env.COMPOSIO_USER_ID, arguments: args }),
  };
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (attempt >= attempts) throw err;
      await sleep(backoffMs[attempt - 1] ?? 3000);
      continue;
    }
    if (RETRY_STATUS.has(res.status) && attempt < attempts) {
      await res.text().catch(() => "");
      await sleep(backoffMs[attempt - 1] ?? 3000);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${slug} REST HTTP ${res.status}: ${text.slice(0, 300)}`);
    const parsed = JSON.parse(text);
    if (parsed.successful === false) throw new Error(`${slug} failed: ${text.slice(0, 400)}`);
    return parsed.data;
  }
}

export async function runTool(slug, args) {
  if (useRest(slug)) {
    debug(`${slug} via REST`);
    return runToolRest(slug, args);
  }
  debug(`${slug} via MCP`);
  await ensureSession();
  const result = await rpc("tools/call", {
    name: "COMPOSIO_MULTI_EXECUTE_TOOL",
    arguments: {
      tools: [{ tool_slug: slug, arguments: args, ...(process.env.COMPOSIO_ACCOUNT ? { account: process.env.COMPOSIO_ACCOUNT } : {}) }],
      sync_response_to_workbench: false, thought: `cron: ${slug}`,
    },
  }, { retry: !isPublishSlug(slug) });
  const text = (result?.content || []).map((c) => c.text || "").join("");
  const parsed = JSON.parse(text);
  const item = parsed?.data?.results?.[0];
  if (!item || item.response?.successful === false || parsed.successful === false) {
    throw new Error(`${slug} failed: ${text.slice(0, 400)}`);
  }
  return item.response.data;
}

/** Test hook: forget the MCP session so the next call runs `initialize` again. */
export function resetSession() {
  session = null;
}
