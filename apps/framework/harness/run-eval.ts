#!/usr/bin/env tsx
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { parseEvalMarkdown } from '@supabase-evals/core/eval-markdown';
import {
  createBareSandbox,
  frontmatterDescription,
  stripFrontmatter,
} from '@supabase-evals/sandbox';
import {
  normalizeExperimentName,
  positiveInteger,
  readExperimentSuiteFilters,
  readFlag,
  readRepeatedFlag,
  readSuiteFilters,
} from '../lib/cli-args.js';
import { bootPlatformBackend } from './platform-backend.js';
import { viteBuild, vitestRun } from './project-runner.js';
import {
  buildDocsResult,
  buildSkillResult,
  rehydrateTruncatedDocsResults,
  getExperimentDisplayMetadata,
  supabaseMcpServerMounts,
} from '@supabase-evals/core';
import type {
  ExperimentConfig,
  EvalInterface,
  EvalManifest,
  EvalMode,
  EvalSuite,
  ToolScorer,
  LocalStackScorer,
  ScoreResult,
  SkillResult,
  DocsResult,
  ToolCallRecord,
  TranscriptPart,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

// Fixed identifiers for the mocked hosted project a local-stack eval links to.
// Both must satisfy the CLI's format checks: ref is `^[a-z]{20}$`, token is
// `^sbp_[a-f0-9]{40}$`. platform-lite accepts whatever token it's booted with.
const HOSTED_PROJECT_REF = 'evalshostedprojectxy';
const HOSTED_ACCESS_TOKEN = 'sbp_' + '0'.repeat(40);

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const FORCE = !args.has('--skip-existing');
const SMOKE = args.has('--smoke');
const DRY = args.has('--dry');
const EXPERIMENT_FILTERS = readRepeatedFlag(rawArgs, 'experiment').map(
  normalizeExperimentName
);
const EVAL_FILTERS = readRepeatedFlag(rawArgs, 'eval');
const SUITE_FILTERS = readSuiteFilters(rawArgs);
const EXPERIMENT_SUITE_FILTERS = readExperimentSuiteFilters(rawArgs);
const SELECTED_EXPERIMENT_SUITE =
  EXPERIMENT_SUITE_FILTERS.length === 1
    ? EXPERIMENT_SUITE_FILTERS[0]
    : undefined;
const RUNS = positiveInteger(readFlag(rawArgs, 'runs') ?? '1', 'runs');
// Lets the Vercel controller run one specific index in its own Sandbox.
const RUN_INDEX_FLAG = readFlag(rawArgs, 'run-index');
const RUN_INDEX = RUN_INDEX_FLAG
  ? positiveInteger(RUN_INDEX_FLAG, 'run-index')
  : undefined;
const RUN_INDEXES =
  RUN_INDEX === undefined
    ? Array.from({ length: RUNS }, (_, index) => index + 1)
    : [RUN_INDEX];
const TIMEOUT_SEC = positiveInteger(
  readFlag(rawArgs, 'timeout-sec') ?? '720',
  'timeout-sec'
);
const CONCURRENCY = positiveInteger(
  readFlag(rawArgs, 'concurrency') ?? '1',
  'concurrency'
);
const DEBUG = args.has('--debug');

async function loadExperiments() {
  const dir = join(ROOT, 'experiments');
  const out: Array<{ name: string; config: ExperimentConfig }> = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    out.push({
      name: f.replace(/\.ts$/, ''),
      config: mod.default as ExperimentConfig,
    });
  }
  return out;
}

/**
 * Resolve the run mode. The sandbox (local-stack) is needed when the agent
 * uses the Supabase CLI (`interface: cli`) — including bootstrap scenarios that
 * start from an empty workspace — or when the eval ships a `local/` workspace
 * of starting files. Everything else runs against the in-memory tools runtime.
 *
 * `interface` is otherwise a benchmark dimension (KPI), not a runtime switch.
 */
function resolveEvalMode(
  interfaceKind: EvalInterface | undefined,
  hasLocal: boolean
): EvalMode {
  if (interfaceKind === 'cli' || hasLocal) return 'local-stack';
  return 'tools';
}

