/**
 * Exports the docs navigation as a tree file for tree tests, with every
 * sidebar group expanded. Reads the menu constants from a supabase/supabase
 * checkout, treats every feature flag as enabled, as production does, and
 * mirrors how the sidebar renders them:
 *
 * - The top level is the docs top nav: Start, Products, Build, Manage,
 *   Reference, and Resources.
 * - A section's header links its landing page.
 * - A top-level entry with items is a heading, and a nested entry with items
 *   is a collapsible group. Neither is a link, even when it has a url.
 * - Reference sections are generated from API specs, so they're leaves here.
 *
 * Usage: pnpm docs-tree-export -- <path to supabase/supabase> [out.json]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type DocsTree,
  type TreeNode,
  routePage,
  treeStats,
} from '../../../experiments/docs/lib/docs-tree.js';

type MenuEntry = {
  name?: string;
  url?: string;
  enabled?: boolean;
  items?: MenuEntry[];
};
type Menu = {
  title: string;
  url?: string;
  enabled?: boolean;
  items: MenuEntry[];
};
type DropdownItem = {
  label: string;
  href?: string;
  level?: string;
  enabled?: boolean;
  menuItems?: DropdownItem[][];
};

const CONSTANTS =
  'apps/docs/components/Navigation/NavigationMenu/NavigationMenu.constants.ts';

// pnpm runs scripts from the package, so paths resolve from where it was called.
const cwd = process.env.INIT_CWD ?? process.cwd();
const [checkoutArg, outArg] = process.argv
  .slice(2)
  .filter((arg) => arg !== '--');
if (!checkoutArg) {
  console.error('Usage: pnpm docs-tree-export -- <supabase checkout> [out]');
  process.exit(1);
}
const checkout = resolve(cwd, checkoutArg);
const outPath = outArg
  ? resolve(cwd, outArg)
  : fileURLToPath(
      new URL('../../../experiments/docs/trees/today.json', import.meta.url)
    );

// The constants import feature flags from the docs app. Every flag is on in
// production, so swap the import for a stub that enables everything.
const source = readFileSync(join(checkout, CONSTANTS), 'utf8').replace(
  /import \{ isFeatureEnabled \} from 'common\/enabled-features'/,
  'const isFeatureEnabled = () => new Proxy({}, { get: () => true })'
);
const dir = mkdtempSync(join(tmpdir(), 'docs-tree-'));
const modulePath = join(dir, 'constants.mts');
writeFileSync(modulePath, source);
const menus: Record<string, unknown> = await import(
  pathToFileURL(modulePath).href
);
rmSync(dir, { recursive: true });

const enabled = (item: { enabled?: boolean }) => item.enabled !== false;

function isRenderable(item: MenuEntry): boolean {
  if (!enabled(item)) return false;
  if (item.url) return true;
  return item.items?.some((child) => isRenderable(child)) ?? false;
}

const unlinkedGroupRoutes: string[] = [];

function entryNode(entry: MenuEntry): TreeNode {
  const children = (entry.items ?? []).filter((child) => isRenderable(child));
  if (children.length === 0)
    return { label: entry.name ?? '', route: entry.url };
  if (entry.url) unlinkedGroupRoutes.push(entry.url);
  return {
    label: entry.name ?? '',
    children: children.map((child) => entryNode(child)),
  };
}

function sectionNode(label: string, menu: Menu, href?: string): TreeNode {
  const children = menu.items
    .filter((entry) => isRenderable(entry))
    .map((entry) => entryNode(entry));
  return { label, route: menu.url ?? href, children };
}

function dropdownItemNode(item: DropdownItem): TreeNode {
  const menu = item.level ? (menus[item.level] as Menu | undefined) : undefined;
  const renderable = menu?.items?.filter((entry) => isRenderable(entry)) ?? [];
  // A level whose menu is a single link, such as the glossary, is a leaf.
  if (menu?.title && enabled(menu) && renderable.length > 1)
    return sectionNode(item.label, menu, item.href);
  return { label: item.label, route: item.href };
}

const global = menus.GLOBAL_MENU_ITEMS as DropdownItem[][];
const topLevel: TreeNode[] = global.flat().flatMap((item) => {
  if (!enabled(item)) return [];
  if (!item.menuItems) return [dropdownItemNode(item)];
  return [
    {
      label: item.label,
      // Column headings in a dropdown, like "Modules", aren't links.
      children: item.menuItems
        .flat()
        .filter((child) => enabled(child) && child.href)
        .map((child) => dropdownItemNode(child)),
    },
  ];
});

const commit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const tree: DocsTree = {
  name: 'today',
  description:
    'The docs navigation today, with every sidebar group expanded and every feature flag enabled, as in production.',
  source: `supabase/supabase@${commit} ${CONSTANTS}`,
  root: { label: 'Supabase Docs', children: topLevel },
};

writeFileSync(outPath, `${JSON.stringify(tree, null, 2)}\n`);

const stats = treeStats(tree);
console.log(`Wrote ${outPath}`);
console.log(
  JSON.stringify(
    {
      ...stats,
      duplicatePages: stats.duplicatePages.length,
      duplicateRoutes: stats.duplicateRoutes.length,
      unlinkedGroupRoutes: unlinkedGroupRoutes.map((url) => routePage(url)),
    },
    null,
    2
  )
);
