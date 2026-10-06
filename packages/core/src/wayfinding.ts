import { buildDocsResult } from './docs-results.js';
import type { ToolCallRecord } from './index.js';

/** How the agent first touched the docs. */
export type WayfindingEntrySurface =
  | 'llms_txt'
  | 'docs_home'
  | 'search_docs'
  | 'web_search'
  | 'markdown_page'
  | 'html_page'
  | 'none';

/**
 * Where a fetched url came from: the docs root the prompt names, a
 * well-known agent file (`llms.txt`), an earlier search result, a link on an
 * earlier fetched page, or none of those.
 */
export type WayfindingProvenance =
  | 'prompt'
  | 'convention'
  | 'search'
  | 'link'
  | 'guess';

export interface WayfindingFetch {
  url: string;
  path: string;
  /** The navigator refused it: the url wasn't linked from a page the agent had opened. */
  blocked?: boolean;
  /** Where the url redirected, when it did. */
  redirectedTo?: string;
  provenance: WayfindingProvenance;
  isTarget: boolean;
  isAlternate: boolean;
  notFound: boolean;
}

export interface WayfindingSearch {
  query: string;
  /** Whether a target or alternate was among the results the agent saw. */
  targetHit: boolean;
  /** The CLI cut the result down to a preview and saved the rest to a file. */
  truncated: boolean;
  /** The agent opened that saved file with Read or Grep. */
  opened: boolean;
}

export interface WayfindingResult {
  entrySurface: WayfindingEntrySurface;
  /** Docs calls made before the first one that delivered a target or alternate; null if none did. */
  hopsToTarget: number | null;
  reachedTarget: string | null;
  /** The first page reached was an alternate, a duplicate of a target. */
  viaAlternate: boolean;
  docsCalls: number;
  fetches: WayfindingFetch[];
  /** Content pages fetched that are neither targets nor alternates, in order, without repeats. */
  otherPages: string[];
  notFound: string[];
  searches: WayfindingSearch[];
  /**
   * Fetches of a docs search endpoint (`/docs/api/...`), a workaround in an
   * experiment that withholds the search tool.
   */
  searchApiFetches: string[];
  /**
   * Urls the docs navigator refused because no opened page linked them: the
   * agent reaching for a page it remembers instead of navigating to it.
   */
  blockedFetches: string[];
  severity: WayfindingSeverity;
}

/**
 * How bad a run's wayfinding was, by hops to the target. Ten hops or more, or
 * never reaching it, is a big failure.
 */
export type WayfindingSeverity =
  | 'clean'
  | 'friction'
  | 'failure'
  | 'big failure';

export const SEVERITY_HOPS = {
  friction: 4,
  failure: 7,
  bigFailure: 10,
} as const;

export function severityOf(hopsToTarget: number | null): WayfindingSeverity {
  if (hopsToTarget === null || hopsToTarget >= SEVERITY_HOPS.bigFailure)
    return 'big failure';
  if (hopsToTarget >= SEVERITY_HOPS.failure) return 'failure';
  if (hopsToTarget >= SEVERITY_HOPS.friction) return 'friction';
  return 'clean';
}

const NAVIGATOR_TOOL = 'open_page';
// The docs navigator's refusal, from experiments/docs/lib/docs-navigator.mjs.
const NAVIGATOR_BLOCKED_PREFIX = 'Not opened:';

/** A docs navigator `open_page` call, read as the page fetch it is. */
function asPageFetch(call: ToolCallRecord): ToolCallRecord {
  if (call.tool.toolName !== NAVIGATOR_TOOL) return call;
  const url = typeof call.body.url === 'string' ? call.body.url : undefined;
  return url ? { ...call, name: 'web_fetch', url } : call;
}

function isBlocked(call: ToolCallRecord): boolean {
  return (
    call.tool.toolName === NAVIGATOR_TOOL &&
    `${call.error ?? ''}${resultText(call)}`.includes(NAVIGATOR_BLOCKED_PREFIX)
  );
}

