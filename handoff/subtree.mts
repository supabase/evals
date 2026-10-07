import { indexTree, loadTree } from '../experiments/docs/lib/docs-tree.ts';
const [name, prefix, maxDepth] = [process.argv[2], process.argv[3], Number(process.argv[4] ?? 9)];
for (const n of indexTree(loadTree(name))) {
  if (n.id === 'root' || !n.trail.join(' > ').startsWith(prefix) || n.depth > maxDepth) continue;
  console.log(`${'  '.repeat(n.depth - 1)}${n.label}${n.children ? ` [${n.children.length}]` : ''}${n.page && n.children ? ` = ${n.page}` : ''}`);
}