function discoverEvals(): EvalManifest[] {
  const dir = join(ROOT, 'evals');
  if (!existsSync(dir)) return [];
  const out: EvalManifest[] = [];
  for (const id of readdirSync(dir)) {
    const evalDir = join(dir, id);
    if (!statSync(evalDir).isDirectory()) continue;
    const localDir = join(evalDir, 'local');
    const promptPath = join(evalDir, 'PROMPT.md');
    const evalPath = join(evalDir, 'EVAL.ts');
    const metadata = parseEvalMarkdown(
      readFileSync(promptPath, 'utf8'),
      `evals/${id}/PROMPT.md`
    ).metadata;
    const hasLocal = existsSync(localDir) && statSync(localDir).isDirectory();
    const mode = resolveEvalMode(metadata.interface, hasLocal);
    out.push({
      id,
      mode,
      metadata,
      stage: metadata.stage,
      product: metadata.product,
      suite: metadata.suite,
      topic: metadata.topic,
      dir: evalDir,
      localDir: hasLocal ? localDir : undefined,
      promptPath,
      evalPath,
      remoteDir: join(evalDir, 'remote'),
    });
  }
  return out;
}

type ToolsSkill = { name: string; description: string; body: string };

/**
 * Tools-mode skills, read from the host `skills/` dir. Unlike local-stack
 * (where skills are installed into the sandbox and the agent reads SKILL.md
 * with its file tools), a tools-mode agent has no filesystem — so only each
 * skill's name+description is advertised in the prompt and a `load_skill` tool
 * returns the full body on demand. Same lazy/progressive-disclosure property,
 * different load mechanism. Missing skills are skipped with a warning.
 */
function loadToolsSkills(skillNames: string[]): ToolsSkill[] {
  const skills: ToolsSkill[] = [];
  for (const name of skillNames) {
    const p = join(ROOT, 'skills', name, 'SKILL.md');
    if (!existsSync(p)) {
      console.warn(
        `SKILL ${name} not found at skills/${name} — ensure the submodule is initialised (\`git submodule update --init\`); skipping`
      );
      continue;
    }
    const md = readFileSync(p, 'utf8');
    skills.push({
      name,
      description: frontmatterDescription(md),
      body: stripFrontmatter(md),
    });
  }
  return skills;
}

/**
 * Discovery listing for the tools-mode system prompt: only names+descriptions,
 * so the agent knows when a skill is relevant without its full text in context.
 * Empty when there are no skills.
 */
function buildToolsSkillsPrompt(skills: readonly ToolsSkill[]): string {
  if (skills.length === 0) return '';
  return [
    '## Available skills',
    '',
    'The following agent skills are available. Only their names and descriptions are shown — ' +
      'the full instructions are not loaded yet. When a task matches a skill, call the `load_skill` ' +
      'tool with its name to load its full instructions.',
    '',
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join('\n');
}

/**
 * The agent-invoked `load_skill` tool: given a skill name it returns that
 * skill's full instructions. This is how tools-mode evals load a skill lazily
 * (the local-stack equivalent is the agent reading SKILL.md with files_read).
 * Empty toolset when there are no skills.
 */
function buildLoadSkillTool(skills: readonly ToolsSkill[]): ToolSet {
  if (skills.length === 0) return {};
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    load_skill: tool({
      description:
        "Load an agent skill's full instructions by name. Available skills are listed in the system prompt.",
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'The skill name to load (as listed under Available skills).',
            enum: skills.map((s) => s.name),
          },
        },
        required: ['name'],
      }),
      execute: async (input) => {
        const name = String((input as { name?: unknown })?.name ?? '');
        const entry = byName.get(name);
        if (!entry) {
          throw new Error(
            `unknown skill "${name}"; available: ${skills.map((s) => s.name).join(', ')}`
          );
        }
        return { instructions: entry.body };
      },
    }),
  };
}

/**
 * Local-stack skill sources: resolve each skill name to its host directory so
 * the sandbox can install it with Vercel's `skills` CLI; the agent then
 * discovers each skill by reading its SKILL.md with its file tools. The
 * `skills/` entries are symlinks into the agent-skills submodule; realpath them
 * so `docker cp` copies real files, not dangling links. Missing skills are
 * skipped with a warning.
 */
function resolveSkillSources(
  skillNames: string[]
): Array<{ name: string; dir: string }> {
  const sources: Array<{ name: string; dir: string }> = [];
  for (const name of skillNames) {
    const dir = join(ROOT, 'skills', name);
    if (!existsSync(dir)) {
      console.warn(
        `SKILL ${name} not found at skills/${name} — ensure the submodule is initialised (\`git submodule update --init\`); skipping`
      );
      continue;
    }
    sources.push({ name, dir: realpathSync(dir) });
  }
  return sources;
}

