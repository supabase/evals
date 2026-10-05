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
  provenance: WayfindingProvenance;
  isTarget: boolean;
  notFound: boolean;
}

export interface WayfindingResult {
  entrySurface: WayfindingEntrySurface;
  /** Docs calls made before the first one that delivered a target page; null if none did. */
  hopsToTarget: number | null;
  reachedTarget: string | null;
  docsCalls: number;
  fetches: WayfindingFetch[];
  /** Content pages fetched that aren't targets, in order, without repeats. */
  wrongPages: string[];
  notFound: string[];
  searches: Array<{ query: string; targetHit: boolean }>;
}

/** Returns every url linked from the page at `url`, as the agent's fetch would have seen it. */
export type FetchLinks = (url: string) => Promise<string[]>;

const DOCS_ROOT = 'docs';
const LINK_PATTERNS = [
  /\]\(([^)\s]+)\)/g,
  /href="([^"]+)"/g,
  /https:\/\/supabase\.com\/[^\s)"'<>\]]+/g,
];

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

/** WebFetch reports a missing page as an error or a failed-status result. */
function isNotFound(call: ToolCallRecord): boolean {
  const text = [call.error, typeof call.result === 'string' ? call.result : '']
    .filter(Boolean)
    .join('\n');
  return /status code 404|404 not found/i.test(text);
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

/**
 * Scores how an agent found its way to the docs pages a task needs: where it
 * entered, how many docs calls it took to reach a target, which pages it
 * fetched on the way, and whether each fetched url came from search, a link,
 * or a guess.
 */
export async function scoreWayfinding({
  toolCalls,
  targets,
  fetchLinks = fetchLinksFromNetwork,
}: {
  toolCalls: ToolCallRecord[];
  /** Target pages as docs paths, e.g. `guides/database/postgres/row-level-security`. */
  targets: string[];
  fetchLinks?: FetchLinks;
}): Promise<WayfindingResult> {
  const targetSet = new Set(targets);
  const { calls } = buildDocsResult(toolCalls);
  const notFoundUrls = new Set(
    toolCalls
      .filter(
        (call) => call.name === 'web_fetch' && call.url && isNotFound(call)
      )
      .map((call) => call.url as string)
  );

  const searchedPaths = new Set<string>();
  const fetchedUrls: string[] = [];
  const fetches: WayfindingFetch[] = [];
  const searches: WayfindingResult['searches'] = [];
  let hopsToTarget: number | null = null;
  let reachedTarget: string | null = null;

  for (const [index, call] of calls.entries()) {
    const isFetch =
      call.source === 'web_fetch' || call.source === 'shell_fetch';
    const isSearch = !isFetch && call.hasContent !== true;
    const paths = call.pages.flatMap((page) => {
      const path = docsPath(page.url);
      return path === null ? [] : [{ url: page.url, path }];
    });

    if (isSearch || call.source === 'search_docs') {
      searches.push({
        query: searchTerm(call.query),
        targetHit: paths.some(({ path }) => targetSet.has(path)),
      });
    }

    if (isFetch) {
      for (const { url, path } of paths) {
        const provenance = await provenanceOf(
          path,
          searchedPaths,
          fetchedUrls,
          fetchLinks
        );
        fetches.push({
          url,
          path,
          provenance,
          isTarget: targetSet.has(path),
          notFound: notFoundUrls.has(url),
        });
        fetchedUrls.push(url);
      }
    }

    const delivered =
      call.hasContent === true
        ? paths.find(
            ({ url, path }) => targetSet.has(path) && !notFoundUrls.has(url)
          )
        : undefined;
    if (delivered && hopsToTarget === null) {
      hopsToTarget = index;
      reachedTarget = delivered.path;
    }

    if (!isFetch) for (const { path } of paths) searchedPaths.add(path);
  }

  const first = calls[0];
  const firstUrl =
    first &&
    (first.source === 'web_fetch' ||
      first.source === 'shell_fetch' ||
      first.hasContent)
      ? first.pages[0]?.url
      : undefined;

  return {
    entrySurface: first ? entrySurfaceOf(first.source, firstUrl) : 'none',
    hopsToTarget,
    reachedTarget,
    docsCalls: calls.length,
    fetches,
    wrongPages: [
      ...new Set(
        fetches
          .filter(
            (f) =>
              !f.isTarget &&
              !f.notFound &&
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