/** Returns every url linked from the page at `url`, as the agent's fetch would have seen it. */
export type FetchLinks = (url: string) => Promise<string[]>;

/**
 * Returns every version of a docs page's markdown an agent could read, by docs
 * path: the published page, and the copy in the search index, which can lag.
 */
export type FetchPageVersions = (path: string) => Promise<string[]>;

/** Returns the docs path a path redirects to, or the path itself. */
export type ResolveRedirect = (path: string) => Promise<string>;

const DOCS_ROOT = 'docs';
const LINK_PATTERNS = [
  /\]\(([^)\s]+)\)/g,
  /href="([^"]+)"/g,
  /https:\/\/supabase\.com\/[^\s)"'<>\]]+/g,
];
// Same stub shapes docs-results.ts rehydrates from.
const PERSISTED_PATH_PATTERN =
  /(?:Output has been saved to|Full output saved to:)\s*(\S+)/;
// Agents print a saved search result in their own format (jq, a node or
// python script), so a result's url is any supabase.com url in the output.
const OUTPUT_URL_PATTERN = /https:\/\/supabase\.com\/[^\s"'`)<>\]\\]+/g;
// A page counts as read when this many of its fingerprints show up in what
// the agent saw, or all of them for a page with fewer.
const FINGERPRINTS_PER_PAGE = 8;
const FINGERPRINTS_TO_READ = 2;
const FINGERPRINT_CHARS = 60;

/** Every docs path a tool output names by url. */
function urlPaths(text: string): string[] {
  return [...text.matchAll(OUTPUT_URL_PATTERN)]
    .map((match) => docsPath(match[0]))
    .filter((path): path is string => path !== null);
}

/** Lowercase words only, so markdown, JSON escaping, and spacing don't matter. */
function normalize(text: string): string {
  return text
    .replace(/\\[nrt]/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Distinctive snippets of a page's prose: the start of its longest plain
 * paragraphs lines, skipping headings, code, tables, lists, and components.
 */
export function pageFingerprints(markdown: string): string[] {
  let inCode = false;
  const lines: string[] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) inCode = !inCode;
    if (inCode || !/^[A-Za-z]/.test(line)) continue;
    const words = normalize(line);
    if (words.length >= FINGERPRINT_CHARS) lines.push(words);
  }
  return [...new Set(lines)]
    .sort((a, b) => b.length - a.length)
    .slice(0, FINGERPRINTS_PER_PAGE)
    .map((words) => words.slice(0, FINGERPRINT_CHARS));
}

/** Whether a tool output contains enough of a page's fingerprints to count as reading it. */
function showsPage(normalizedOutput: string, fingerprints: string[]): boolean {
  if (fingerprints.length === 0) return false;
  const needed = Math.min(FINGERPRINTS_TO_READ, fingerprints.length);
  return (
    fingerprints.filter((fp) => normalizedOutput.includes(fp)).length >= needed
  );
}

/**
 * A supabase.com url as a comparable path: `docs/` and `.md` dropped, no
 * trailing slash, query, or anchor. The docs root is `docs`; pages outside
 * it keep their full path (`llms.txt`). Null for other hosts.
 */
export function docsPath(url: string, base?: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'supabase.com') return null;
  const path = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.md$/, '');
  if (path === DOCS_ROOT) return DOCS_ROOT;
  return path.startsWith(`${DOCS_ROOT}/`)
    ? path.slice(DOCS_ROOT.length + 1)
    : path;
}

function isLlmsPath(path: string): boolean {
  return /(^|\/)llms(-full)?\.txt$/.test(path) || /(^|\/)llms\//.test(path);
}