function runDir(modelName: string, evalId: string, run: number) {
  return join(ROOT, 'results', modelName, evalId, `run-${run}`);
}

function resultPath(modelName: string, evalId: string, run: number) {
  return join(runDir(modelName, evalId, run), 'result.json');
}

function workspacePath(modelName: string, evalId: string, run: number) {
  return join(runDir(modelName, evalId, run), 'workspace');
}

function copyWithheldTests(ev: EvalManifest, workspace: string) {
  const testsDir = join(ev.dir, 'tests');
  if (existsSync(testsDir)) {
    cpSync(testsDir, join(workspace, 'tests'), { recursive: true });
  }
}

function readSessionSeedArgs(ev: EvalManifest) {
  const projectSeedSql = join(ev.remoteDir, 'project.sql');
  const logsSeedJsonl = join(ev.remoteDir, 'logs.jsonl');
  const functionsSeedDir = join(ev.remoteDir, 'functions');

  return {
    projectSeedSql: existsSync(projectSeedSql) ? projectSeedSql : undefined,
    logsSeedJsonl: existsSync(logsSeedJsonl) ? logsSeedJsonl : undefined,
    functionsSeedDir: existsSync(functionsSeedDir)
      ? functionsSeedDir
      : undefined,
    pgvector: ev.metadata.product.includes('vectors'),
  };
}

function basePromptFor(mode: EvalMode): string {
  if (mode === 'local-stack') {
    return (
      'You are an agent solving a Supabase eval task in a Linux workspace. ' +
      'Use the provided tools to inspect and modify the workspace and run commands. ' +
      'When you are done, end your turn with a short summary of what you did.'
    );
  }
  return (
    'You are an agent solving a Supabase eval task. ' +
    'Use the provided tools to inspect and modify the project. ' +
    'When you are done, end your turn with a short summary of what you did ' +
    '(or for audit tasks, your findings).'
  );
}

function buildSystemPrompt(
  mode: EvalMode,
  addendum?: string,
  skillContext?: string
): string {
  const blocks = [basePromptFor(mode), addendum, skillContext].filter(Boolean);
  return blocks.join('\n\n');
}

/**
 * Adapt a `{ close() }` resource to `AsyncDisposable` so it can be bound with
 * `await using` — cleanup then runs on scope exit (normal fall-through, `continue`,
 * `return`, or a throw), including when a *later* resource created in the same
 * scope throws before its own `try`/`finally` is reached.
 */
function disposable<T extends { close(): Promise<unknown> }>(
  resource: T
): T & AsyncDisposable {
  return Object.assign(resource, {
    [Symbol.asyncDispose]: async () => {
      await resource.close();
    },
  });
}

async function runOne(
  expName: string,
  exp: ExperimentConfig,
  ev: EvalManifest,
  runIndex: number
): Promise<
  ScoreResult & {
    run: number;
    skills: SkillResult;
    docs: DocsResult;
    toolCalls: ToolCallRecord[];
    transcript: TranscriptPart[];
    agentReport: string;
    stoppedReason: string;
  }
