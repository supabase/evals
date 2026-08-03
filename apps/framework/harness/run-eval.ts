#!/usr/bin/env tsx
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ModelMessage } from 'ai';
import { parseEvalMarkdown } from '@supabase-evals/core/eval-markdown';
import { createBareSandbox } from '@supabase-evals/sandbox';
import {
  normalizeExperimentName,
  readExperimentSuiteFilters,
  readRepeatedFlag,
  readSuiteFilters,
} from '../lib/cli-args.js';
import {
  buildLoadSkillTool,
  buildSystemPrompt,
  buildToolsSkillsPrompt,
  loadToolsSkills,
  resolveSkillSources,
} from '../lib/tools-skills.js';
import { bootPlatformBackend } from './platform-backend.js';
import { viteBuild, vitestRun } from './project-runner.js';
import {
  buildDocsResult,
  buildSkillResult,
  rehydrateTruncatedDocsResults,
  getExperimentDisplayMetadata,
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
const RUNS = Number(readFlag('runs') ?? 1);
const TIMEOUT_SEC = Number(readFlag('timeout-sec') ?? 720);
const CONCURRENCY = Number(readFlag('concurrency') ?? 1);
const STOP_ON_PASS = !args.has('--run-all-attempts');
const DEBUG = args.has('--debug');

// ── Noisy context (trigger suite) ──────────────────────────────────────────
// `--noisy-context[=name]` injects a simulated prior conversation before the
// user prompt so trigger-quality is measured against a half-full, noisy
// context window. With a name, that specific distractor template is used; bare
// `--noisy-context` draws a random one. Templates live in
// evals/trigger/contexts.ts — the only consumer for now; generalize if a
// second suite needs noisy context. Resolved lazily in main() via dynamic
// import so the harness stays decoupled from any one eval suite at load time.
type NoisyContext = {
  name: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
};
let NOISY_CONTEXT: NoisyContext | null = null;

function parseNoisyContextFlag(): string | null {
  const inline = rawArgs.find((a) => a.startsWith('--noisy-context='));
  if (inline) {
    const v = inline.slice('--noisy-context='.length);
    return v === '' ? '' : v; // '' = random
  }
  if (args.has('--noisy-context')) {
    const idx = rawArgs.indexOf('--noisy-context');
    const next = rawArgs[idx + 1];
    return next && !next.startsWith('--') ? next : '';
  }
  return null; // not set
}

const NOISY_CONTEXT_NAME = parseNoisyContextFlag();

/** Context messages → ai-sdk ModelMessage turns (user/assistant, string content). */
function toModelMessages(messages: NoisyContext['messages']): ModelMessage[] {
  return messages.map((m) =>
    m.role === 'assistant'
      ? { role: 'assistant', content: m.content }
      : { role: 'user', content: m.content }
  );
}

/** Context messages → a single text block for one-shot (CLI) agents. */
function formatContextAsText(ctx: NoisyContext): string {
  const header =
    'Prior conversation (context only — do not act on it; answer the request that follows):';
  const body = ctx.messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');
  return `${header}\n${body}`;
}

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

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = rawArgs.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const idx = rawArgs.indexOf(`--${name}`);
  if (idx !== -1) {
    const value = rawArgs[idx + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`--${name} requires a value`);
    }
    return value;
  }
  return undefined;
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
    // Skip dirs that aren't evals (e.g. evals/trigger/ holds the trigger
    // suite's prompts.ts/golden.ts/contexts.ts data, with no PROMPT.md).
    if (!existsSync(promptPath)) continue;
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

function resultPath(modelName: string, ev: Pick<EvalManifest, 'id' | 'mode'>) {
  return join(ROOT, 'results', modelName, `${ev.id}.json`);
}

