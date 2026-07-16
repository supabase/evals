import type { DocsCall, DocsCallPage, DocsResult } from "./eval-metadata.js";
import type { ToolCallRecord } from "./index.js";

const URL_PATTERN = /^https?:\/\//i;
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
      });
      continue;
    }

    if (call.name === "web_fetch") {
      if (!call.url || !isSupabaseUrl(call.url)) continue;
      calls.push({ source: "web_fetch", query: call.url, hasContent: true, pages: [{ url: call.url }] });
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
        calls.push({ source: "web_search", query, pages: [{ url: query }] });
        continue;
      }

      if (!/supabase/i.test(query)) continue;
      const pages = extractPages(result);
      // Claude Code's WebSearch result never carries page text, only
      // title/url per hit, so any pages found here are hits, not reads.
      calls.push({ source: "web_search", query, hasContent: pages.length > 0 ? false : undefined, pages });
      continue;
    }
  }

  return { calls };
}
