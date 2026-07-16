import type { DocsCall, DocsCallPage, DocsResult } from "./eval-metadata.js";
import type { ToolCallRecord } from "./index.js";

/** The subset of AgentSandbox rehydration needs; avoids a hard dependency on its full interface. */
export interface DocsResultSandbox {
  readFile(path: string): Promise<string>;
}

const URL_PATTERN = /^https?:\/\//i;
// Claude Code persists a tool result to disk and hands back a short stub
// instead, in one of two observed shapes:
//   "Error: result (65,754 characters across 1 line) exceeds maximum
//   allowed tokens. Output has been saved to /path/to/file.txt.\n..."
//   "<persisted-output>\nOutput too large (50.8KB). Full output saved
//   to: /path/to/file.json\n\nPreview (first 2KB):\n..."
// Both name the file's absolute in-container path, and it's still readable
// as long as the sandbox hasn't been disposed yet.
const TRUNCATION_PATH_PATTERN = /(?:Output has been saved to|Full output saved to:)\s*(\S+)/;
const TRUNCATION_EXACT_SIZE_PATTERN = /\(([\d,]+) characters/;
const TRUNCATION_APPROX_SIZE_PATTERN = /Output too large \(([\d.]+)\s*(K|M)?B\)/i;
// search_docs and Claude Code's WebSearch both return matches as
// `{"title":"...","href|url":"..."}` pairs, title first, in that adjacency
// (confirmed against a real search_docs response and a real WebSearch
// transcript). Falls back to a bare href/url match when no adjacent title
// survived (e.g. the agent's own query never selected `title`).
const TITLED_PAGE_PATTERN = /"title":"([^"]*)"\s*,?\s*"(?:href|url)":"([^"]+)"/g;
const HREF_PATTERN = /"(?:href|url)":"([^"]+)"/g;

/**
 * The search_docs query arg, wherever the harness put it: flat on `body`
 * (ai-sdk, Claude Code) or nested under `body.arguments` (Codex reports the
 * whole raw MCP call record as `body`, args and all).
 */