function entrySurfaceOf(
  source: string,
  url: string | undefined
): WayfindingEntrySurface {
  if (source === 'search_docs') return 'search_docs';
  if (source === 'web_search' && !url) return 'web_search';
  const path = url ? docsPath(url) : null;
  if (path === null) return 'none';
  if (isLlmsPath(path)) return 'llms_txt';
  if (path === DOCS_ROOT) return 'docs_home';
  return url?.replace(/[?#].*$/, '').endsWith('.md')
    ? 'markdown_page'
    : 'html_page';
}

/** The search term inside a `searchDocs(query: "...")` GraphQL call, else the raw query. */
function searchTerm(query: string): string {
  return query.match(/query:\s*"([^"]*)"/)?.[1] ?? query;
}

function resultText(call: ToolCallRecord): string {
  const raw =
    typeof call.result === 'string'
      ? call.result
      : JSON.stringify(call.result ?? '');
  return raw.replace(/\\"/g, '"');
}

/** WebFetch reports a missing page as an error or a failed-status result. */
function isNotFound(call: ToolCallRecord): boolean {
  const text = [call.error, typeof call.result === 'string' ? call.result : '']
    .filter(Boolean)
    .join('\n');
  return /status code 404|404 not found/i.test(text);
}

/** The file a Read or Grep call opened, if any. */
/** Whether a Read, Grep, or shell call opened the file at `saved`. */
function opens(call: ToolCallRecord, saved: string): boolean {
  if (call.name === 'shell') {
    const command = call.command ?? call.body.command;
    return typeof command === 'string' && command.includes(saved);
  }
  if (call.name !== 'file_read' && call.name !== 'grep') return false;
  const { file_path, path } = call.body;
  return [call.path, file_path, path].includes(saved);
}

/** Extracts every supabase.com docs path linked from a page's raw text. */
export function linkedPaths(text: string, pageUrl: string): string[] {
  const paths = new Set<string>();
  for (const pattern of LINK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const path = docsPath(match[1] ?? match[0], pageUrl);
      if (path !== null) paths.add(path);
    }
  }
  return [...paths];
}

const linkCache = new Map<string, Promise<string[]>>();

/** Fetches the page the agent fetched and lists its links. Cached per url. */
export const fetchLinksFromNetwork: FetchLinks = (url) => {
  let links = linkCache.get(url);
  if (!links) {
    links = fetch(url, { signal: AbortSignal.timeout(15_000) })
      .then((res) => (res.ok ? res.text() : ''))
      .then((text) => linkedPaths(text, url))
      .catch(() => []);
    linkCache.set(url, links);
  }
  return links;
};

const SEARCH_INDEX_QUERY = `query ($query: String!) {
  searchDocs(query: $query, limit: 10) { nodes { href ... on Guide { content } } }
}`;

async function fetchPublishedPage(path: string): Promise<string> {
  try {
    const res = await fetch(`https://supabase.com/docs/${path}.md`, {
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  }
}

/** The search index's copy of a page, found by searching for its title. */
async function fetchIndexedPage(path: string, title: string): Promise<string> {
  try {
    const res = await fetch('https://supabase.com/docs/api/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: SEARCH_INDEX_QUERY,
        variables: { query: title },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return '';
    const body = await res.json();
    const nodes: Array<{ href?: string; content?: string }> =
      body?.data?.searchDocs?.nodes ?? [];
    return (
      nodes.find((node) => node.href && docsPath(node.href) === path)
        ?.content ?? ''
    );
  } catch {
    return '';
  }
}

const redirectCache = new Map<string, Promise<string>>();

/** Follows a docs path's redirects on supabase.com. Cached per path. */
export const resolveRedirectFromNetwork: ResolveRedirect = (path) => {
  let resolved = redirectCache.get(path);
  if (!resolved) {
    resolved = fetch(`https://supabase.com/docs/${path}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15_000),
    })
      .then((res) => (res.redirected ? (docsPath(res.url) ?? path) : path))
      .catch(() => path);
    redirectCache.set(path, resolved);
  }
  return resolved;
};

const pageVersionsCache = new Map<string, Promise<string[]>>();

/** Fetches a page's published markdown and its search index copy. Cached per path. */
export const fetchPageVersionsFromNetwork: FetchPageVersions = (path) => {
  let versions = pageVersionsCache.get(path);
  if (!versions) {
    versions = fetchPublishedPage(path).then(async (published) => {
      const title =
        published.match(/^# (.+)$/m)?.[1] ?? path.split('/').at(-1) ?? path;
      const indexed = await fetchIndexedPage(path, title);
      return [published, indexed].filter(Boolean);
    });
    pageVersionsCache.set(path, versions);
  }
  return versions;
};

/**
 * Scores how an agent found its way to the docs pages a task needs: where it
 * entered, how many docs calls it took to reach a target, which pages it
 * fetched on the way, and whether each fetched url came from search, a link,
 * or a guess.
 *
 * Runs on the tool calls as the agent saw them. A truncated search result
 * shows only its preview. Any later tool output, such as a script the agent
 * ran over the saved file, reads a target page when it contains that page's
 * own prose, matched by fingerprints of the published markdown or of the
 * search index's copy.
 */
export async function scoreWayfinding({
  toolCalls,
  targets,
  alternates = [],
  fetchLinks = fetchLinksFromNetwork,
  fetchPageVersions = fetchPageVersionsFromNetwork,
  resolveRedirect = resolveRedirectFromNetwork,
}: {
  toolCalls: ToolCallRecord[];
  /** Target pages as docs paths, e.g. `guides/database/postgres/row-level-security`. */
  targets: string[];
  /** Duplicates of a target that answer the task just as well. */
  alternates?: string[];
  fetchLinks?: FetchLinks;
  fetchPageVersions?: FetchPageVersions;
  resolveRedirect?: ResolveRedirect;
}): Promise<WayfindingResult> {
  const targetSet = new Set(targets);
  const alternateSet = new Set(alternates);
  const isWanted = (path: string) =>
    targetSet.has(path) || alternateSet.has(path);
  const fingerprints = await Promise.all(
    [...targetSet, ...alternateSet].map(
      async (path) =>
        [path, (await fetchPageVersions(path)).map(pageFingerprints)] as const
    )
  );
  const pagesShownBy = (text: string) => {
    const words = normalize(text);
    return fingerprints
      .filter(([, versions]) =>
        versions.some((prints) => showsPage(words, prints))
      )
      .map(([path]) => path);
  };

  const searchedPaths = new Set<string>();
  const fetchedUrls: string[] = [];
  const fetches: WayfindingFetch[] = [];
  const searches: WayfindingSearch[] = [];
  const persisted = new Map<
    string,
    { hop: number; search: WayfindingSearch }
  >();
  let lastTruncated: { hop: number; search: WayfindingSearch } | undefined;
  let docsCalls = 0;
  let entrySurface: WayfindingEntrySurface = 'none';
  let hopsToTarget: number | null = null;
  let reachedTarget: string | null = null;

  const reach = (hop: number, paths: string[]) => {
    const path = paths.find(isWanted);
    if (path === undefined || hopsToTarget !== null) return;
    hopsToTarget = hop;
    reachedTarget = path;
  };

  for (const original of toolCalls) {
    const toolCall = asPageFetch(original);
    const blocked = isBlocked(original);
    const call = buildDocsResult([toolCall]).calls[0];
    if (!call) {
      // Not a docs call: a Read, Grep, or script, often over a saved search
      // result. Credit what it shows to the most recent truncated search.
      const text = resultText(toolCall);
      const read = pagesShownBy(text);
      const saved =
        [...persisted].find(([file]) => opens(toolCall, file))?.[1] ??
        (read.length > 0 ? lastTruncated : undefined);
      if (saved) {
        const seen = urlPaths(text);
        saved.search.opened = true;
        saved.search.targetHit ||= [...seen, ...read].some(isWanted);
        for (const path of seen) searchedPaths.add(path);
      }
      if (docsCalls > 0) reach(saved?.hop ?? docsCalls - 1, read);
      continue;
    }
    const hop = docsCalls++;
    const isFetch =
      call.source === 'web_fetch' || call.source === 'shell_fetch';
    const notFound =
      isFetch &&
      toolCall.name === 'web_fetch' &&
      !blocked &&
      isNotFound(toolCall);
    // The agent read nothing from a missing or refused page.
    const unread = notFound || blocked;
    const pages: Array<{ url: string; path: string; landed: string }> = [];
    for (const page of call.pages) {
      const path = docsPath(page.url);
      if (path === null) continue;
      // Only a fetch follows a redirect; a search result names its own page.
      const landed =
        isFetch && !unread && !isWanted(path)
          ? await resolveRedirect(path)
          : path;
      pages.push({ url: page.url, path, landed });
    }

    if (hop === 0) {
      entrySurface = entrySurfaceOf(
        call.source,
        isFetch || call.hasContent ? call.pages[0]?.url : undefined
      );
    }

    const truncatedTo = isFetch
      ? undefined
      : resultText(toolCall).match(PERSISTED_PATH_PATTERN)?.[1];
    if (!isFetch) {
      const search: WayfindingSearch = {
        query: searchTerm(call.query),
        targetHit: pages.some(({ path }) => isWanted(path)),
        truncated: truncatedTo !== undefined,
        opened: false,
      };
      searches.push(search);
      if (truncatedTo) {
        lastTruncated = { hop, search };
        persisted.set(truncatedTo.replace(/\.+$/, ''), lastTruncated);
      }
    }

    if (isFetch) {
      for (const { url, path, landed } of pages) {
        fetches.push({
          url,
          path,
          ...(landed !== path ? { redirectedTo: landed } : {}),
          provenance: await provenanceOf(
            path,
            searchedPaths,
            fetchedUrls,
            fetchLinks
          ),
          isTarget: targetSet.has(landed),
          isAlternate: alternateSet.has(landed),
          notFound,
          ...(blocked ? { blocked } : {}),
        });
        if (!blocked) fetchedUrls.push(url);
      }
    }

    // A truncated result's preview is a sliver of one page, not a read.
    if (call.hasContent === true && !unread && !truncatedTo) {
      reach(
        hop,
        pages.map(({ landed }) => landed)
      );
    }
    if (!isFetch) for (const { path } of pages) searchedPaths.add(path);
  }

  return {
    entrySurface,
    hopsToTarget,
    reachedTarget,
    viaAlternate: reachedTarget !== null && !targetSet.has(reachedTarget),
    docsCalls,
    fetches,
    otherPages: [
      ...new Set(
        fetches
          .filter(
            (f) =>
              !f.isTarget &&
              !f.isAlternate &&
              !f.notFound &&
              !f.blocked &&
              f.path !== DOCS_ROOT &&
              !isLlmsPath(f.path)
          )
          .map((f) => f.path)
      ),
    ],
    notFound: [
      ...new Set(fetches.filter((f) => f.notFound).map((f) => f.path)),
    ],
    searches,
    blockedFetches: [
      ...new Set(fetches.filter((f) => f.blocked).map((f) => f.path)),
    ],
    severity: severityOf(hopsToTarget),
    searchApiFetches: [
      ...new Set(
        fetches.filter((f) => f.path.startsWith('api/')).map((f) => f.path)
      ),
    ],
  };
}

async function provenanceOf(
  path: string,
  searchedPaths: Set<string>,
  fetchedUrls: string[],
  fetchLinks: FetchLinks
): Promise<WayfindingProvenance> {
  if (path === DOCS_ROOT) return 'prompt';
  if (isLlmsPath(path)) return 'convention';
  if (searchedPaths.has(path)) return 'search';
  for (const url of fetchedUrls) {
    if ((await fetchLinks(url)).includes(path)) return 'link';
  }
  return 'guess';
}
