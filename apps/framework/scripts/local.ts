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
import { parseArgs, type ParseArgsConfig } from 'node:util';
import {
  getExperimentDisplayMetadata,
  type ExperimentConfig,
} from '@supabase-evals/core';
import { parseEvalMarkdown } from '@supabase-evals/core/eval-markdown';
import {
  rawEvalResultSchema,
  type RawEvalResult,
} from '@supabase-evals/core/eval-metadata';
import { main as docsMain } from './local-docs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
const OUT_DIR = join(ROOT, 'results-local');
const PUBLISHED_FILES = [
  'apps/web/src/data/regression-eval-results.json',
  'apps/web/src/data/eval-results.json',
];
const DEFAULT_EXPERIMENT = 'claude-code-sonnet-5';

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
      dirtyFiles: inRepo ? dirty(inRepo) : undefined,
    };
  }
  if (contentApi) p.contentApiUrl = contentApi;
  return p;
}

// ---------- published baselines (compare mode) ----------

type PublishedFile = {
  file: string;
  rows: RawEvalResult[];
  commit: string;
  parent: string;
  committedAt: string;
};

type Baseline = {
  row: RawEvalResult;
  file: string;
  commit: string;
  parent: string;
  committedAt: string;
};

/** Load one published export file from origin/main with its commit metadata. */
function loadPublishedFile(file: string): PublishedFile | undefined {
  let rows: RawEvalResult[];
  try {
    rows = JSON.parse(git(['show', `origin/main:${file}`]));
  } catch {
    return undefined;
  }
  const [commit, parent, committedAt] = git([
    'log',
    'origin/main',
    '-1',
    '--format=%H %P %cI',
    '--',
    file,
  ]).split(' ');
  return { file, rows, commit, parent, committedAt };
}

