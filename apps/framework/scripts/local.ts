#!/usr/bin/env tsx
/**
 * local.ts — local-dev runner. Run evals against YOUR inputs (an edited skills
 * tree, a local MCP build) with provenance receipts.
 *
 *   pnpm local run <eval...> [--experiment <id>] [--runs N] [--mcp <path>]
 *   pnpm local experiments
 *
 * Design notes:
 * - Treatment-only: nothing here ever mutates a git tree, so concurrent
 *   sessions/worktrees cannot interfere and in-flight work is never at risk.
 * - Explicit over magic: this does not build your MCP checkout for you; it
 *   reports what world it measured. Build it with `pnpm build` in your mcp
 *   checkout and pass `--mcp`.
 * - Gates run before any model call, because the harness SKIPs an experiment
 *   with exit 0 on missing credentials and a wasted agent run costs real money.
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
  MCP_SERVER_VERSION,
  type ExperimentConfig,
} from '@supabase-evals/core';
import { parseEvalMarkdown } from '@supabase-evals/core/eval-markdown';
import {
  rawEvalResultSchema,
  type RawEvalResult,
} from '@supabase-evals/core/eval-metadata';
import { parsePublishedLog, PUBLISHED_LOG_FORMAT } from './published-log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
// test seam: the smoke suite redirects ALL outputs into a temp sandbox so it
// can never clobber a real (possibly in-flight) run's results/receipts
const RESULTS_ROOT = process.env.LOCAL_RESULTS_ROOT ?? ROOT;
const OUT_DIR = join(RESULTS_ROOT, 'results-local');
// suite name -> published export file; the values double as the full load list
const PUBLISHED_EXPORTS: Record<string, string> = {
  regression: 'apps/web/src/data/regression-eval-results.json',
  benchmark: 'apps/web/src/data/eval-results.json',
};
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
  platform: string;
};

function collectProvenance(mcpPath?: string): Provenance {
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

/** Load one published export file from origin/main with its commit metadata. */
function loadPublishedFile(file: string): PublishedFile | undefined {
  let rows: RawEvalResult[];
  try {
    rows = JSON.parse(git(['show', `origin/main:${file}`]));
  } catch {
    return undefined;
  }
  const line = git([
    'log',
    'origin/main',
    '-1',
    PUBLISHED_LOG_FORMAT,
    '--',
    file,
  ]);
  return { file, rows, ...parsePublishedLog(line) };
}

/** Fetch origin/main so the published exports are current; warn-and-continue offline. */
function fetchMain() {
  if (process.env.LOCAL_NO_FETCH) return;
  try {
    git(['fetch', '-q', 'origin', 'main']);
  } catch {
    console.error(
      'warning: could not fetch origin/main — comparing against the local ref, which may be stale'
    );
  }
}