> {
  const prompt = parseEvalMarkdown(
    readFileSync(ev.promptPath, 'utf8'),
    ev.promptPath
  ).body;
  // A CLI agent always runs in a sandbox and reads skills from disk with its
  // file tools (both modes). An in-process (ai-sdk) agent has no sandbox, so in
  // tools mode its skills are advertised in the prompt and loaded via the
  // load_skill tool. Skill sources (name+dir) are shared by both paths.
  const agentRunsInSandbox = exp.agent.runsInSandbox ?? false;
  // A per-eval `skills` override replaces the experiment's own list entirely,
  // so a scenario testing self-installed skills gets an empty list regardless
  // of which experiment runs it.
  const skillSources = resolveSkillSources(ev.metadata.skills ?? exp.skills);
  const availableSkills = skillSources.map((skill) => skill.name);
  const toolsSkills =
    ev.mode === 'tools' && !agentRunsInSandbox
      ? loadToolsSkills(ev.metadata.skills ?? exp.skills)
      : [];
  const scorer = (await import(pathToFileURL(ev.evalPath).href)).default as
    | ToolScorer
    | LocalStackScorer;
  if (ev.mode === 'local-stack') {
    // One fresh local-stack session per scored run.
    if (!exp.localStack) {
      throw new Error(
        `eval ${ev.id} has interface: cli but experiment "${expName}" does not configure a local stack runtime. ` +
          `Add \`localStack: localStackRuntime()\` (from "@supabase-evals/sandbox") to experiments/${expName}.ts.`
      );
    }
    // Boots a platform-lite backend seeded from the eval's `remote/` dir so scorers
    // that read remote state (e.g. migration history) have something to assert on.
    await using hostedBackend = ev.metadata.hostedProject
      ? disposable(
          await bootPlatformBackend({
            ...readSessionSeedArgs(ev),
            ref: HOSTED_PROJECT_REF,
            accessToken: HOSTED_ACCESS_TOKEN,
            hostname: '0.0.0.0',
            // So linked DB workflows (`db push`, `migration repair`) reach the project too.
            pgWire: true,
          })
        )
      : undefined;
    await using session = disposable(
      await exp.localStack.startSession({
        cliVersion: ev.metadata.cliVersion,
        localDir: ev.localDir,
        includeServices: ev.metadata.services,
        projectRunning: ev.metadata.projectRunning,
        hosted: hostedBackend
          ? {
              port: Number(new URL(hostedBackend.url).port),
              pgPort: hostedBackend.pgPort,
              ref: hostedBackend.ref,
              accessToken: hostedBackend.accessToken,
              mgmt: hostedBackend.mgmt,
              query: hostedBackend.query,
              invokeFunction: hostedBackend.invokeFunction,
            }
          : undefined,
        skills: skillSources,
        mounts: supabaseMcpServerMounts(),
        skipCliInstall: ev.metadata.skipCliInstall,
      })
    );

    const run = await exp.agent.run({
      systemPrompt: buildSystemPrompt('local-stack', session.promptAddendum),
      userPrompt: prompt,
      tools: session.tools,
      sandbox: session.sandbox,
      mcpServers: session.mcpServers,
      timeoutSec: TIMEOUT_SEC,
    });
    // Exports the workspace so scorers can run host tooling (vite/vitest) against it.
    // Withheld tests are copied in lazily, only if the scorer asks to run Vitest.
    const hostWorkspace = workspacePath(expName, ev.id, runIndex);
    rmSync(hostWorkspace, { recursive: true, force: true });
    await session.exportWorkspace(hostWorkspace);
    let copiedWithheldTests = false;
    const ensureWithheldTests = () => {
      if (copiedWithheldTests) return;
      copyWithheldTests(ev, hostWorkspace);
      copiedWithheldTests = true;
    };

    const last = await (scorer as LocalStackScorer)({
      ...session.scoringContext,
      toolCalls: run.toolCalls,
      transcript: run.transcript,
      agentReport: run.agentReport,
      hostWorkspace,
      runViteBuild: () => viteBuild(hostWorkspace),
      runVitest: () => {
        ensureWithheldTests();
        return vitestRun(hostWorkspace);
      },
    });

    // Runs after scoring so the scorer sees what the agent actually saw, not rehydrated content.
    await rehydrateTruncatedDocsResults(session.sandbox, run.toolCalls);

    return {
      ...last,
      run: runIndex,
      skills: buildSkillResult(availableSkills, run.toolCalls),
      docs: buildDocsResult(run.toolCalls),
      toolCalls: run.toolCalls,
      transcript: run.transcript,
      agentReport: run.agentReport,
      stoppedReason: run.stoppedReason,
    };
  }

  // Tools mode: a CLI agent gets a bare sandbox reaching platform-lite via
  // host.docker.internal. An in-process agent runs host-side with no sandbox.
  await using cliSandbox = agentRunsInSandbox
    ? disposable(
        await createBareSandbox({
          skills: skillSources,
          mounts: supabaseMcpServerMounts(),
        })
      )
    : undefined;
  await using session = disposable(
    await exp.runtime.startSession({
      ...readSessionSeedArgs(ev),
      hostname: agentRunsInSandbox ? '0.0.0.0' : undefined,
    })
  );

  // In-process agents have no filesystem, so skills are advertised in the
  // prompt and pulled on demand via the load_skill tool instead.
  const skillsPrompt = agentRunsInSandbox
    ? cliSandbox!.promptAddendum
    : buildToolsSkillsPrompt(toolsSkills);
  const systemPrompt = buildSystemPrompt(
    'tools',
    session.promptAddendum,
    skillsPrompt
  );
  const run = await exp.agent.run({
    systemPrompt,
    userPrompt: prompt,
    tools: agentRunsInSandbox ? undefined : buildLoadSkillTool(toolsSkills),
    mcpServers: session.mcpServers,
    sandbox: cliSandbox?.sandbox,
    timeoutSec: TIMEOUT_SEC,
  });
  const last = await (scorer as ToolScorer)({
    ...session.scoringContext,
    toolCalls: run.toolCalls,
    transcript: run.transcript,
    agentReport: run.agentReport,
  });

  // Runs after scoring so the scorer sees what the agent actually saw, not rehydrated content.
  if (cliSandbox)
    await rehydrateTruncatedDocsResults(cliSandbox.sandbox, run.toolCalls);

  return {
    ...last,
    run: runIndex,
    skills: buildSkillResult(availableSkills, run.toolCalls),
    docs: buildDocsResult(run.toolCalls),
    toolCalls: run.toolCalls,
    transcript: run.transcript,
    agentReport: run.agentReport,
    stoppedReason: run.stoppedReason,
  };
}

