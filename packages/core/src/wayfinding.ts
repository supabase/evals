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
}

/** Returns every url linked from the page at `url`, as the agent's fetch would have seen it. */
export type FetchLinks = (url: string) => Promise<string[]>;

const DOCS_ROOT = 'docs';
const LINK_PATTERNS = [
  /\]\(([^)\s]+)\)/g,
  /href="([^"]+)"/g,
  /https:\/\/supabase\.com\/[^\s)"'<>\]]+/g,
];
// Same stub shapes docs-results.ts rehydrates from.
const PERSISTED_PATH_PATTERN =
  /(?:Output has been saved to|Full output saved to:)\s*(\S+)/;
const RESULT_HREF_PATTERN = /"href":"(https:\/\/supabase\.com\/[^"]+)"/g;

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
function openedPath(call: ToolCallRecord): string | undefined {
  if (call.name !== 'file_read' && call.name !== 'grep') return undefined;
  if (call.path) return call.path;
  const { file_path, path } = call.body;
  if (typeof file_path === 'string') return file_path;
  return typeof path === 'string' ? path : undefined;
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
 *
 * Runs on the tool calls as the agent saw them. When the CLI cut a search
 * result down to a preview, only the preview counts until the agent opens the
 * saved file with Read or Grep.
 */
export async function scoreWayfinding({
  toolCalls,
  targets,
  alternates = [],
  fetchLinks = fetchLinksFromNetwork,
}: {
  toolCalls: ToolCallRecord[];
  /** Target pages as docs paths, e.g. `guides/database/postgres/row-level-security`. */
  targets: string[];
  /** Duplicates of a target that answer the task just as well. */
  alternates?: string[];
  fetchLinks?: FetchLinks;
}): Promise<WayfindingResult> {
  const targetSet = new Set(targets);
  const alternateSet = new Set(alternates);
  const isWanted = (path: string) =>
    targetSet.has(path) || alternateSet.has(path);

  const searchedPaths = new Set<string>();
  const fetchedUrls: string[] = [];
  const fetches: WayfindingFetch[] = [];
  const searches: WayfindingSearch[] = [];
  const persisted = new Map<
    string,
    { hop: number; search: WayfindingSearch }
  >();
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

  for (const toolCall of toolCalls) {
    const opened = openedPath(toolCall);
    const saved = opened ? persisted.get(opened) : undefined;
    if (saved) {
      const paths = [...resultText(toolCall).matchAll(RESULT_HREF_PATTERN)]
        .map((match) => docsPath(match[1]))
        .filter((path): path is string => path !== null);
      saved.search.opened = true;
      saved.search.targetHit ||= paths.some(isWanted);
      for (const path of paths) searchedPaths.add(path);
      reach(saved.hop, paths);
      continue;
    }

    const call = buildDocsResult([toolCall]).calls[0];
    if (!call) continue;
    const hop = docsCalls++;
    const isFetch =
      call.source === 'web_fetch' || call.source === 'shell_fetch';
    const notFound =
      isFetch && toolCall.name === 'web_fetch' && isNotFound(toolCall);
    const pages = call.pages.flatMap((page) => {
      const path = docsPath(page.url);
      return path === null ? [] : [{ url: page.url, path }];
    });

    if (hop === 0) {
      entrySurface = entrySurfaceOf(
        call.source,
        isFetch || call.hasContent ? call.pages[0]?.url : undefined
      );
    }

    if (!isFetch) {
      const truncatedTo = resultText(toolCall).match(
        PERSISTED_PATH_PATTERN
      )?.[1];
      const search: WayfindingSearch = {
        query: searchTerm(call.query),
        targetHit: pages.some(({ path }) => isWanted(path)),
        truncated: truncatedTo !== undefined,
        opened: false,
      };
      searches.push(search);
      if (truncatedTo)
        persisted.set(truncatedTo.replace(/\.+$/, ''), { hop, search });
    }

    if (isFetch) {
      for (const { url, path } of pages) {
        fetches.push({
          url,
          path,
          provenance: await provenanceOf(
            path,
            searchedPaths,
            fetchedUrls,
            fetchLinks
          ),
          isTarget: targetSet.has(path),
          isAlternate: alternateSet.has(path),
          notFound,
        });
        fetchedUrls.push(url);
      }
    }

    if (call.hasContent === true && !notFound) {
      reach(
        hop,
        pages.map(({ path }) => path)
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