/**
 * Freshest published row per requested eval for the experiment. Refuses
 * (pre-spend) when any requested eval has no published row, listing the
 * experiments that ARE published for it.
 */
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
  const files = PUBLISHED_FILES.flatMap((f) => loadPublishedFile(f) ?? []);
  const best = new Map<string, Baseline>();
  const failures: string[] = [];
  for (const id of evalIds) {
    const candidates: Baseline[] = files.flatMap(
      ({ file, rows, commit, parent, committedAt }) =>
        rows
          .filter((row) => row.eval === id)
          .map((row) => ({ row, file, commit, parent, committedAt }))
    );
    const match = candidates
      .filter((c) => c.row.experiment === experiment)
      .sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt))[0];
    if (match) {
      best.set(id, match);
      continue;
    }
    const alts = [...new Set(candidates.map((c) => c.row.experiment))];
    failures.push(
      alts.length
        ? `no published ${experiment} result for ${id} on origin/main (published experiments: ${alts.join(', ')})`
        : `no published result for ${id} on origin/main at all — use \`pnpm local run\` (no baseline needed)`
    );
  }
  if (failures.length) {
    for (const msg of failures) console.error(msg);
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

/**
 * Evals whose scorer uses the LLM judge grade the agent's output with an
 * OpenAI model — even when the agent under test is Claude. A missing grader
 * key otherwise surfaces only AFTER the (paid) agent run, wasting it.
 * Textual scan of EVAL.ts; a false positive just asks for a key early.
 */
function validateJudgeKeys(evalIds: string[]) {
  if (process.env.OPENAI_API_KEY) return;
  const judged = evalIds.filter((id) => {
    const scorer = join(ROOT, 'evals', id, 'EVAL.ts');
    return existsSync(scorer) && /\bjudge\b/.test(readFileSync(scorer, 'utf8'));
  });
  if (judged.length)
    fail(
      `these evals score with the LLM judge (OpenAI-backed, regardless of the agent under test): ${judged.join(', ')}\nadd OPENAI_API_KEY to .env at the repo root before running them`
    );
}

/**
 * Accept either the mcp monorepo root or the server package dir for --mcp,
 * and refuse pre-spend when the server isn't built (the harness would only
 * discover that after eval setup).
 */
function resolveMcpServerPath(raw: string): string {
  let p = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  if (!existsSync(p)) fail(`--mcp path does not exist: ${p}`);
  const packageDir = join(p, 'packages', 'mcp-server-supabase');
  if (existsSync(packageDir)) p = packageDir;
  if (!existsSync(join(p, 'dist', 'transports', 'stdio.js')))
    fail(
      `no built server at ${p} (dist/transports/stdio.js missing) — build it first:\n  pnpm install && pnpm build   # in the mcp checkout (use \`mise exec --\` if corepack's pnpm mismatches)`
    );
  return p;
}

/**
 * The experiment's declared skills must exist in this checkout, or the
 * treatment silently runs skill-less against a skills-enabled published
 * baseline — a world mismatch, not a comparison.
 */
async function validateSkills(experiment: string) {
  // runtime-discovered plugin dir (same pattern as run-eval's loadExperiments)
  const mod = await import(
    pathToFileURL(join(ROOT, 'experiments', `${experiment}.ts`)).href
  );
  const skills: string[] = (mod.default as ExperimentConfig).skills ?? [];
  const missing = skills.filter((s) => !existsSync(join(ROOT, 'skills', s)));
  if (missing.length)
    fail(
      `experiment ${experiment} declares skills this checkout is missing: ${missing.join(', ')}\ninitialise the skills submodule first: git submodule update --init`
    );
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

// ---------- reporting ----------

function reportRow(
  label: string,
  r: RawEvalResult | undefined,
  extra: string
): string {
  const checks = r?.checks ?? [];
  const checksSummary = `${checks.filter((x) => x.passed).length}/${checks.length}`;
  const docsCalls = r?.docs?.calls?.length ?? 0;
  return `${label.padEnd(10)} passed=${String(r?.passed).padEnd(5)} checks=${checksSummary.padEnd(6)} docs.calls=${String(docsCalls).padEnd(3)} ${extra}`;
}

/** Print the published-vs-treatment delta; true when treatment regressed. */
function reportComparison(
  id: string,
  b: Baseline,
  result: RawEvalResult
): boolean {
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
  console.log(
    'screen only: the published arm ran in the scheduled CI world — a flip is a signal, not causal proof'
  );
  console.log(`saved: results-local/${id}.{published,treatment}.json`);
  return d < 0;
}

/** Run one eval in the treatment world, write its receipt, report; true when it regressed vs published. */
function runTreatment(
  id: string,
  experiment: string,
  runs: number,
  opts: {
    env: Record<string, string>;
    mcpPath?: string;
    contentApi?: string;
    baseline?: Baseline;
  }
): boolean {
  const { env, mcpPath, contentApi, baseline } = opts;
  console.log(
    `== treatment: ${id} (${experiment}, runs=${runs}${mcpPath ? ', mcp override' : ''}${contentApi ? ', content-api override' : ''}) ==`
  );
  const resultPath = process.env.LOCAL_EVAL_CMD
    ? fakeRun(id, experiment)
    : runEval(id, experiment, runs, env);

  const parsed = rawEvalResultSchema.safeParse(
    JSON.parse(readFileSync(resultPath, 'utf8'))
  );
  if (!parsed.success)
    fail(
      `result at ${resultPath} does not match the eval result contract:\n${parsed.error.message}`
    );
  const result = parsed.data;
  const receipt = {
    ...result,
    provenance: collectProvenance(mcpPath, contentApi),
  };
  writeFileSync(
    join(OUT_DIR, `${id}.treatment.json`),
    `${JSON.stringify(receipt, null, 1)}\n`
  );

  console.log(
    `\n=== local ${baseline ? 'compare' : 'run'}: ${id} (${experiment}) ===`
  );
  if (baseline) return reportComparison(id, baseline, result);
  console.log(reportRow('treatment', result, 'your world'));
  console.log(`saved: results-local/${id}.treatment.json`);
  return false;
}

// ---------- subcommands ----------

async function cmdExperiments() {
  const published = new Set(
    PUBLISHED_FILES.flatMap(
      (f) => loadPublishedFile(f)?.rows.map((r) => r.experiment) ?? []
    )
  );
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

const RUN_USAGE =
  'usage: pnpm local <run|compare> <eval-id> [...] [--experiment <id>] [--runs N] [--mcp <path>] [--content-api <url>]';

async function cmdRunOrCompare(mode: 'run' | 'compare', argv: string[]) {
  const parsed = (() => {
    try {
      return parseArgs({
        args: argv,
        options: {
          experiment: { type: 'string' },
          runs: { type: 'string' },
          mcp: { type: 'string' },
          'content-api': { type: 'string' },
        },
        allowPositionals: true,
      });
    } catch (err) {
      fail(`${err instanceof Error ? err.message : String(err)}\n${RUN_USAGE}`);
    }
  })();
  const { values, positionals: evalIds } = parsed;
  if (!evalIds.length) fail(RUN_USAGE);
  const experiment = values.experiment ?? DEFAULT_EXPERIMENT;
  validateExperiment(experiment);

  const baselines =
    mode === 'compare'
      ? resolveBaselines(evalIds, experiment, !process.env.LOCAL_NO_FETCH)
      : new Map<string, Baseline>();

  validateEvals(evalIds);
  // these gates are spend-relevant only for real runs; the test hook fakes them
  if (!process.env.LOCAL_EVAL_CMD) {
    await validateSkills(experiment);
    validateJudgeKeys(evalIds);
  }

  const env: Record<string, string> = {};
  const mcpPath = values.mcp ? resolveMcpServerPath(values.mcp) : undefined;
  if (mcpPath) env.SUPABASE_MCP_SERVER_PATH = mcpPath;
  const contentApi = values['content-api'];
  if (contentApi) env.SUPABASE_CONTENT_API_URL = contentApi;

  mkdirSync(OUT_DIR, { recursive: true });
  let exitCode = 0;
  for (const id of evalIds) {
    const runs = Number(values.runs ?? baselines.get(id)?.row.attempts ?? 1);
    const regressed = runTreatment(id, experiment, runs, {
      env,
      mcpPath,
      contentApi,
      baseline: baselines.get(id),
    });
    if (regressed) exitCode = 1;
  }
  process.exit(exitCode);
}

// ---------- entry ----------

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'run':
  case 'compare':
    await cmdRunOrCompare(command, rest);
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
