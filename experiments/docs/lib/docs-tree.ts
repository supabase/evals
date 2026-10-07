/**
 * A docs navigation tree for tree tests: the labels someone sees in the docs
 * navigation, and the page each one links. Tree files live in
 * `experiments/docs/trees/`.
 */
import { readFileSync } from 'node:fs';

export type TreeNode = {
  label: string;
  /** The page this item links today, like `/guides/platform/sso`. Groups and headings have none. */
  route?: string;
  /** A proposal's new url for the page. Old routes redirect here. */
  newRoute?: string;
  /** The page doesn't exist yet. */
  new?: boolean;
  /**
   * A new page split out of a section of `route`'s page, which `route` links
   * with an anchor. Choosing it counts as choosing that page, and it doesn't
   * count as a second link to it.
   */
  split?: boolean;
  children?: TreeNode[];
};

export type DocsTree = {
  name: string;
  description: string;
  source?: string;
  root: TreeNode;
};

/** Tree rules for proposals. */
export const MAX_CHILDREN = 7;

const TREES_DIR = new URL('../trees/', import.meta.url);

export function loadTree(name: string): DocsTree {
  return JSON.parse(readFileSync(new URL(`${name}.json`, TREES_DIR), 'utf8'));
}

/**
 * The page a route links, as a docs path like `guides/platform/sso`, without
 * query or anchor. The docs root is `docs`, and other sites keep their url.
 */
export function routePage(route: string): string {
  if (/^https?:\/\//.test(route)) {
    const url = new URL(route);
    if (url.hostname !== 'supabase.com') return `${url.origin}${url.pathname}`;
    route = url.pathname;
  }
  const path = route
    .replace(/[?#].*$/, '')
    .replace(/\.md$/, '')
    .replace(/^\/+|\/+$/g, '');
  if (path === '' || path === 'docs') return 'docs';
  return path.replace(/^docs\//, '');
}

export type IndexedNode = TreeNode & {
  /** Dotted child positions from the root, like `3.1.4`. The root is `root`. */
  id: string;
  depth: number;
  /** Labels from the first level down to this node. */
  trail: string[];
  page?: string;
};

/** Every node with its id, depth, and trail, depth first. */
export function indexTree(tree: DocsTree): IndexedNode[] {
  const nodes: IndexedNode[] = [];
  const visit = (
    node: TreeNode,
    id: string,
    depth: number,
    trail: string[]
  ) => {
    nodes.push({
      ...node,
      id,
      depth,
      trail,
      page: node.route ? routePage(node.route) : undefined,
    });
    node.children?.forEach((child, index) => {
      const childId = id === 'root' ? `${index + 1}` : `${id}.${index + 1}`;
      visit(child, childId, depth + 1, [...trail, child.label]);
    });
  };
  visit(tree.root, 'root', 0, []);
  return nodes;
}

/** True when `id` is `ancestor` or one of its descendants. */
export function isWithin(id: string, ancestor: string): boolean {
  return (
    ancestor === 'root' || id === ancestor || id.startsWith(`${ancestor}.`)
  );
}

export type TreeStats = {
  nodes: number;
  /** Nodes that link a page. */
  links: number;
  pages: number;
  maxDepth: number;
  /** Linked nodes by depth: the root is 0, the top nav 1. */
  linkDepths: Record<number, number>;
  maxChildren: number;
  /** Nodes with more children than MAX_CHILDREN. */
  wideNodes: { trail: string; children: number }[];
  /** Pages linked from more than one node, ignoring query and anchor. */
  duplicatePages: { page: string; trails: string[] }[];
  /** Exact routes linked from more than one node. */
  duplicateRoutes: { route: string; trails: string[] }[];
};

export function treeStats(tree: DocsTree): TreeStats {
  const nodes = indexTree(tree);
  const byPage = new Map<string, string[]>();
  const byRoute = new Map<string, string[]>();
  const linkDepths: Record<number, number> = {};
  for (const node of nodes) {
    if (!node.route || !node.page) continue;
    const trail = node.trail.join(' > ') || tree.root.label;
    linkDepths[node.depth] = (linkDepths[node.depth] ?? 0) + 1;
    if (node.split) continue;
    byPage.set(node.page, [...(byPage.get(node.page) ?? []), trail]);
    byRoute.set(node.route, [...(byRoute.get(node.route) ?? []), trail]);
  }
  const wideNodes = nodes
    .filter((node) => (node.children?.length ?? 0) > MAX_CHILDREN)
    .map((node) => ({
      trail: node.trail.join(' > ') || tree.root.label,
      children: node.children?.length ?? 0,
    }));
  return {
    nodes: nodes.length,
    links: nodes.filter((node) => node.route).length,
    pages: byPage.size,
    maxDepth: Math.max(...nodes.map((node) => node.depth)),
    linkDepths,
    maxChildren: Math.max(...nodes.map((node) => node.children?.length ?? 0)),
    wideNodes,
    duplicatePages: [...byPage]
      .filter(([, trails]) => trails.length > 1)
      .map(([page, trails]) => ({ page, trails })),
    duplicateRoutes: [...byRoute]
      .filter(([, trails]) => trails.length > 1)
      .map(([route, trails]) => ({ route, trails })),
  };
}

/** Rule violations for a proposed tree: wide nodes and duplicate pages. */
export function ruleViolations(tree: DocsTree): string[] {
  const stats = treeStats(tree);
  return [
    ...stats.wideNodes.map(
      (node) => `${node.trail} has ${node.children} children`
    ),
    ...stats.duplicatePages.map(
      (dup) => `${dup.page} is linked ${dup.trails.length} times`
    ),
  ];
}