function extractGraphqlQuery(body: Record<string, unknown>): string | undefined {
  if (typeof body.graphql_query === "string") return body.graphql_query;
  const args = body.arguments;
  if (args && typeof args === "object" && "graphql_query" in args) {
    const value = (args as Record<string, unknown>).graphql_query;
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** True when a URL string points at any supabase.com host. */
function isSupabaseUrl(value: string): boolean {
  try {
    const { hostname } = new URL(value);
    return hostname === "supabase.com" || hostname.endsWith(".supabase.com");
  } catch {
    return false;
  }
}

/** The in-container path a truncated result was persisted to, if `result` is one of the known stub shapes. */
function extractTruncatedResultPath(result: unknown): string | undefined {
  if (typeof result !== "string") return undefined;
  const match = result.match(TRUNCATION_PATH_PATTERN);
  // Sentence punctuation sometimes lands right after the path with no
  // separating space ("...file.txt.\nFormat: ..."); a real path never ends
  // in a bare ".", so stripping trailing dots is always safe.
  return match?.[1].replace(/\.+$/, "");
}

/** Best-effort size (in characters) a truncation stub reports about the result it's standing in for. */
function extractTruncatedResultCharCount(result: string): number | undefined {
  const exact = result.match(TRUNCATION_EXACT_SIZE_PATTERN);
  if (exact) return Number(exact[1].replace(/,/g, ""));
  const approx = result.match(TRUNCATION_APPROX_SIZE_PATTERN);
  if (!approx) return undefined;
  const unit = approx[2]?.toUpperCase();
  const multiplier = unit === "M" ? 1024 * 1024 : unit === "K" ? 1024 : 1;
  return Math.round(Number(approx[1]) * multiplier);
}

/** Approximate size of a tool result, in characters, favoring a truncation stub's own reported size when present. */
function resultCharCount(result: unknown): number | undefined {
  if (typeof result !== "string") {
    if (result === undefined) return undefined;
    return JSON.stringify(result).length;
  }
  return extractTruncatedResultCharCount(result) ?? result.length;
}

/** True when a tool call is one of the channels docs activation tracks (worth rehydrating if truncated). */
function isDocsRelatedCall(call: ToolCallRecord): boolean {
  return call.endpoint.endsWith("search_docs") || call.name === "web_fetch" || call.name === "web_search";
}

/**
 * Fetches the real content back for any docs-related call the CLI truncated
 * and persisted to disk, replacing the stub in place. Must run before the
 * sandbox that produced the transcript is disposed, the file lives inside
 * that container and won't be reachable afterward. A read failure (file
 * already cleaned up, path parsed wrong) leaves the stub as-is; buildDocsResult
 * already treats an unresolvable result as an omission, not a fabrication.
 */
export async function rehydrateTruncatedDocsResults(
  sandbox: DocsResultSandbox,
  toolCalls: ToolCallRecord[],
): Promise<void> {
  for (const call of toolCalls) {
    if (!isDocsRelatedCall(call)) continue;
    const path = extractTruncatedResultPath(call.result);
    if (!path) continue;
    try {
      call.result = await sandbox.readFile(path);
    } catch {
      // Leave the stub in place.
    }
  }
}

/**
 * Whether a search_docs GraphQL query's field selection (not any quoted
 * search-term string it carries) asks for `content`. Checked against the
 * query text itself rather than the result, so it still works when the
 * result got truncated before a page's content could be recovered.
 */
function queryRequestsContent(graphqlQuery: string): boolean {
  return /\bcontent\b/.test(graphqlQuery.replace(/"[^"]*"/g, ""));
}

/** Extracts `{url, title}` pairs from a tool result, however much of it survived truncation. */
function extractPages(result: unknown): DocsCallPage[] {
  const raw = typeof result === "string" ? result : JSON.stringify(result ?? "");
  // Some harnesses wrap the GraphQL response in a content-array whose `text`
  // field is itself a JSON string (e.g. `[{"type":"text","text":"{\"href\":...}"}]`),
  // so stringifying the outer value double-escapes the inner quotes. Unescape
  // once so `\"href\":\"` still matches like plain `"href":"`.
  const text = raw.replace(/\\"/g, '"');

  const pages: DocsCallPage[] = [];
  const seen = new Set<string>();
  for (const [, title, url] of text.matchAll(TITLED_PAGE_PATTERN)) {
    if (!isSupabaseUrl(url) || seen.has(url)) continue;
    seen.add(url);
    pages.push(title ? { url, title } : { url });
  }
  for (const [, url] of text.matchAll(HREF_PATTERN)) {
    if (!isSupabaseUrl(url) || seen.has(url)) continue;
    seen.add(url);
    pages.push({ url });
  }
  return pages;
}

/**
 * Builds the persisted docs activation summary for one eval run: one entry
 * per docs-related tool call (not per page), in the order the agent actually
 * made them. `search_docs` is matched by raw endpoint suffix (MCP namespacing
 * like `mcp__supabase-mcp__search_docs` isn't part of any canonical
 * vocabulary); the web channel matches on the harness's own normalized
 * `call.name`, so Claude Code's `WebSearch` and Codex's `web_search` share
 * one branch.
 */
export function buildDocsResult(toolCalls: ToolCallRecord[]): DocsResult {
  const calls: DocsCall[] = [];

  for (const call of toolCalls) {
    const { endpoint, body, result } = call;

    if (endpoint.endsWith("search_docs")) {
      const graphqlQuery = extractGraphqlQuery(body);
      if (!graphqlQuery) continue;
      calls.push({
        source: "search_docs",
        query: graphqlQuery,
        hasContent: queryRequestsContent(graphqlQuery),
        pages: extractPages(result),
        resultChars: resultCharCount(result),
      });
      continue;
    }

    if (call.name === "web_fetch") {
      if (!call.url || !isSupabaseUrl(call.url)) continue;
      // WebFetch doesn't hand back the raw page: it runs the fetch through
      // an extraction step guided by `prompt` and returns that. Two calls to
      // the identical url can return very different amounts of text
      // depending only on this, so it's the meaningful "what did the agent
      // ask for" here, same role `query` plays for search_docs. The target
      // url is still recorded, just in `pages` rather than the summary line.
      const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
      calls.push({
        source: "web_fetch",
        query: prompt ?? call.url,
        hasContent: true,
        pages: [{ url: call.url }],
        resultChars: resultCharCount(result),
      });
      continue;
    }

    if (call.name === "web_search") {
      const query = typeof body.query === "string" ? body.query : undefined;
      if (!query) continue;

      // Codex's web_search doubles as a fetch: when the model passes a URL
      // as the query, it's a page visit, not a search term. No result
      // payload is ever exposed on this tool (confirmed empirically), so
      // whether content came back is genuinely unknown, not false.
      if (URL_PATTERN.test(query)) {
        if (!isSupabaseUrl(query)) continue;
        calls.push({ source: "web_search", query, pages: [{ url: query }], resultChars: resultCharCount(result) });
        continue;
      }

      if (!/supabase/i.test(query)) continue;
      const pages = extractPages(result);
      // Claude Code's WebSearch result never carries page text, only
      // title/url per hit, so any pages found here are hits, not reads.
      calls.push({
        source: "web_search",
        query,
        hasContent: pages.length > 0 ? false : undefined,
        pages,
        resultChars: resultCharCount(result),
      });
      continue;
    }
  }

  return { calls };
}