function formatPlanLine(
  name: string,
  config: ExperimentConfig,
  ev: EvalManifest
): string {
  const head = `PLAN ${name} x ${ev.id}  stage=${ev.stage} suite=${ev.suite}`;
  if (ev.mode === 'local-stack') {
    return `${head} mode=local-stack runtime=${config.localStack?.id} model=${config.agent.modelId}`;
  }
  return `${head} mode=tools runtime=${config.runtime.id} model=${config.agent.modelId}`;
}

function formatRunSummary(res: ScoreResult): string {
  if (!res.checks?.length) return '';
  const passed = res.checks.filter((check) => check.passed).length;
  return `checks ${passed}/${res.checks.length}`;
}

async function runConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      let item: T | undefined;
      while ((item = queue.shift()) !== undefined) await fn(item);
    }
  );
  await Promise.all(workers);
}

async function main() {
  if (rawArgs.filter((a) => a !== '--')[0] === 'list') {
    const experiments = await loadExperiments();
    let filtered =
      EXPERIMENT_SUITE_FILTERS.length > 0
        ? experiments.filter(
            (e) =>
              e.config.suite !== undefined &&
              e.config.suite.some((suite) =>
                EXPERIMENT_SUITE_FILTERS.includes(suite)
              )
          )
        : experiments;
    if (EVAL_FILTERS.length > 0) {
      // Drop experiments that would skipEval every requested eval, so callers
      // building an experiment x eval matrix (e.g. the eval-refresh workflow)
      // don't plan a pair that will produce no results — and no artifact —
      // to upload.
      const evals = discoverEvals().filter((ev) =>
        EVAL_FILTERS.includes(ev.id)
      );
      filtered = filtered.filter(({ config }) =>
        evals.some((ev) => !config.skipEval?.(ev))
      );
    }
    console.log(JSON.stringify(filtered.map((e) => e.name)));
    return;
  }

  const allExperiments = await loadExperiments();
  if (EXPERIMENT_FILTERS.length > 0) {
    const experimentNames = new Set(allExperiments.map(({ name }) => name));
    const missing = EXPERIMENT_FILTERS.filter(
      (name) => !experimentNames.has(name)
    );
    if (missing.length > 0) {
      throw new Error(`no experiment matched: ${missing.join(',')}`);
    }
  }

  const experiments = allExperiments.filter(({ name, config }) => {
    if (EXPERIMENT_FILTERS.length > 0 && !EXPERIMENT_FILTERS.includes(name))
      return false;
    if (
      EXPERIMENT_SUITE_FILTERS.length > 0 &&
      (config.suite === undefined ||
        !config.suite.some((suite) => EXPERIMENT_SUITE_FILTERS.includes(suite)))
    )
      return false;
    return true;
  });
  if (EXPERIMENT_FILTERS.length > 0) {
    if (experiments.length === 0) {
      throw new Error(
        `no experiments matched experiment=${EXPERIMENT_FILTERS.join(',')}`
      );
    }
  }
  const evals = discoverEvals();
  if (EVAL_FILTERS.length > 0) {
    const evalIds = new Set(evals.map((e) => e.id));
    const missing = EVAL_FILTERS.filter((evalId) => !evalIds.has(evalId));
    if (missing.length > 0) {
      throw new Error(`no eval matched: ${missing.join(',')}`);
    }
  }

  const filtered = SMOKE
    ? Object.values(
        evals.reduce<Record<string, EvalManifest>>((acc, e) => {
          acc[e.stage] ??= e;
          return acc;
        }, {})
      )
    : EVAL_FILTERS.length > 0
      ? evals.filter((e) => EVAL_FILTERS.includes(e.id))
      : evals;
  const suiteFiltered =
    SUITE_FILTERS.length > 0
      ? filtered.filter((e) => SUITE_FILTERS.includes(e.suite))
      : filtered;

  if (suiteFiltered.length === 0) {
    const filter = [
      EVAL_FILTERS.length > 0 ? `eval=${EVAL_FILTERS.join(',')}` : undefined,
      SUITE_FILTERS.length > 0 ? `suite=${SUITE_FILTERS.join(',')}` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    throw new Error(`no evals matched ${filter}`);
  }

  // Suppress noisy supabase-js logs from expected failures; --debug keeps them visible.
  const stderr = console.error;
  if (!DEBUG) console.error = () => undefined;

  console.log(
    `${experiments.length} experiment(s), ${suiteFiltered.length} eval(s), ` +
      `runs=${RUN_INDEXES.join(',')}, timeout=${TIMEOUT_SEC}s, ` +
      `concurrency=${CONCURRENCY}`
  );

  const allWork: Array<{
    name: string;
    config: ExperimentConfig;
    ev: EvalManifest;
    run: number;
  }> = [];

  for (const { name, config } of experiments) {
    if (!DRY) {
      try {
        config.agent.assertReady();
      } catch (e) {
        stderr(`SKIP ${name} (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
    }

    for (const ev of suiteFiltered) {
      if (ev.mode === 'local-stack' && !config.localStack) {
        console.log(
          `SKIP ${name} x ${ev.id} (no local stack runtime — add \`localStack: localStackRuntime()\` from "@supabase-evals/sandbox" to experiments/${name}.ts)`
        );
        continue;
      }
      if (config.skipEval?.(ev)) {
        console.log(`SKIP ${name} x ${ev.id} (skipEval)`);
        continue;
      }
      if (DRY) {
        console.log(formatPlanLine(name, config, ev));
        continue;
      }
      for (const run of RUN_INDEXES) {
        if (!FORCE && existsSync(resultPath(name, ev.id, run))) {
          console.log(`SKIP ${name} x ${ev.id} run ${run} (already ran)`);
          continue;
        }
        allWork.push({ name, config, ev, run });
      }
    }
  }

  let localStackTurn = Promise.resolve();
  const errored: Error[] = [];

  const runWork = async ({
    name,
    config,
    ev,
    run: runIndex,
  }: (typeof allWork)[number]) => {
    const out = resultPath(name, ev.id, runIndex);
    const label = `${name} x ${ev.id} run ${runIndex}`;
    const start = Date.now();
    console.log(`⏳ RUN  ${label}`);
    const run = async () => {
      try {
        const res = await runOne(name, config, ev, runIndex);
        mkdirSync(dirname(out), { recursive: true });
        const experimentDisplay = getExperimentDisplayMetadata(config);
        writeFileSync(
          out,
          JSON.stringify(
            {
              experiment: name,
              experimentSuite: SELECTED_EXPERIMENT_SUITE ?? config.suite?.[0],
              experimentDisplay,
              eval: ev.id,
              ...ev.metadata,
              ...res,
            },
            null,
            2
          )
        );
        const elapsed = Math.round((Date.now() - start) / 1000);
        console.log(
          `${res.passed ? '✅ PASS' : '❌ FAIL'} ${label} (${formatRunSummary(res)}, ${elapsed}s)\n   → ${relative(ROOT, out)}`
        );
      } catch (e) {
        errored.push(new Error(label, { cause: e }));
        const elapsed = Math.round((Date.now() - start) / 1000);
        stderr(
          `💥 ERR  ${label}: ${e instanceof Error ? e.message : String(e)} (${elapsed}s)`
        );
      }
    };
    if (ev.mode !== 'local-stack') return run();
    const prev = localStackTurn;
    let release!: () => void;
    localStackTurn = new Promise((r) => (release = r));
    await prev;
    try {
      await run();
    } finally {
      release();
    }
  };

  await runConcurrent(allWork, CONCURRENCY, runWork);
  console.error = stderr;

  if (errored.length > 0) {
    throw new AggregateError(errored, `${errored.length} eval(s) errored`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