function workspacePath(modelName: string, evalId: string, attempt: number) {
  return join(
    ROOT,
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
  ev: EvalManifest
): Promise<
  ScoreResult & {
    attempts: number;
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
  // Noisy-context (trigger suite): CLI/sandbox agents are one-shot, so the
  // distractor conversation is prepended as a text block into the prompt.
  // In-process (ai-sdk) agents instead receive it as `priorMessages` (true
  // multi-turn) — wired in the tools path below.
  const noisyUserPrompt = NOISY_CONTEXT
    ? `${formatContextAsText(NOISY_CONTEXT)}\n\n---\n\n${prompt}`
    : prompt;
  // A CLI agent always runs in a sandbox and reads skills from disk with its
  // file tools (both modes). An in-process (ai-sdk) agent has no sandbox, so in
  // tools mode its skills are advertised in the prompt and loaded via the
  // load_skill tool. Skill sources (name+dir) are shared by both paths.
  const agentRunsInSandbox = exp.agent.runsInSandbox ?? false;
  const skillSources = resolveSkillSources(ROOT, exp.skills);
  const availableSkills = skillSources.map((skill) => skill.name);
  const toolsSkills =
    ev.mode === 'tools' && !agentRunsInSandbox
      ? loadToolsSkills(ROOT, exp.skills)
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
          // Skills are installed into the sandbox and discovered by the agent
          // (the session folds the discovery listing into its promptAddendum),
          // so no skill text is injected into the prompt here.
          skills: skillSources,
        })
      );

      const run = await exp.agent.run({
        systemPrompt: buildSystemPrompt('local-stack', session.promptAddendum),
        userPrompt: noisyUserPrompt,
        tools: session.tools,
        sandbox: session.sandbox,
        mcpServers: session.mcpServers,
        timeoutSec: TIMEOUT_SEC,
      });
      // Must run before session disposes below, see rehydrateTruncatedDocsResults.
      await rehydrateTruncatedDocsResults(session.sandbox, run.toolCalls);

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
      ? disposable(await createBareSandbox({ skills: skillSources }))
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
      userPrompt: agentRunsInSandbox ? noisyUserPrompt : prompt,
      // In-process (ai-sdk) agents get the distractor conversation as real
      // prior turns; sandbox (CLI) agents get it folded into userPrompt above.
      priorMessages: agentRunsInSandbox
        ? undefined
        : NOISY_CONTEXT
          ? toModelMessages(NOISY_CONTEXT.messages)
          : undefined,
      tools: agentRunsInSandbox ? undefined : buildLoadSkillTool(toolsSkills),
      mcpServers: session.mcpServers,
      sandbox: cliSandbox?.sandbox,
      timeoutSec: TIMEOUT_SEC,
    });
    // Must run before cliSandbox disposes below, see rehydrateTruncatedDocsResults.
    if (cliSandbox)
      await rehydrateTruncatedDocsResults(cliSandbox.sandbox, run.toolCalls);

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

async function main() {
  if (rawArgs.filter((a) => a !== '--')[0] === 'list') {
    const experiments = await loadExperiments();
    const filtered =
      EXPERIMENT_SUITE_FILTERS.length > 0
        ? experiments.filter(
            (e) =>
              e.config.suite !== undefined &&
              e.config.suite.some((suite) =>
                EXPERIMENT_SUITE_FILTERS.includes(suite)
              )
          )
        : experiments;
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

  // Resolve the noisy-context template (trigger suite) if requested. Done
  // here, once, via dynamic import so the harness stays decoupled from any
  // single eval suite's data at module load.
  if (NOISY_CONTEXT_NAME !== null) {
    const { contexts, pickContext } = await import(
      pathToFileURL(join(ROOT, 'evals', 'trigger', 'contexts.ts')).href
    );
    const ctx = pickContext(NOISY_CONTEXT_NAME || undefined);
    NOISY_CONTEXT = ctx;
    console.log(`noisy-context: ${ctx.name}`);
    // Touch `contexts` so the import isn't elided/tree-shaken in some bundlers.
    void contexts;
  }

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
      } catch (e) {
        stderr(`SKIP ${name} (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
    }

    for (const ev of suiteFiltered) {
      const out = resultPath(name, ev);
      if (!FORCE && existsSync(out)) {
        console.log(`SKIP ${name} x ${ev.id} (already ran)`);
        continue;
      }
      if (ev.mode === 'local-stack' && !config.localStack) {
        console.log(
          `SKIP ${name} x ${ev.id} (no local stack runtime — add \`localStack: localStackRuntime()\` from "@supabase-evals/sandbox" to experiments/${name}.ts)`
        );
        continue;
      }
      if (DRY) {
        console.log(formatPlanLine(name, config, ev));
        continue;
      }
      allWork.push({ name, config, ev });
    }
  }

  let localStackTurn = Promise.resolve();
  const errored: Error[] = [];

  const runWork = async ({ name, config, ev }: (typeof allWork)[number]) => {
    const out = resultPath(name, ev);
    const start = Date.now();
    console.log(`⏳ RUN  ${name} x ${ev.id}`);
    const run = async () => {
      try {
        const res = await runOne(name, config, ev);
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
          `${res.passed ? '✅ PASS' : '❌ FAIL'} ${name} x ${ev.id} (${formatRunSummary(res)}, ${elapsed}s)\n   → ${relative(ROOT, out)}`
        );
      } catch (e) {
        errored.push(new Error(`${name} x ${ev.id}`, { cause: e }));
        const elapsed = Math.round((Date.now() - start) / 1000);
        stderr(
          `💥 ERR  ${name} x ${ev.id}: ${e instanceof Error ? e.message : String(e)} (${elapsed}s)`
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
