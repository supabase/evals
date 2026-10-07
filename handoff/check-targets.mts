import { readFileSync } from 'node:fs';
import { indexTree, loadTree } from '../experiments/docs/lib/docs-tree.ts';
const nodes = indexTree(loadTree(process.argv[3] ?? 'today'));
const pages = new Map<string, string[]>();
for (const n of nodes) if (n.page) pages.set(n.page, [...(pages.get(n.page) ?? []), n.trail.join(' > ')]);
const tasks = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const t of tasks) {
  const id = t.id ?? t.source;
  for (const p of [...t.targets, ...(t.alternates ?? [])]) {
    const where = pages.get(p);
    if (!where) console.log(`MISSING ${id}: ${p}${t.targets.includes(p) ? ' (target)' : ' (alternate)'}`);
  }
  if (!t.targets.some((p: string) => pages.has(p))) console.log(`UNWINNABLE ${id}`);
}
