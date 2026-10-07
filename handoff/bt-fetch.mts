// Fetches tree test runs from Braintrust, rescores them with the repo scorer,
// and writes one JSON file per experiment.
// Usage: node --import tsx/esm bt-fetch.mts <experiment name prefix> [out dir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scoreTreeTest } from '../evals/docs-tree-tests/lib/tree-test.ts';

const PROJECT = '448cc19e-afdf-4e96-b92a-6e02522603a0';
const [prefix, outDir = 'handoff/results'] =
  process.argv.slice(2);

const curl = (args: string[]) =>
  JSON.parse(execFileSync('curl', ['-sS', '--max-time', '120', ...args], { encoding: 'utf8', maxBuffer: 1 << 30 }));

function experiments(): { id: string; name: string; created: string }[] {
  const found = [];
  let after = '';
  for (;;) {
    const page = curl([`https://api.braintrust.dev/v1/experiment?project_id=${PROJECT}&limit=100${after ? `&starting_after=${after}` : ''}`]);
    const objects = page.objects ?? [];
    if (objects.length === 0) break;
    found.push(...objects.filter((e: { name: string }) => e.name.startsWith(prefix) && (!process.env.MATCH || e.name.includes(process.env.MATCH))));
    after = objects.at(-1).id;
  }
  return found;
}

function btql(query: string) {
  const rows = [];
  let cursor: string | undefined;
  for (;;) {
    const page = curl([
      '-X', 'POST', 'https://api.braintrust.dev/btql',
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ query: `${query} | limit: 1000`, ...(cursor ? { cursor } : {}) }),
    ]);
    if (page.Code === 'TooManyRequestsError') {
      execFileSync('sleep', ['45']);
      continue;
    }
    if (!page.data) throw new Error(JSON.stringify(page).slice(0, 500));
    rows.push(...page.data);
    if (page.data.length < 1000 || !page.cursor) break;
    cursor = page.cursor;
  }
  return rows;
}

const evalModules = new Map<string, { TARGETS: string[]; ALTERNATES: string[] }>();
async function evalModule(evalId: string) {
  if (!evalModules.has(evalId)) {
    evalModules.set(
      evalId,
      await import(pathToFileURL(`../evals/docs-tree-tests/${evalId}/EVAL.ts`).href)
    );
  }
  return evalModules.get(evalId)!;
}

mkdirSync(outDir, { recursive: true });
for (const experiment of experiments()) {
  const from = `from: experiment('${experiment.id}')`;
  const roots = btql(`${from} | filter: span_attributes.type = 'eval' | select: root_span_id, metadata, scores`);
  const tools = btql(`${from} | filter: span_attributes.type = 'tool' | select: root_span_id, input, output, metrics, span_attributes, metadata`);
  const byRoot = new Map<string, typeof tools>();
  for (const tool of tools) byRoot.set(tool.root_span_id, [...(byRoot.get(tool.root_span_id) ?? []), tool]);
  const runs = [];
  for (const root of roots) {
    const evalId = root.metadata?.eval;
    if (!evalId?.includes('-tree-')) continue;
    const calls = (byRoot.get(root.root_span_id) ?? [])
      .sort((a, b) => a.metrics.start - b.metrics.start)
      .map((tool) => {
        const raw = String(tool.metadata?.tool_name ?? tool.span_attributes?.name ?? '');
        const toolName = raw.split(':')[0].split('__').at(-1)?.trim() ?? raw;
        return {
          tool: { kind: 'mcp' as const, server: 'tree-navigator', toolName },
          body: (tool.input ?? {}) as Record<string, unknown>,
          result: tool.output,
          ts: tool.metrics.start,
        };
      });
    const { TARGETS, ALTERNATES } = await evalModule(evalId);
    runs.push({
      evalId,
      run: root.metadata?.run,
      passed: root.scores?.passed,
      targets: TARGETS,
      result: scoreTreeTest(calls, TARGETS, ALTERNATES),
    });
  }
  const file = join(outDir, `${experiment.name.replace(/[@:]/g, '_')}.json`);
  writeFileSync(file, JSON.stringify({ experiment: experiment.name, created: experiment.created, runs }, null, 1));
  console.log(`${experiment.name}: ${runs.length} runs -> ${file}`);
}
