#!/usr/bin/env tsx
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { parseEvalMarkdown } from '@supabase-evals/core/eval-markdown';
import { rawEvalResultSchema } from '@supabase-evals/core/eval-metadata';
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
  validateCliArgs,
} from '../lib/cli-args.js';
import { bootPlatformBackend } from './platform-backend.js';
import { viteBuild, vitestRun } from './project-runner.js';
import {
  buildDocsResult,
  buildSkillResult,
  getExperimentDisplayMetadata,
  MCP_SERVER_VERSION,
  rehydrateTruncatedDocsResults,
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
const RESULTS_ROOT = process.env.LOCAL_RESULTS_ROOT ?? ROOT;
const SKILLS_ROOT = process.env.LOCAL_SKILLS_ROOT ?? join(ROOT, 'skills');

// Fixed identifiers for the mocked hosted project a local-stack eval links to.
// Both must satisfy the CLI's format checks: ref is `^[a-z]{20}$`, token is
// `^sbp_[a-f0-9]{40}$`. platform-lite accepts whatever token it's booted with.
const HOSTED_PROJECT_REF = 'evalshostedprojectxy';
const HOSTED_ACCESS_TOKEN = 'sbp_' + '0'.repeat(40);

const rawArgs = process.argv.slice(2);
const CLI_ARGS = {
  booleanFlags: [
    'skip-existing',
    'smoke',
    'dry',
    'strict',
    'run-all-attempts',
    'debug',
  ],
  valueFlags: [
    'mcp',
    'experiment',
    'eval',
    'suite',
    'experiment-suite',
    'runs',
    'timeout-sec',
    'concurrency',
  ],
  positionals: ['list'],
  usage:
    'Usage: pnpm eval -- [list] [--skip-existing] [--smoke] [--dry] [--strict] [--run-all-attempts] [--debug] [--mcp PATH] [--experiment NAME] [--eval ID] [--suite SUITE] [--experiment-suite SUITE] [--runs N] [--timeout-sec N] [--concurrency N]',
} as const;
try {
  validateCliArgs(rawArgs, CLI_ARGS);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const args = new Set(rawArgs);
const FORCE = !args.has('--skip-existing');
const SMOKE = args.has('--smoke');
const DRY = args.has('--dry');
const STRICT = args.has('--strict');
const MCP_PATH = readFlag(rawArgs, 'mcp');
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
const TIMEOUT_SEC = positiveInteger(
  readFlag(rawArgs, 'timeout-sec') ?? '720',
  'timeout-sec'
);
const CONCURRENCY = positiveInteger(
  readFlag(rawArgs, 'concurrency') ?? '1',
  'concurrency'
);
const STOP_ON_PASS = !args.has('--run-all-attempts');
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
    const p = join(SKILLS_ROOT, name, 'SKILL.md');
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
    const dir = join(SKILLS_ROOT, name);
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

function resultPath(modelName: string, ev: Pick<EvalManifest, 'id' | 'mode'>) {
  return join(RESULTS_ROOT, 'results', modelName, `${ev.id}.json`);
}

function workspacePath(modelName: string, evalId: string, attempt: number) {
  return join(
    RESULTS_ROOT,
    'results',
    modelName,
    evalId,
    `attempt-${attempt}`,
    'workspace'
  );
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
type RunResult = ScoreResult & {
  attempts: number;
  skills: SkillResult;
  docs: DocsResult;
  toolCalls: ToolCallRecord[];
  transcript: TranscriptPart[];
  agentReport: string;
  stoppedReason: string;
};

async function runOne(
  expName: string,
  exp: ExperimentConfig,
  ev: EvalManifest
): Promise<RunResult> {
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
  let last: ScoreResult = {
    passed: false,
    checks: [{ name: 'ran at least one attempt', passed: false }],
  };
  let lastToolCalls: ToolCallRecord[] = [];
  let lastTranscript: TranscriptPart[] = [];
  let lastAgentReport = '';
  let lastStoppedReason = 'not_started';

  for (let attempt = 1; attempt <= RUNS; attempt += 1) {
    if (ev.mode === 'local-stack') {
      // Local-stack mode: the experiment's local-stack tool surface provides
      // the sandbox session; one fresh session per attempt.
      if (!exp.localStack) {
        throw new Error(
          `eval ${ev.id} has interface: cli but experiment "${expName}" does not configure a local stack runtime. ` +
            `Add \`localStack: localStackRuntime()\` (from "@supabase-evals/sandbox") to experiments/${expName}.ts.`
        );
      }
      // When the eval links to a hosted project, boot a platform-lite backend
      // (bound to 0.0.0.0 so the sandbox reaches it via host.docker.internal)
      // and hand the CLI-valid ref/token to the session. Seed it from the eval's
      // `remote/` dir (project.sql / logs.jsonl / functions) just like the tools
      // runtime does — otherwise the hosted project boots empty and scorers that
      // read remote state (e.g. the migration history) have nothing to assert on.
      await using hostedBackend = ev.metadata.hostedProject
        ? disposable(
            await bootPlatformBackend({
              ...readSessionSeedArgs(ev),
              ref: HOSTED_PROJECT_REF,
              accessToken: HOSTED_ACCESS_TOKEN,
              hostname: '0.0.0.0',
              // Expose Postgres-wire too, so linked DB workflows (`db push`,
              // `migration repair`) reach the same project over the wire.
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
      lastToolCalls = run.toolCalls;
      lastTranscript = run.transcript;
      lastAgentReport = run.agentReport;
      lastStoppedReason = run.stoppedReason;

      // Export the agent's workspace to the host so scorers can run host
      // tooling (vite/vitest from the repo root) against the produced files
      // — the tools live on the host, not in the sandbox. Withheld tests are
      // copied in lazily, only if the scorer asks to run Vitest.
      const hostWorkspace = workspacePath(expName, ev.id, attempt);
      rmSync(hostWorkspace, { recursive: true, force: true });
      await session.exportWorkspace(hostWorkspace);
      let copiedWithheldTests = false;
      const ensureWithheldTests = () => {
        if (copiedWithheldTests) return;
        copyWithheldTests(ev, hostWorkspace);
        copiedWithheldTests = true;
      };

      last = await (scorer as LocalStackScorer)({
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

      if (STOP_ON_PASS && last.passed) {
        return {
          ...last,
          attempts: attempt,
          skills: buildSkillResult(availableSkills, run.toolCalls),
          docs: buildDocsResult(run.toolCalls),
          toolCalls: run.toolCalls,
          transcript: run.transcript,
          agentReport: run.agentReport,
          stoppedReason: run.stoppedReason,
        };
      }
      logRetryAttempt(expName, ev, attempt, last);
      continue;
    }

    // Tools mode: the eval's tool surface is MCP (platform-lite). A CLI agent
    // gets the same sandbox as local-stack minus the running stack — with its
    // skills installed — and reaches the in-container MCP servers' host-side
    // platform-lite via host.docker.internal (so platform-lite binds 0.0.0.0).
    // An in-process agent runs host-side with no sandbox.
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

    // CLI agents read their installed skills from disk (the bare sandbox folds
    // the discovery listing into its promptAddendum). In-process agents have
    // no filesystem, so their skills are advertised in the prompt and pulled
    // on demand via the load_skill tool.
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
    lastToolCalls = run.toolCalls;
    lastTranscript = run.transcript;
    lastAgentReport = run.agentReport;
    lastStoppedReason = run.stoppedReason;
    last = await (scorer as ToolScorer)({
      ...session.scoringContext,
      toolCalls: run.toolCalls,
      transcript: run.transcript,
      agentReport: run.agentReport,
    });

    // Runs after scoring so the scorer sees what the agent actually saw, not rehydrated content.
    if (cliSandbox)
      await rehydrateTruncatedDocsResults(cliSandbox.sandbox, run.toolCalls);

    if (STOP_ON_PASS && last.passed) {
      return {
        ...last,
        attempts: attempt,
        skills: buildSkillResult(availableSkills, run.toolCalls),
        docs: buildDocsResult(run.toolCalls),
        toolCalls: run.toolCalls,
        transcript: run.transcript,
        agentReport: run.agentReport,
        stoppedReason: run.stoppedReason,
      };
    }
    logRetryAttempt(expName, ev, attempt, last);
  }

  return {
    ...last,
    attempts: RUNS,
    skills: buildSkillResult(availableSkills, lastToolCalls),
    docs: buildDocsResult(lastToolCalls),
    toolCalls: lastToolCalls,
    transcript: lastTranscript,
    agentReport: lastAgentReport,
    stoppedReason: lastStoppedReason,
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

function formatRunSummary(res: ScoreResult & { attempts: number }): string {
  const parts: string[] = [];
  if (res.checks?.length) {
    const passed = res.checks.filter((check) => check.passed).length;
    parts.push(`checks ${passed}/${res.checks.length}`);
  }
  parts.push(`attempts ${res.attempts}`);

  return parts.join(', ');
}

/** Prints a retry line when a failed attempt will be followed by another. */
function logRetryAttempt(
  expName: string,
  ev: EvalManifest,
  attempt: number,
  result: ScoreResult
) {
  if (!STOP_ON_PASS || result.passed || attempt >= RUNS) return;
  const summary = formatRunSummary({ ...result, attempts: attempt });
  console.log(
    `🔁 RETRY ${expName} x ${ev.id} (attempt ${attempt}/${RUNS} failed, ${summary})`
  );
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
type Provenance = {
  generatedAt: string;
  host: { sha?: string; branch?: string; dirtyFiles: number };
  mcpOverride?: { path: string; sha?: string; dirtyFiles?: number };
  platform: string;
};

function tryGit(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, { cwd, maxBuffer: 1 << 28 })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

function collectProvenance(mcpPath?: string): Provenance {
  const dirty = (cwd: string) =>
    (tryGit(['status', '--porcelain'], cwd) ?? '').split('\n').filter(Boolean)
      .length;
  const provenance: Provenance = {
    generatedAt: new Date().toISOString(),
    host: {
      sha: tryGit(['rev-parse', 'HEAD'], ROOT),
      branch: tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], ROOT),
      dirtyFiles: dirty(ROOT),
    },
    platform: `${process.platform}/${process.arch} node ${process.version}`,
  };
  if (mcpPath) {
    const repository = tryGit(['rev-parse', '--show-toplevel'], mcpPath);
    provenance.mcpOverride = {
      path: mcpPath,
      sha: repository ? tryGit(['rev-parse', 'HEAD'], repository) : undefined,
      dirtyFiles: repository ? dirty(repository) : undefined,
    };
  }
  return provenance;
}

function resolveMcpServerPath(raw: string): string {
  let path = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  if (!existsSync(path)) throw new Error(`--mcp path does not exist: ${path}`);
  const packageDir = join(path, 'packages', 'mcp-server-supabase');
  if (existsSync(packageDir)) path = packageDir;
  if (!existsSync(join(path, 'dist', 'transports', 'stdio.js'))) {
    throw new Error(
      `no built server at ${path} (dist/transports/stdio.js missing) — build it first:\n  pnpm install && pnpm build`
    );
  }
  try {
    const localVersion = JSON.parse(
      readFileSync(join(path, 'package.json'), 'utf8')
    ).version;
    if (localVersion && localVersion !== MCP_SERVER_VERSION) {
      console.error(
        `note: local mcp build is v${localVersion}; the harness fixture (platform-lite) tracks the v${MCP_SERVER_VERSION} pin — endpoint drift is possible`
      );
    }
  } catch {
    // An unversioned checkout is valid when it has the expected built entry.
  }
  return realpathSync(path);
}

function validateJudgeKeys(evals: readonly EvalManifest[]) {
  if (process.env.OPENAI_API_KEY || DRY) return;
  const judged = evals
    .filter(
      (ev) =>
        existsSync(ev.evalPath) &&
        /\bjudge\b/.test(readFileSync(ev.evalPath, 'utf8'))
    )
    .map((ev) => ev.id);
  if (judged.length > 0) {
    throw new Error(
      `these evals score with the LLM judge (OpenAI-backed, regardless of the agent under test): ${judged.join(', ')}\nadd OPENAI_API_KEY to .env at the repo root before running them`
    );
  }
}

function validateStrictSkills(
  experiment: string,
  skillNames: readonly string[]
) {
  if (!STRICT) return;
  const missing = skillNames.filter(
    (name) => !existsSync(join(SKILLS_ROOT, name, 'SKILL.md'))
  );
  if (missing.length > 0) {
    throw new Error(
      `experiment ${experiment} declares skills this checkout is missing: ${missing.join(', ')}\ninitialise the skills submodule first: git submodule update --init`
    );
  }
}
function fakeRun(out: string, experiment: string, evalId: string): RunResult {
  const command = process.env.LOCAL_EVAL_CMD;
  if (!command) throw new Error('LOCAL_EVAL_CMD is required');
  mkdirSync(dirname(out), { recursive: true });
  const fakeOut = `${out}.fake`;
  const result = spawnSync(command, {
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, RES: fakeOut, EVAL: evalId, EXPERIMENT: experiment },
  });
  if (result.status !== 0) {
    rmSync(fakeOut, { force: true });
    throw new Error(`LOCAL_EVAL_CMD failed for ${experiment} x ${evalId}`);
  }
  try {
    return JSON.parse(readFileSync(fakeOut, 'utf8')) as RunResult;
  } finally {
    rmSync(fakeOut, { force: true });
  }
}

async function main() {
  if (rawArgs.filter((arg) => arg !== '--')[0] === 'list') {
    const experiments = await loadExperiments();
    let filtered =
      EXPERIMENT_SUITE_FILTERS.length > 0
        ? experiments.filter(
            (experiment) =>
              experiment.config.suite !== undefined &&
              experiment.config.suite.some((suite) =>
                EXPERIMENT_SUITE_FILTERS.includes(suite)
              )
          )
        : experiments;
    if (EVAL_FILTERS.length > 0) {
      const evals = discoverEvals().filter((evaluation) =>
        EVAL_FILTERS.includes(evaluation.id)
      );
      filtered = filtered.filter(({ config }) =>
        evals.some((evaluation) => !config.skipEval?.(evaluation))
      );
    }
    console.log(JSON.stringify(filtered.map((experiment) => experiment.name)));
    return;
  }

  const mcpPath = MCP_PATH ? resolveMcpServerPath(MCP_PATH) : undefined;
  if (mcpPath) process.env.SUPABASE_MCP_SERVER_PATH = mcpPath;

  const allExperiments = await loadExperiments();
  if (EXPERIMENT_FILTERS.length > 0) {
    const experimentNames = new Set(
      allExperiments.map((experiment) => experiment.name)
    );
    const missing = EXPERIMENT_FILTERS.filter(
      (name) => !experimentNames.has(name)
    );
    if (missing.length > 0) {
      throw new Error(`no experiment matched: ${missing.join(',')}`);
    }
  }

  const experiments = allExperiments.filter(({ name, config }) => {
    if (EXPERIMENT_FILTERS.length > 0 && !EXPERIMENT_FILTERS.includes(name)) {
      return false;
    }
    if (
      EXPERIMENT_SUITE_FILTERS.length > 0 &&
      (config.suite === undefined ||
        !config.suite.some((suite) => EXPERIMENT_SUITE_FILTERS.includes(suite)))
    ) {
      return false;
    }
    return true;
  });
  if (EXPERIMENT_FILTERS.length > 0 && experiments.length === 0) {
    throw new Error(
      `no experiments matched experiment=${EXPERIMENT_FILTERS.join(',')}`
    );
  }

  const evals = discoverEvals();
  if (EVAL_FILTERS.length > 0) {
    const evalIds = new Set(evals.map((evaluation) => evaluation.id));
    const missing = EVAL_FILTERS.filter((evalId) => !evalIds.has(evalId));
    if (missing.length > 0) {
      throw new Error(`no eval matched: ${missing.join(',')}`);
    }
  }

  const filtered = SMOKE
    ? Object.values(
        evals.reduce<Record<string, EvalManifest>>((acc, evaluation) => {
          acc[evaluation.stage] ??= evaluation;
          return acc;
        }, {})
      )
    : EVAL_FILTERS.length > 0
      ? evals.filter((evaluation) => EVAL_FILTERS.includes(evaluation.id))
      : evals;
  const suiteFiltered =
    SUITE_FILTERS.length > 0
      ? filtered.filter((evaluation) =>
          SUITE_FILTERS.includes(evaluation.suite)
        )
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

  const stderr = console.error;

  console.log(
    `${experiments.length} experiment(s), ${suiteFiltered.length} eval(s), ` +
      `runs=${RUNS}, timeout=${TIMEOUT_SEC}s, concurrency=${CONCURRENCY}, ${STOP_ON_PASS ? 'stop-on-pass' : 'run-all-attempts'}`
  );

  const allWork: Array<{
    name: string;
    config: ExperimentConfig;
    ev: EvalManifest;
  }> = [];

  for (const { name, config } of experiments) {
    if (!DRY) {
      try {
        config.agent.assertReady();
      } catch (error) {
        const message = `${name} (${error instanceof Error ? error.message : String(error)})`;
        if (STRICT) throw new Error(message, { cause: error });
        stderr(`SKIP ${message}`);
        continue;
      }
    }

    for (const ev of suiteFiltered) {
      const out = resultPath(name, ev);
      if (!FORCE && existsSync(out)) {
        let existingResultIsValid = false;
        try {
          existingResultIsValid = rawEvalResultSchema.safeParse(
            JSON.parse(readFileSync(out, 'utf8'))
          ).success;
        } catch {
          // A partial write is incomplete work and must run again.
        }
        if (existingResultIsValid) {
          console.log(`SKIP ${name} x ${ev.id} (already ran)`);
          continue;
        }
        console.log(`RERUN ${name} x ${ev.id} (existing result is invalid)`);
      }
      if (ev.mode === 'local-stack' && !config.localStack) {
        const message =
          `${name} x ${ev.id} (no local stack runtime — add ` +
          '`localStack: localStackRuntime()` from "@supabase-evals/sandbox" ' +
          `to experiments/${name}.ts)`;
        if (STRICT) throw new Error(message);
        console.log(`SKIP ${message}`);
        continue;
      }
      if (config.skipEval?.(ev)) {
        console.log(`SKIP ${name} x ${ev.id} (skipEval)`);
        continue;
      }
      validateStrictSkills(name, ev.metadata.skills ?? config.skills);
      if (DRY) {
        console.log(formatPlanLine(name, config, ev));
        continue;
      }
      allWork.push({ name, config, ev });
    }
  }

  validateJudgeKeys([...new Set(allWork.map(({ ev }) => ev))]);
  if (!DEBUG) console.error = () => undefined;
  const provenance = collectProvenance(mcpPath);

  let localStackTurn = Promise.resolve();
  const errored: Error[] = [];

  const runWork = async ({ name, config, ev }: (typeof allWork)[number]) => {
    const out = resultPath(name, ev);
    const start = Date.now();
    console.log(`⏳ RUN  ${name} x ${ev.id}`);
    const run = async () => {
      try {
        const res = process.env.LOCAL_EVAL_CMD
          ? fakeRun(out, name, ev.id)
          : await runOne(name, config, ev);
        mkdirSync(dirname(out), { recursive: true });
        const experimentDisplay = getExperimentDisplayMetadata(config);
        const resultJson = JSON.stringify(
          {
            experiment: name,
            experimentSuite: SELECTED_EXPERIMENT_SUITE ?? config.suite?.[0],
            experimentDisplay,
            eval: ev.id,
            ...ev.metadata,
            ...res,
            provenance,
          },
          null,
          2
        );
        const temporaryOut = `${out}.tmp`;
        writeFileSync(temporaryOut, resultJson);
        renameSync(temporaryOut, out);
        const elapsed = Math.round((Date.now() - start) / 1000);
        console.log(
          `${res.passed ? '✅ PASS' : '❌ FAIL'} ${name} x ${ev.id} (${formatRunSummary(res)}, ${elapsed}s)\n   → ${relative(ROOT, out)}`
        );
      } catch (error) {
        errored.push(new Error(`${name} x ${ev.id}`, { cause: error }));
        const elapsed = Math.round((Date.now() - start) / 1000);
        stderr(
          `💥 ERR  ${name} x ${ev.id}: ${error instanceof Error ? error.message : String(error)} (${elapsed}s)`
        );
      }
    };
    if (ev.mode !== 'local-stack') return run();
    localStackTurn = localStackTurn.then(run);
    await localStackTurn;
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
