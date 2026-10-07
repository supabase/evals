/**
 * Builds a proposed docs tree from a compact spec, and checks it against the
 * tree rules: every page in today's tree appears exactly once, and no node has
 * more than 7 children.
 *
 * A spec node is either a page path, like `guides/platform/sso`, which keeps
 * today's label and route, or an object:
 *
 *   { "label": "Organization access", "page": "guides/platform/access-control",
 *     "children": ["guides/platform/sso", ...] }
 *
 * `page` makes a group link a page too, and `label` alone on a page node
 * renames it. `newRoute` proposes a new url for the page, and `new: true`
 * marks a page that doesn't exist yet, such as a new hub, with `route`.
 * `splitFrom`, like `guides/getting-started/api-keys#leaked-key`, with a
 * `label` makes a new page out of a section of a page in today's tree.
 *
 * Usage: pnpm docs-tree-build -- <spec.json> <out.json> [--allow-missing]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type DocsTree,
  indexTree,
  loadTree,
  MAX_CHILDREN,
  routePage,
  type TreeNode,
  treeStats,
} from '../../../experiments/docs/lib/docs-tree.js';

type SpecNode =
  | string
  | {
      label?: string;
      page?: string;
      route?: string;
      newRoute?: string;
      new?: boolean;
      splitFrom?: string;
      children?: SpecNode[];
    };
type Spec = { name: string; description: string; root: SpecNode[] };

const cwd = process.env.INIT_CWD ?? process.cwd();
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const allowMissing = args.includes('--allow-missing');
const [specArg, outArg] = args.filter((arg) => !arg.startsWith('--'));
if (!specArg || !outArg) {
  console.error('Usage: pnpm docs-tree-build -- <spec.json> <out.json>');
  process.exit(1);
}
const spec: Spec = JSON.parse(readFileSync(resolve(cwd, specArg), 'utf8'));

// Today's label and route for each page: its first link in the tree. A
// generic label like "Overview" takes its group's label instead.
const GENERIC_LABEL = /^(overview|guide|introduction)$/i;
const today = new Map<string, { label: string; route: string }>();
for (const node of indexTree(loadTree('today'))) {
  if (!node.page || !node.route || today.has(node.page)) continue;
  const label = GENERIC_LABEL.test(node.label)
    ? (node.trail.at(-2) ?? node.label)
    : node.label;
  today.set(node.page, { label, route: node.route });
}

const errors: string[] = [];

function build(node: SpecNode, trail: string[]): TreeNode {
  if (typeof node === 'string') node = { page: node };
  if (node.splitFrom) {
    const source = routePage(node.splitFrom);
    if (!today.has(source) || !node.splitFrom.includes('#'))
      errors.push(
        `${[...trail, node.splitFrom].join(' > ')}: splitFrom needs a page in today's tree and a section anchor`
      );
    if (!node.label) errors.push(`${trail.join(' > ')}: a split needs a label`);
    return {
      label: node.label ?? '?',
      route: `/${node.splitFrom.replace(/^\/+/, '')}`,
      split: true,
    };
  }
  const page = node.page ? routePage(node.page) : undefined;
  const known = page ? today.get(page) : undefined;
  if (page && !known && !node.new)
    errors.push(`${[...trail, page].join(' > ')}: not a page in today's tree`);
  const label = node.label ?? known?.label;
  if (!label) errors.push(`${trail.join(' > ')}: a node needs a label`);
  const here = [...trail, label ?? '?'];
  return {
    label: label ?? '?',
    ...(page ? { route: node.route ?? known?.route ?? `/${page}` } : {}),
    ...(node.newRoute ? { newRoute: node.newRoute } : {}),
    ...(node.new ? { new: true } : {}),
    ...(node.children?.length
      ? { children: node.children.map((child) => build(child, here)) }
      : {}),
  };
}

const tree: DocsTree = {
  name: spec.name,
  description: spec.description,
  root: {
    label: 'Supabase Docs',
    children: spec.root.map((node) => build(node, [])),
  },
};

const stats = treeStats(tree);
const placed = new Set(
  indexTree(tree)
    .map((node) => node.page)
    .filter(Boolean)
);
const missing = [...today.keys()].filter((page) => !placed.has(page));
for (const node of stats.wideNodes)
  errors.push(
    `${node.trail} has ${node.children} children, over ${MAX_CHILDREN}`
  );
for (const dup of stats.duplicatePages)
  errors.push(
    `${dup.page} appears ${dup.trails.length} times: ${dup.trails.join(' | ')}`
  );
if (!allowMissing)
  for (const page of missing) errors.push(`${page} is missing`);

writeFileSync(resolve(cwd, outArg), `${JSON.stringify(tree, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      pages: stats.pages,
      missing: missing.length,
      maxDepth: stats.maxDepth,
      maxChildren: stats.maxChildren,
      linkDepths: stats.linkDepths,
    },
    null,
    2
  )
);
if (errors.length) {
  console.error(`${errors.length} problems:\n${errors.join('\n')}`);
  process.exit(1);
}
console.log(`OK: wrote ${outArg}`);
