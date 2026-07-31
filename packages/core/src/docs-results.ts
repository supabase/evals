import type { DocsCall, DocsCallPage, DocsResult } from './eval-metadata.js';
import type { ToolCallRecord } from './index.js';
import { isRecord } from './json.js';

/** The subset of AgentSandbox rehydration needs; avoids a hard dependency on its full interface. */
export interface DocsResultSandbox {
  readFile(path: string): Promise<string>;
}

const URL_PATTERN = /^https?:\/\//i;
// Claude Code persists truncated results to disk, two observed stub shapes:
//   "Error: result (65,754 characters across 1 line) exceeds maximum
//   allowed tokens. Output has been saved to /path/to/file.txt."
//   "<persisted-output>\nOutput too large (50.8KB). Full output saved
//   to: /path/to/file.json"
// Both name the in-container path, readable until the sandbox disposes.
const TRUNCATION_PATH_PATTERN =
  /(?:Output has been saved to|Full output saved to:)\s*(\S+)/;
const TRUNCATION_EXACT_SIZE_PATTERN = /\(([\d,]+) characters/;
const TRUNCATION_APPROX_SIZE_PATTERN =
  /Output too large \(([\d.]+)\s*(K|M)?B\)/i;
// search_docs and Claude Code's WebSearch return matches as
// `{"title":"...","href|url":"..."}`, title first. Falls back to a bare
// href/url match when the query never selected `title`.
const TITLED_PAGE_PATTERN =
  /"title":"([^"]*)"\s*,?\s*"(?:href|url)":"([^"]+)"/g;
const HREF_PATTERN = /"(?:href|url)":"([^"]+)"/g;
const CURL_PATTERN = /\bcurl\b/;
const CURL_NO_BODY_PATTERN =
  /(?:^|\s)(?:-[^-\s]*[oOI]\S*|--(?:output|remote-name|head)(?:=\S*)?)(?=\s|$)/;
const WGET_STDOUT_PATTERN =
  /(?:^|\s)(?:-[A-Za-z]*O-|-[A-Za-z]*O\s+-|--output-document(?:=|\s+)-)(?=\s|$)/;