/** Load every published export once; callers share the result. */
function loadPublished(): PublishedFile[] {
  return Object.values(PUBLISHED_EXPORTS).flatMap(
    (f) => loadPublishedFile(f) ?? []
  );
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
 * The agent itself needs its provider key. Checked here (not just by the
 * harness) because the harness SKIPs the experiment with exit 0 on missing
 * credentials — the runner would only notice at the no-result check. A
 * set-but-EMPTY var counts as missing (node --env-file does not override
 * an existing env var, even an empty one, so a stray `export KEY=` in the
 * shell silently shadows .env — observed live).
 */
function validateAgentKey() {
  if (process.env.ANTHROPIC_API_KEY) return;
  fail(
    process.env.ANTHROPIC_API_KEY === undefined
      ? 'ANTHROPIC_API_KEY not set — add it to .env at the repo root'
      : 'ANTHROPIC_API_KEY is set but EMPTY in your shell, which shadows .env (node --env-file never overrides an existing var) — unset it or export a real value'
  );
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
  // Fixture-drift heads-up: platform-lite tracks the pinned package version,
  // and a local build from a newer line may call endpoints the fixture does
  // not serve yet (observed: get_logs moved logs.all -> logs in 0.9.0 while
  // the pin and fixture sat at 0.8.x). Warn, don't block.
  try {
    const local = JSON.parse(
      readFileSync(join(p, 'package.json'), 'utf8')
    ).version;
    if (local && local !== MCP_SERVER_VERSION)
      console.error(
        `note: local mcp build is v${local}; the harness fixture (platform-lite) tracks the v${MCP_SERVER_VERSION} pin — endpoint drift is possible; judge by tool-call activation, not pass/fail alone`
      );
  } catch {
    /* unversioned checkout: nothing to compare */
  }
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
  const resultPath = join(
    RESULTS_ROOT,
    'results',
    experiment,
    `${evalId}.json`
  );
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

/** Run one eval in the treatment world, write its receipt, report. */
function runTreatment(
  id: string,
  experiment: string,
  runs: number,
  opts: { env: Record<string, string>; mcpPath?: string }
): void {
  const { env, mcpPath } = opts;
  console.log(
    `== treatment: ${id} (${experiment}, runs=${runs}${mcpPath ? ', mcp override' : ''}) ==`
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
    provenance: collectProvenance(mcpPath),
  };
  writeFileSync(
    join(OUT_DIR, `${id}.treatment.json`),
    `${JSON.stringify(receipt, null, 1)}\n`
  );

  console.log(`\n=== local run: ${id} (${experiment}) ===`);
  console.log(reportRow('treatment', result, 'your world'));
  console.log(`saved: results-local/${id}.treatment.json`);
}

// ---------- subcommands ----------

async function cmdExperiments() {
  const published = new Set(
    loadPublished().flatMap((f) => f.rows.map((r) => r.experiment))
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
      `${name.padEnd(36)} ${(display.agent ?? '?').padEnd(12)} ${(display.modelId ?? '?').padEnd(22)} ${(display.reasoningEffort ?? '-').padEnd(8)} ${published.has(name) ? 'yes' : '-'}`
    );
  }
}

const RUN_USAGE =
  'usage: pnpm local run <eval-id...> [--experiment <id>] [--runs N] [--mcp <path>]';

async function cmdRun(argv: string[]) {
  const parsed = (() => {
    try {
      return parseArgs({
        args: argv,
        options: {
          experiment: { type: 'string' },
          runs: { type: 'string' },
          mcp: { type: 'string' },
        },
        allowPositionals: true,
      });
    } catch (err) {
      fail(`${err instanceof Error ? err.message : String(err)}\n${RUN_USAGE}`);
    }
  })();
  const { values, positionals } = parsed;
  const experiment = values.experiment ?? DEFAULT_EXPERIMENT;
  validateExperiment(experiment);
  const evalIds = positionals;
  if (!evalIds.length) fail(RUN_USAGE);

  validateEvals(evalIds);
  // these gates are spend-relevant only for real runs; the test hook fakes them
  if (!process.env.LOCAL_EVAL_CMD) {
    validateAgentKey();
    await validateSkills(experiment);
    validateJudgeKeys(evalIds);
  }

  const env: Record<string, string> = {};
  const mcpPath = values.mcp ? resolveMcpServerPath(values.mcp) : undefined;
  if (mcpPath) env.SUPABASE_MCP_SERVER_PATH = mcpPath;

  mkdirSync(OUT_DIR, { recursive: true });
  for (const id of evalIds) {
    const runs = Number(values.runs ?? 1);
    runTreatment(id, experiment, runs, { env, mcpPath });
  }
}

// ---------- entry ----------

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'run':
    await cmdRun(rest);
    break;
  case 'experiments':
    await cmdExperiments();
    break;
  default:
    fail(`usage: pnpm local <run|experiments> ...
  run <eval...>   run eval(s) in your world (skills tree as-is; --mcp override)
  experiments     list experiments (agent, model, effort, published availability)`);
}
