/**
 * The fewest clicks from the docs homepage to each wayfinding target, with
 * no model involved: a breadth-first crawl over exactly the links the docs
 * navigator shows an agent. Runs twice, on the docs as they are and with the
 * proposed IA fixes in `PROPOSED_LINKS`, to show what each fix saves.
 *
 * Usage: pnpm wayfinding-click-depth [--max-depth 6]
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DOCS_ROOT,
  type PageLink,
  pageLinks,
} from '../../../experiments/docs/lib/docs-navigator.mjs';
import { PROPOSED_LINKS } from '../../../experiments/docs/lib/proposed-links.js';
import { readRepeatedFlag } from '../lib/cli-args.js';
import { ROOT } from '../lib/result-files.js';

const MAX_DEPTH = Number(
  readRepeatedFlag(process.argv.slice(2), 'max-depth')[0] ?? 6
);
const CONCURRENCY = 8;
const EVALS_DIR = join(ROOT, 'evals', 'wayfinding');

type Overlay = Record<string, PageLink[]>;
type Visit = { depth: number; parent?: string };

/** Each page's own links, fetched once and shared by both crawls. */
const linkCache = new Map<
  string,
  Promise<{ finalUrl: string; links: PageLink[] }>
>();
function linksOf(url: string) {
  let links = linkCache.get(url);
  if (!links) {
    links = pageLinks(url)
      .then(({ finalUrl, links }) => ({ finalUrl, links }))
      .catch(() => ({ finalUrl: url, links: [] }));
    linkCache.set(url, links);
  }
  return links;
}

async function crawl(overlay: Overlay, wanted: Set<string>) {
  const visits = new Map<string, Visit>([[DOCS_ROOT, { depth: 0 }]]);
  let frontier = [DOCS_ROOT];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    if ([...wanted].every((url) => visits.has(url))) break;
    const next: string[] = [];
    for (let i = 0; i < frontier.length; i += CONCURRENCY) {
      const batch = frontier.slice(i, i + CONCURRENCY);
      const pages = await Promise.all(batch.map(linksOf));
      for (const [index, { finalUrl, links }] of pages.entries()) {
        const from = batch[index];
        for (const { href } of [...(overlay[finalUrl] ?? []), ...links]) {
          if (visits.has(href)) continue;
          visits.set(href, { depth: depth + 1, parent: from });
          // Only docs pages are opened further; other pages are dead ends.
          if (href.startsWith(`${DOCS_ROOT}/`)) next.push(href);
        }
      }
    }
    frontier = next;
  }
  return visits;
}

function pathTo(visits: Map<string, Visit>, url: string): string {
  const steps: string[] = [];
  for (let at: string | undefined = url; at; at = visits.get(at)?.parent) {
    steps.unshift(at === DOCS_ROOT ? 'home' : at.replace(`${DOCS_ROOT}/`, ''));
  }
  return steps.join(' → ');
}

// Every eval's targets and alternates, as navigator urls.
const evals: Array<{ id: string; urls: string[] }> = [];
for (const id of readdirSync(EVALS_DIR)
  .filter((d) => d.includes('-wayfinding-'))
  .sort()) {
  const mod = await import(pathToFileURL(join(EVALS_DIR, id, 'EVAL.ts')).href);
  const paths: string[] = [...(mod.TARGETS ?? []), ...(mod.ALTERNATES ?? [])];
  evals.push({ id, urls: paths.map((path) => `${DOCS_ROOT}/${path}`) });
}
const wanted = new Set(evals.flatMap(({ urls }) => urls));

const today = await crawl({}, wanted);
const fixed = await crawl(PROPOSED_LINKS, wanted);

/** The nearest of an eval's pages: its click depth and path. */
function nearest(visits: Map<string, Visit>, urls: string[]) {
  const found = urls
    .filter((url) => visits.has(url))
    .sort(
      (a, b) => (visits.get(a)?.depth ?? 0) - (visits.get(b)?.depth ?? 0)
    )[0];
  return found
    ? { clicks: `${visits.get(found)?.depth}`, path: pathTo(visits, found) }
    : { clicks: `>${MAX_DEPTH}`, path: '–' };
}

console.log(
  `## Fewest clicks from the docs homepage (crawled ${linkCache.size} pages)\n`
);
console.log(
  '| Eval | Clicks today | Path today | Clicks with proposed links | Path with proposed links |'
);
console.log('| --- | --- | --- | --- | --- |');
for (const { id, urls } of evals) {
  const now = nearest(today, urls);
  const then = nearest(fixed, urls);
  console.log(
    `| ${id.replace(/^\w+-wayfinding-/, '')} | ${now.clicks} | ${now.path} | ${then.clicks} | ${then.clicks === now.clicks ? 'same' : then.path} |`
  );
}