const SHELL_SEGMENT_PATTERN = /(?:&&|\|\||[;|])/;
const SHELL_COMMAND_LIST_PATTERN = /(?:&&|\|\||;|\r?\n)/;
// Matches curl's -f/--fail flag.
const CURL_FAIL_FLAG_PATTERN = /(?:^|\s)(?:-[A-Za-z]*f[A-Za-z]*|--fail\b)(?=\s|$)/;
// Urls inside a shell command, stopping at the shell metacharacters that can
// legally follow one (`|`, `>`, quotes, backslash-escapes).
const URL_IN_COMMAND_PATTERN = /https?:\/\/[^\s'"`\\;|&>()]+/g;

/** The search_docs query arg, flat on `body` or nested under `body.arguments` (Codex's shape). */
function extractGraphqlQuery(
  body: Record<string, unknown>
): string | undefined {
  if (typeof body.graphql_query === 'string') return body.graphql_query;
  const args = body.arguments;
  if (args && typeof args === 'object' && 'graphql_query' in args) {
    const value = (args as Record<string, unknown>).graphql_query;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * True for the apex supabase.com host. Docs, changelog, and blog all live
 * there. Subdomains like `api.` and `mcp.` are service endpoints, so they
 * don't count.
 */
function isSupabaseApexUrl(value: string): boolean {
  try {
    return new URL(value).hostname === 'supabase.com';
  } catch {
    return false;
  }
}

/** The shell command a call ran, from the parser's normalized view or the raw body. */
function shellCommand(call: ToolCallRecord): string | undefined {
  if (call.name !== 'shell') return undefined;
  if (call.command) return call.command;
  return typeof call.body.command === 'string' ? call.body.command : undefined;
}

/** The docs urls a shell command writes to stdout, empty when page text won't reach the model. */
function shellFetchUrls(command: string | undefined): string[] {
  if (!command) return [];
  const urls: string[] = [];
  for (const segment of command.split(SHELL_SEGMENT_PATTERN)) {
    const curlToStdout =
      CURL_PATTERN.test(segment) &&
      !CURL_NO_BODY_PATTERN.test(segment) &&
      !segment.includes('>');
    const wgetToStdout =
      /\bwget\b/.test(segment) &&
      WGET_STDOUT_PATTERN.test(segment) &&
      !segment.includes('>');
    if (!curlToStdout && !wgetToStdout) continue;

    const fetcher = segment.match(/\b(?:curl|wget)\b/);
    if (!fetcher || fetcher.index === undefined) continue;
    for (const match of segment
      .slice(fetcher.index + fetcher[0].length)
      .match(URL_IN_COMMAND_PATTERN) ?? []) {
      // Trailing sentence punctuation glues onto a url in prose; a real one
      // never ends in a period or comma.
      const url = match.replace(/[.,]+$/, '');
      if (isSupabaseApexUrl(url) && !urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

/** True when no separate command can contribute to a shell fetch's combined result. */
function shellFetchOwnsResult(command: string): boolean {
  const withoutIgnoredFailure = command.replace(
    /\|\|\s*true\s*(?=(?:["'])?\s*$)/,
    ''
  );
  return !SHELL_COMMAND_LIST_PATTERN.test(withoutIgnoredFailure);
}

/**
 * Codex's `web_search` action, the tool's own statement of what it did. Only
 * `type` and `url` matter here: `query` is already carried separately, and no
 * other field says anything about which page was read.
 */
function webSearchAction(
  body: Record<string, unknown>
): { type: string; url?: string } | undefined {
  const action = body.action;
  if (!isRecord(action) || typeof action.type !== 'string') return undefined;
  const url = typeof action.url === 'string' ? action.url : undefined;
  return { type: action.type, url };
}

/** The in-container path a truncated result was persisted to, if `result` is one of the known stub shapes. */
function extractTruncatedResultPath(result: unknown): string | undefined {
  if (typeof result !== 'string') return undefined;
  const match = result.match(TRUNCATION_PATH_PATTERN);
  // Trailing punctuation sometimes glues onto the path ("file.txt.\nFormat:
  // ..."); a real path never ends in ".", so stripping it is always safe.
  return match?.[1].replace(/\.+$/, '');
}

/** Best-effort size (in characters) a truncation stub reports about the result it's standing in for. */
function extractTruncatedResultCharCount(result: string): number | undefined {
  const exact = result.match(TRUNCATION_EXACT_SIZE_PATTERN);
  if (exact) return Number(exact[1].replace(/,/g, ''));
  const approx = result.match(TRUNCATION_APPROX_SIZE_PATTERN);
  if (!approx) return undefined;
  const unit = approx[2]?.toUpperCase();
  const multiplier = unit === 'M' ? 1024 * 1024 : unit === 'K' ? 1024 : 1;
  return Math.round(Number(approx[1]) * multiplier);
}

/** Approximate size of a tool result, in characters, favoring a truncation stub's own reported size when present. */
function resultCharCount(result: unknown): number | undefined {
  if (typeof result !== 'string') {
    if (result === undefined) return undefined;
    return JSON.stringify(result).length;
  }
  return extractTruncatedResultCharCount(result) ?? result.length;
}

/** True when a tool call is one of the channels docs activation tracks (worth rehydrating if truncated). */
function isDocsRelatedCall(call: ToolCallRecord): boolean {
  return (
    call.endpoint.endsWith('search_docs') ||
    call.name === 'web_fetch' ||
    call.name === 'web_search' ||
    shellFetchUrls(shellCommand(call)).length > 0
  );
}

/** Fetches a truncated docs call's real result back from disk. Must run before the sandbox disposes, the file lives inside that container. */
export async function rehydrateTruncatedDocsResults(
  sandbox: DocsResultSandbox,
  toolCalls: ToolCallRecord[]
): Promise<void> {
  for (const call of toolCalls) {
    if (!isDocsRelatedCall(call)) continue;
    const path = extractTruncatedResultPath(call.result);
    if (!path) continue;
    try {
      call.result = await sandbox.readFile(path);
    } catch {}
  }
}

/** Whether a search_docs query's field selection asks for `content`, checked against the query text so it survives truncation. */
function queryRequestsContent(graphqlQuery: string): boolean {
  return /\bcontent\b/.test(graphqlQuery.replace(/"[^"]*"/g, ''));
}

/** Extracts `{url, title}` pairs from a tool result, however much of it survived truncation. */
function extractPages(result: unknown): DocsCallPage[] {
  const raw =
    typeof result === 'string' ? result : JSON.stringify(result ?? '');
  // Some harnesses wrap the response in a content-array whose `text` is
  // itself a JSON string, double-escaping inner quotes when stringified.
  // Unescape once so `\"href\":\"` still matches plain `"href":"`.
  const text = raw.replace(/\\"/g, '"');

  const pages: DocsCallPage[] = [];
  const seen = new Set<string>();
  for (const [, title, url] of text.matchAll(TITLED_PAGE_PATTERN)) {
    if (!isSupabaseApexUrl(url) || seen.has(url)) continue;
    seen.add(url);
    pages.push(title ? { url, title } : { url });
  }
  for (const [, url] of text.matchAll(HREF_PATTERN)) {
    if (!isSupabaseApexUrl(url) || seen.has(url)) continue;
    seen.add(url);
    pages.push({ url });
  }
  return pages;
}

/** Builds the persisted docs activation summary for one eval run, one entry per docs-related tool call in the order they happened. */
export function buildDocsResult(toolCalls: ToolCallRecord[]): DocsResult {
  const calls: DocsCall[] = [];

  for (const call of toolCalls) {
    const { endpoint, body, result } = call;

    if (endpoint.endsWith('search_docs')) {
      const graphqlQuery = extractGraphqlQuery(body);
      if (!graphqlQuery) continue;
      calls.push({
        source: 'search_docs',
        query: graphqlQuery,
        hasContent: queryRequestsContent(graphqlQuery),
        pages: extractPages(result),
        resultChars: resultCharCount(result),
      });
      continue;
    }

    if (call.name === 'web_fetch') {
      if (!call.url || !isSupabaseApexUrl(call.url)) continue;
      // WebFetch runs the fetch through an LLM extraction step guided by
      // `prompt`, so that's the meaningful "ask" here (same role `query`
      // plays for search_docs), not the url. Url still recorded, in `pages`.
      const prompt = typeof body.prompt === 'string' ? body.prompt : undefined;
      calls.push({
        source: 'web_fetch',
        query: prompt ?? call.url,
        hasContent: true,
        pages: [{ url: call.url }],
        resultChars: resultCharCount(result),
      });
      continue;
    }

    if (call.name === 'web_search') {
      const query = typeof body.query === 'string' ? body.query : undefined;
      if (!query) continue;

      // Codex states what its hosted search did, so trust that over the shape
      // of the query string, which renders a page open and a search for that
      // same url identically.
      //
      // Only `search` actually arrives intact on CLI 0.138: exec re-parses the
      // app-server action, which serializes camelCase (`openPage`), into a
      // snake_case enum (`open_page`), so both page-reading variants land on
      // the catch-all and reach us as `other`. `search` survives because it's
      // one word in either casing. The `other` calls fall through to the
      // url-shape branch below, same as before. See codex's
      // event_processor_with_jsonl_output.rs (the from_value round trip) and
      // app-server-protocol v2/item.rs vs protocol/models.rs for the two enums.
      const action = webSearchAction(body);

      if (action?.type === 'open_page' || action?.type === 'find_in_page') {
        if (!action.url || !isSupabaseApexUrl(action.url)) continue;
        calls.push({
          source: 'web_search',
          query,
          hasContent: true,
          pages: [{ url: action.url }],
          resultChars: resultCharCount(result),
        });
        continue;
      }

      if (action?.type === 'search') {
        if (!/supabase/i.test(query)) continue;
        // No page to attribute: the hits never reach the client. `hasContent`
        // stays unknown rather than false, because those hits carry snippet
        // text the model may well have read, and we can't see it either way.
        // The gain over the url-shape fallback is knowing this wasn't a page
        // open even when the query happens to be a bare url.
        calls.push({
          source: 'web_search',
          query,
          pages: [],
          resultChars: resultCharCount(result),
        });
        continue;
      }

      // No action reported (Claude Code, or an action type we don't know):
      // fall back to the query's shape, which is all there is to go on.
      if (URL_PATTERN.test(query)) {
        if (!isSupabaseApexUrl(query)) continue;
        calls.push({
          source: 'web_search',
          query,
          pages: [{ url: query }],
          resultChars: resultCharCount(result),
        });
        continue;
      }

      if (!/supabase/i.test(query)) continue;
      const pages = extractPages(result);
      // Claude Code's WebSearch result never carries page text, only
      // title/url per hit, so any pages found here are hits, not reads.
      calls.push({
        source: 'web_search',
        query,
        hasContent: pages.length > 0 ? false : undefined,
        pages,
        resultChars: resultCharCount(result),
      });
      continue;
    }

    if (call.name === 'shell') {
      const command = shellCommand(call);
      const urls = shellFetchUrls(command);
      if (!command || urls.length === 0) continue;
      // A non-zero exit already proves the fetch failed.
      if (call.error) continue;
      // With no shell output at all, nothing from the fetch reached the model.
      if (typeof result !== 'string' || result.length === 0) continue;
      // curl without -f/--fail exits 0 on a 4xx/5xx. wget doesn't need the
      // check: it already exits non-zero on an HTTP error by default
      // (https://www.gnu.org/software/wget/manual/html_node/Exit-Status.html).
      const curlExitUnproven =
        CURL_PATTERN.test(command) && !CURL_FAIL_FLAG_PATTERN.test(command);
      const ownsResult = shellFetchOwnsResult(command);
      calls.push({
        source: 'shell_fetch',
        query: command,
        hasContent: !curlExitUnproven && ownsResult ? true : undefined,
        pages: urls.map((url) => ({ url })),
        resultChars: resultCharCount(result),
      });
      continue;
    }
  }

  return { calls };
}
