import { readFileSync } from 'node:fs';
import { indexTree, loadTree, treeStats } from '../experiments/docs/lib/docs-tree.ts';
const tasks = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const rows = [];
for (const name of process.argv.slice(3)) {
  const tree = loadTree(name);
  const s = treeStats(tree);
  const nodes = indexTree(tree);
  const depthOf = (page: string) => Math.min(...nodes.filter((n) => n.page === page).map((n) => n.depth));
  const minClicks = tasks.map((t: any) => Math.min(...[...t.targets, ...t.alternates].map((p: string) => depthOf(p) - 1)));
  const pageDepths = [...new Set(nodes.filter((n) => n.page).map((n) => n.page))].map((p) => depthOf(p!));
  const mean = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
  rows.push({ tree: name, links: s.links, pages: s.pages, dupPages: s.duplicatePages.length, wide: s.wideNodes.length, maxChildren: s.maxChildren, maxDepth: s.maxDepth, top: tree.root.children?.length, meanPageDepth: mean(pageDepths), meanMinClicksToTarget: mean(minClicks), tasksOver3MinClicks: minClicks.filter((c: number) => c > 3).length });
}
console.table(rows);
