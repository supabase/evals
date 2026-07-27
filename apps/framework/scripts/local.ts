#!/usr/bin/env tsx
/**
 * local.ts — local-dev runner. Run evals against YOUR inputs (edited skills
 * tree, a local MCP build, a custom docs content API) with provenance
 * receipts, and optionally compare against the latest published results on
 * `origin/main`.
 *
 *   pnpm local run <eval...>     [--experiment <id>] [--runs N] [--mcp <path>] [--content-api <url>]
 *   pnpm local compare <eval...> [same flags]
 *   pnpm local experiments
 *   pnpm local docs <up|seed|api|down> [--docs <path>]   (see local-docs.ts)
 *
 * Design notes:
 * - Treatment-only: nothing here ever mutates a git tree, so concurrent
 *   sessions/worktrees cannot interfere and in-flight work is never at risk.
 * - `compare` is a SCREEN, not causal proof: the published arm ran in the
 *   scheduled CI world (published MCP package, prod docs index, model state
 *   at refresh time). The receipt records the published result commit, its
 *   parent, and its age so the gap is explicit.
 * - Explicit over magic: this does not build your MCP checkout or re-embed
 *   docs for you; it reports what world it measured. Build with
 *   `pnpm build` in your mcp checkout; serve docs with `pnpm local docs`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEvalMarkdown } from '@supabase-evals/core/eval-markdown';
import {
  getExperimentDisplayMetadata,
  type ExperimentConfig,
} from '@supabase-evals/core';
import { main as docsMain } from './local-docs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
const OUT_DIR = join(ROOT, 'results-local');
const PUBLISHED_FILES = [
  'apps/web/src/data/regression-eval-results.json',
  'apps/web/src/data/eval-results.json',
];
const DEFAULT_EXPERIMENT = 'claude-code-sonnet-5';

// ---------- tiny arg helpers (single-value flags; positionals collected) ----------

function parseArgs(argv: string[]) {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(a.slice(2), next);
      i++;
    } else {
      bools.add(a.slice(2));
    }
  }
  return { flags, bools, positionals };
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ---------- git helpers (plain child_process; cross-platform) ----------

function git(args: string[], cwd: string = ROOT): string {
  return execFileSync('git', args, { cwd, maxBuffer: 1 << 28 })
    .toString()
    .trim();
}

function tryGit(args: string[], cwd: string = ROOT): string | undefined {
  try {
    return git(args, cwd);
  } catch {
    return undefined;
  }
}

// ---------- provenance receipts ----------

type Provenance = {
  generatedAt: string;
  host: { sha?: string; branch?: string; dirtyFiles: number };
  mcpOverride?: { path: string; sha?: string; dirtyFiles?: number };
  contentApiUrl?: string;
  platform: string;
};

function collectProvenance(mcpPath?: string, contentApi?: string): Provenance {
  const dirty = (cwd: string) =>
    (tryGit(['status', '--porcelain'], cwd) ?? '').split('\n').filter(Boolean)
      .length;
  const p: Provenance = {
    generatedAt: new Date().toISOString(),
    host: {
      sha: tryGit(['rev-parse', 'HEAD']),
      branch: tryGit(['rev-parse', '--abbrev-ref', 'HEAD']),
      dirtyFiles: dirty(ROOT),
    },
    platform: `${process.platform}/${process.arch} node ${process.version}`,
  };
  if (mcpPath) {
    const inRepo = tryGit(['rev-parse', '--show-toplevel'], mcpPath);
    p.mcpOverride = {
      path: mcpPath,
      sha: inRepo ? tryGit(['rev-parse', 'HEAD'], mcpPath) : undefined,
      dirtyFiles: inRepo
        ? (tryGit(['status', '--porcelain'], inRepo) ?? '')
            .split('\n')
            .filter(Boolean).length
        : undefined,
    };
  }
  if (contentApi) p.contentApiUrl = contentApi;
  return p;
}

// ---------- published baselines (compare mode) ----------

type PublishedRow = {
  experiment: string;
  eval: string;
  passed?: boolean;
  attempts?: number;
  checks?: Array<{ name: string; passed: boolean }>;
  docs?: { calls?: unknown[] };
  [k: string]: unknown;
};

type Baseline = {
  row: PublishedRow;
  file: string;
  commit: string;
  parent: string;
  committedAt: string;
};

function resolveBaselines(
  evalIds: string[],
  experiment: string,
  fetch: boolean
): Map<string, Baseline> {
  if (fetch) {
    try {
      git(['fetch', '-q', 'origin', 'main']);
    } catch {
      console.error(
        'warning: could not fetch origin/main — comparing against the local ref, which may be stale'
      );
    }
  }
  const best = new Map<string, Baseline>();
  const seen = new Map<string, Set<string>>();
  for (const file of PUBLISHED_FILES) {
    let rows: PublishedRow[];
    try {
      rows = JSON.parse(git(['show', `origin/main:${file}`]));
    } catch {
      continue;
    }
    const [commit, parent, committedAt] = git([
      'log',
      'origin/main',
      '-1',
      '--format=%H %P %cI',
      '--',
      file,
    ]).split(' ');
    for (const row of rows) {
      if (!evalIds.includes(row.eval)) continue;
      if (!seen.has(row.eval)) seen.set(row.eval, new Set());
      seen.get(row.eval)?.add(row.experiment);
      if (row.experiment !== experiment) continue;
      const cur = best.get(row.eval);
      if (!cur || new Date(committedAt) > new Date(cur.committedAt))
        best.set(row.eval, { row, file, commit, parent, committedAt });
    }
  }
  const missing = evalIds.filter((e) => !best.has(e));
  if (missing.length) {
    for (const e of missing) {
      const alts = [...(seen.get(e) ?? [])];
      console.error(
        alts.length
          ? `no published ${experiment} result for ${e} on origin/main (published experiments: ${alts.join(', ')})`
          : `no published result for ${e} on origin/main at all — use \`pnpm local run\` (no baseline needed)`
      );
    }
    process.exit(1);
  }
  return best;
}

// ---------- eval validation (fail before spending) ----------

function validateEvals(evalIds: string[]) {
  for (const id of evalIds) {
    const promptPath = join(ROOT, 'evals', id, 'PROMPT.md');
    if (!existsSync(promptPath))
      fail(`no eval at evals/${id} (PROMPT.md missing)`);
    try {
      parseEvalMarkdown(
        readFileSync(promptPath, 'utf8'),
        `evals/${id}/PROMPT.md`
      );
    } catch (err) {
      fail(
        `eval metadata invalid — fix evals/${id}/PROMPT.md before spending on runs\n${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

function validateExperiment(experiment: string) {
  if (!existsSync(join(ROOT, 'experiments', `${experiment}.ts`))) {
    const available = readdirSync(join(ROOT, 'experiments'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.replace(/\.ts$/, ''));
    fail(
      `unknown experiment: ${experiment}\navailable: ${available.join(', ')}\n(or add experiments/${experiment}.ts — see any existing file for the shape)`
    );
  }
}

// ---------- treatment run ----------

function runEval(
  evalId: string,
  experiment: string,
  runs: number,
  env: Record<string, string>
): string {
  const res = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx/esm',
      join(__dirname, '..', 'harness', 'run-eval.ts'),
      '--eval',
      evalId,
      '--experiment',
      experiment,
      '--runs',
      String(runs),
    ],
    {
      stdio: 'inherit',
      cwd: join(__dirname, '..'),
      env: { ...process.env, ...env },
    }
  );
  if (res.status !== 0) fail(`eval run failed: ${evalId} (exit ${res.status})`);
  const resultPath = join(ROOT, 'results', experiment, `${evalId}.json`);
  if (!existsSync(resultPath))
    fail(
      `no result at results/${experiment}/${evalId}.json — check the eval/experiment ids`
    );
  return resultPath;
}

// ---------- reporting ----------

function reportRow(
  label: string,
  r: PublishedRow | undefined,
  extra: string
): string {
  const checks = r?.checks ?? [];
  const checksSummary = `${checks.filter((x) => x.passed).length}/${checks.length}`;
  const docsCalls = r?.docs?.calls?.length ?? 0;
  return `${label.padEnd(10)} passed=${String(r?.passed).padEnd(5)} checks=${checksSummary.padEnd(6)} docs.calls=${String(docsCalls).padEnd(3)} ${extra}`;
}

// ---------- subcommands ----------

async function cmdExperiments() {
  const published = new Set<string>();
  for (const file of PUBLISHED_FILES) {
    try {
      for (const row of JSON.parse(
        git(['show', `origin/main:${file}`])
      ) as PublishedRow[])
        published.add(row.experiment);
    } catch {
      /* offline or file missing: published column degrades to '-' */
    }
  }
  console.log(
    `${'EXPERIMENT'.padEnd(36)} ${'AGENT'.padEnd(12)} ${'MODEL'.padEnd(22)} ${'EFFORT'.padEnd(8)} PUBLISHED`
  );
  for (const f of readdirSync(join(ROOT, 'experiments'))
    .filter((f) => f.endsWith('.ts'))
    .sort()) {
    const name = f.replace(/\.ts$/, '');
    // runtime-discovered plugin dir (same pattern as run-eval's loadExperiments)
    const mod = await import(pathToFileURL(join(ROOT, 'experiments', f)).href);
    const display = getExperimentDisplayMetadata(
      mod.default as ExperimentConfig
    );
    console.log(
      `${name.padEnd(36)} ${(display.agent ?? '?').padEnd(12)} ${(display.modelId ?? '?').padEnd(22)} ${(display.reasoningEffort ?? '-').padEnd(8)} ${published.has(name) ? 'yes (compare)' : '-'}`
    );
  }
}

function cmdRunOrCompare(mode: 'run' | 'compare', argv: string[]) {
  const { flags, positionals } = parseArgs(argv);
  const evalIds = positionals;
  if (!evalIds.length)
    fail(
      `usage: pnpm local ${mode} <eval-id> [...] [--experiment <id>] [--runs N] [--mcp <path>] [--content-api <url>]`
    );
  const experiment = flags.get('experiment') ?? DEFAULT_EXPERIMENT;
  validateExperiment(experiment);

  const baselines =
    mode === 'compare'
      ? resolveBaselines(evalIds, experiment, !process.env.LOCAL_NO_FETCH)
      : new Map<string, Baseline>();

  validateEvals(evalIds);

  const env: Record<string, string> = {};
  let mcpPath = flags.get('mcp');
  if (mcpPath) {
    mcpPath = isAbsolute(mcpPath) ? mcpPath : resolve(process.cwd(), mcpPath);
    if (!existsSync(mcpPath)) fail(`--mcp path does not exist: ${mcpPath}`);
    env.SUPABASE_MCP_SERVER_PATH = mcpPath;
  }
  const contentApi = flags.get('content-api');
  if (contentApi) env.SUPABASE_CONTENT_API_URL = contentApi;

  mkdirSync(OUT_DIR, { recursive: true });
  let exitCode = 0;
  for (const id of evalIds) {
    const runs = Number(
      flags.get('runs') ?? baselines.get(id)?.row.attempts ?? 1
    );
    console.log(
      `== treatment: ${id} (${experiment}, runs=${runs}${mcpPath ? ', mcp override' : ''}${contentApi ? ', content-api override' : ''}) ==`
    );
    const resultPath = process.env.LOCAL_EVAL_CMD
      ? fakeRun(id, experiment)
      : runEval(id, experiment, runs, env);

    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as PublishedRow;
    const receipt = {
      ...result,
      provenance: collectProvenance(mcpPath, contentApi),
    };
    const treatmentPath = join(OUT_DIR, `${id}.treatment.json`);
    writeFileSync(treatmentPath, `${JSON.stringify(receipt, null, 1)}\n`);

    console.log(`\n=== local ${mode}: ${id} (${experiment}) ===`);
    const b = baselines.get(id);
    if (b) {
      writeFileSync(
        join(OUT_DIR, `${id}.published.json`),
        `${JSON.stringify({ ...b.row, publishedProvenance: { file: b.file, commit: b.commit, parent: b.parent, committedAt: b.committedAt } }, null, 1)}\n`
      );
      const ageDays = Math.round(
        (Date.now() - new Date(b.committedAt).getTime()) / 86_400_000
      );
      console.log(
        reportRow(
          'published',
          b.row,
          `main@${b.commit.slice(0, 7)} ${b.committedAt.slice(0, 10)} (${ageDays}d old, attempts ${b.row.attempts})`
        )
      );
      console.log(reportRow('treatment', result, 'your world'));
      const d = (result.passed ? 1 : 0) - (b.row.passed ? 1 : 0);
      console.log(
        d > 0
          ? '-> IMPROVED vs published (FAIL->PASS)'
          : d < 0
            ? '-> REGRESSED vs published (PASS->FAIL)'
            : '-> no pass/fail change (compare checks / docs.calls)'
      );
      if (d < 0) exitCode = 1;
      console.log(
        'screen only: the published arm ran in the scheduled CI world — a flip is a signal, not causal proof'
      );
      console.log(`saved: results-local/${id}.{published,treatment}.json`);
    } else {
      console.log(reportRow('treatment', result, 'your world'));
      console.log(`saved: results-local/${id}.treatment.json`);
    }
  }
  process.exit(exitCode);
}

// test hook: LOCAL_EVAL_CMD writes the result file itself (no model spend)
function fakeRun(evalId: string, experiment: string): string {
  const resultPath = join(ROOT, 'results', experiment, `${evalId}.json`);
  mkdirSync(dirname(resultPath), { recursive: true });
  const res = spawnSync(process.env.LOCAL_EVAL_CMD as string, {
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, RES: resultPath, EVAL: evalId },
  });
  if (res.status !== 0) fail(`LOCAL_EVAL_CMD failed for ${evalId}`);
  return resultPath;
}

// ---------- entry ----------

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'run':
  case 'compare':
    cmdRunOrCompare(command, rest);
    break;
  case 'experiments':
    await cmdExperiments();
    break;
  case 'docs':
    await docsMain(rest);
    break;
  default:
    fail(`usage: pnpm local <run|compare|experiments|docs> ...
  run <eval...>       run eval(s) in your world (skills tree as-is; --mcp / --content-api overrides)
  compare <eval...>   run + diff against the latest published result on origin/main
  experiments         list experiments (agent, model, effort, published-baseline availability)
  docs <up|seed|api|down> --docs <path-to-supabase-monorepo>   local docs content API`);
}
