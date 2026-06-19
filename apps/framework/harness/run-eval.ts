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
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEvalMarkdown } from "@supabase-evals/core/eval-markdown";
import {
  normalizeExperimentName,
  readRepeatedFlag,
  readSuiteFilters,
} from "../lib/cli-args.js";
import { bootPlatformBackend } from "./platform-backend.js";
import { viteBuild, vitestRun } from "./project-runner.js";
import type {
  ExperimentConfig,
  EvalInterface,
  EvalManifest,
  EvalMode,
  ToolScorer,
  LocalStackScorer,
  ScoreResult,
  TranscriptPart,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

// Fixed identifiers for the mocked hosted project a local-stack eval links to.
// Both must satisfy the CLI's format checks: ref is `^[a-z]{20}$`, token is
// `^sbp_[a-f0-9]{40}$`. platform-lite accepts whatever token it's booted with.
const HOSTED_PROJECT_REF = "evalshostedprojectxy";
const HOSTED_ACCESS_TOKEN = "sbp_" + "0".repeat(40);

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const FORCE = args.has("--force");
const SMOKE = args.has("--smoke");
const DRY = args.has("--dry");
const EXPERIMENT_FILTERS = readRepeatedFlag(rawArgs, "experiment").map(
  normalizeExperimentName,
);
const MODEL_FILTER = readFlag("model");
const EVAL_FILTERS = readRepeatedFlag(rawArgs, "eval");
const SUITE_FILTERS = readSuiteFilters(rawArgs);
const RUNS = Number(readFlag("runs") ?? 4);
const TIMEOUT_SEC = Number(readFlag("timeout-sec") ?? 720);
const CONCURRENCY = Number(readFlag("concurrency") ?? 10);
const STOP_ON_PASS = !args.has("--run-all-attempts");
const DEBUG = args.has("--debug");

async function loadExperiments() {
  const dir = join(ROOT, "experiments");
  const out: Array<{ name: string; config: ExperimentConfig }> = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    out.push({
      name: f.replace(/\.ts$/, ""),
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
    if (!value || value.startsWith("--")) {
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
  hasLocal: boolean,
): EvalMode {
  if (interfaceKind === "cli" || hasLocal) return "local-stack";
  return "tools";
}

function discoverEvals(): EvalManifest[] {
  const dir = join(ROOT, "evals");
  if (!existsSync(dir)) return [];
  const out: EvalManifest[] = [];
  for (const id of readdirSync(dir)) {
    const evalDir = join(dir, id);
    if (!statSync(evalDir).isDirectory()) continue;
    const localDir = join(evalDir, "local");
    const promptPath = join(evalDir, "PROMPT.md");
    const evalPath = join(evalDir, "EVAL.ts");
    const metadata = parseEvalMarkdown(
      readFileSync(promptPath, "utf8"),
      `evals/${id}/PROMPT.md`,
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
      remoteDir: join(evalDir, "remote"),
    });
  }
  return out;
}

function loadSkills(skillNames: string[]): string {
  const blocks: string[] = [];
  for (const name of skillNames) {
    const p = join(ROOT, "skills", name, "SKILL.md");
    if (existsSync(p))
      blocks.push(`# Skill: ${name}\n\n${readFileSync(p, "utf8")}`);
    else
      blocks.push(
        `# Skill: ${name}\n\n(not found — ensure submodule is initialised: \`git submodule update --init\`)`,
      );
  }
  return blocks.join("\n\n---\n\n");
}

function resultPath(modelName: string, ev: Pick<EvalManifest, "id" | "mode">) {
  return join(ROOT, "results", modelName, `${ev.id}.json`);
}

function workspacePath(modelName: string, evalId: string, attempt: number) {
  return join(
    ROOT,
    "results",
    modelName,
    evalId,
    `attempt-${attempt}`,
    "workspace",
  );
}

function copyWithheldTests(ev: EvalManifest, workspace: string) {
  const testsDir = join(ev.dir, "tests");
  if (existsSync(testsDir)) {
    cpSync(testsDir, join(workspace, "tests"), { recursive: true });
  }
}

function readSessionSeedArgs(ev: EvalManifest) {
  const projectSeedSql = join(ev.remoteDir, "project.sql");
  const logsSeedJsonl = join(ev.remoteDir, "logs.jsonl");
  const functionsSeedDir = join(ev.remoteDir, "functions");

  return {
    projectSeedSql: existsSync(projectSeedSql) ? projectSeedSql : undefined,
    logsSeedJsonl: existsSync(logsSeedJsonl) ? logsSeedJsonl : undefined,
    functionsSeedDir: existsSync(functionsSeedDir) ? functionsSeedDir : undefined,
  };
}

function basePromptFor(mode: EvalMode): string {
  if (mode === "local-stack") {
    return (
      "You are an agent solving a Supabase eval task in a Linux workspace. " +
      "Use the provided tools to inspect and modify the workspace and run commands. " +
      "When you are done, end your turn with a short summary of what you did."
    );
  }
  return (
    "You are an agent solving a Supabase eval task. " +
    "Use the provided tools to inspect and modify the project. " +
    "When you are done, end your turn with a short summary of what you did " +
    "(or for audit tasks, your findings)."
  );
}

function buildSystemPrompt(
  mode: EvalMode,
  skillContext: string,
  addendum?: string,
): string {
  const blocks = [basePromptFor(mode), addendum, skillContext].filter(Boolean);
  return blocks.join("\n\n");
}

async function runOne(
  expName: string,
  exp: ExperimentConfig,
  ev: EvalManifest,
): Promise<
  ScoreResult & {
    attempts: number;
    toolCalls: unknown[];
    transcript: TranscriptPart[];
    agentReport: string;
    stoppedReason: string;
  }
> {
  const skillContext = loadSkills(exp.skills);
  const prompt = parseEvalMarkdown(
    readFileSync(ev.promptPath, "utf8"),
    ev.promptPath,
  ).body;
  const scorer = (await import(pathToFileURL(ev.evalPath).href)).default as
    | ToolScorer
    | LocalStackScorer;
  let last: ScoreResult = {
    passed: false,
    checks: [{ name: "ran at least one attempt", passed: false }],
  };
  let lastToolCalls: unknown[] = [];
  let lastTranscript: TranscriptPart[] = [];
  let lastAgentReport = "";
  let lastStoppedReason = "not_started";

  for (let attempt = 1; attempt <= RUNS; attempt += 1) {
    if (ev.mode === "local-stack") {
      // Local-stack mode: the experiment's local-stack tool surface provides
      // the sandbox session; one fresh session per attempt.
      if (!exp.localStack) {
        throw new Error(
          `eval ${ev.id} has interface: cli but experiment "${expName}" does not configure a local stack runtime. ` +
            `Add \`localStack: localStackRuntime()\` (from "@supabase-evals/sandbox") to experiments/${expName}.ts.`,
        );
      }
      // When the eval links to a hosted project, boot a platform-lite backend
      // (bound to 0.0.0.0 so the sandbox reaches it via host.docker.internal)
      // and hand the CLI-valid ref/token to the session.
      const hostedBackend = ev.metadata.hostedProject
        ? await bootPlatformBackend({
            ref: HOSTED_PROJECT_REF,
            accessToken: HOSTED_ACCESS_TOKEN,
            hostname: "0.0.0.0",
          })
        : undefined;
      const session = await exp.localStack.startSession({
        localDir: ev.localDir,
        includeServices: ev.metadata.services,
        projectRunning: ev.metadata.projectRunning,
        hosted: hostedBackend
          ? {
              port: Number(new URL(hostedBackend.url).port),
              ref: hostedBackend.ref,
              accessToken: hostedBackend.accessToken,
              mgmt: hostedBackend.mgmt,
              invokeFunction: hostedBackend.invokeFunction,
            }
          : undefined,
      });
      try {
        const run = await exp.agent.run({
          systemPrompt: buildSystemPrompt(
            "local-stack",
            skillContext,
            session.promptAddendum,
          ),
          userPrompt: prompt,
          tools: session.tools,
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

        if (STOP_ON_PASS && last.passed) {
          return {
            ...last,
            attempts: attempt,
            toolCalls: run.toolCalls,
            transcript: run.transcript,
            agentReport: run.agentReport,
            stoppedReason: run.stoppedReason,
          };
        }
      } finally {
        await session.close();
        await hostedBackend?.close();
      }
      continue;
    }

    // Tools mode: boot runtime, expose MCP tools, run agent, score result.
    const session = await exp.runtime.startSession(readSessionSeedArgs(ev));

    try {
      const systemPrompt = buildSystemPrompt(
        "tools",
        skillContext,
        session.promptAddendum,
      );
      const run = await exp.agent.run({
        systemPrompt,
        userPrompt: prompt,
        mcpServers: session.mcpServers,
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

      if (STOP_ON_PASS && last.passed) {
        return {
          ...last,
          attempts: attempt,
          toolCalls: run.toolCalls,
          transcript: run.transcript,
          agentReport: run.agentReport,
          stoppedReason: run.stoppedReason,
        };
      }
    } finally {
      await session.close();
    }
  }

  return {
    ...last,
    attempts: RUNS,
    toolCalls: lastToolCalls,
    transcript: lastTranscript,
    agentReport: lastAgentReport,
    stoppedReason: lastStoppedReason,
  };
}

function formatPlanLine(
  name: string,
  config: ExperimentConfig,
  ev: EvalManifest,
): string {
  const head = `PLAN ${name} x ${ev.id}  stage=${ev.stage} suite=${ev.suite}`;
  if (ev.mode === "local-stack") {
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

  return parts.join(", ");
}

async function runConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  });
  await Promise.all(workers);
}

async function main() {
  const allExperiments = await loadExperiments();
  if (EXPERIMENT_FILTERS.length > 0) {
    const experimentNames = new Set(allExperiments.map(({ name }) => name));
    const missing = EXPERIMENT_FILTERS.filter((name) => !experimentNames.has(name));
    if (missing.length > 0) {
      throw new Error(`no experiment matched: ${missing.join(",")}`);
    }
  }

  const experiments = allExperiments.filter(({ name, config }) => {
    if (
      EXPERIMENT_FILTERS.length > 0 &&
      !EXPERIMENT_FILTERS.includes(name)
    )
      return false;
    if (MODEL_FILTER && config.agent.modelId !== MODEL_FILTER) return false;
    return true;
  });
  if (EXPERIMENT_FILTERS.length > 0 || MODEL_FILTER) {
    const filter = [
      EXPERIMENT_FILTERS.length > 0
        ? `experiment=${EXPERIMENT_FILTERS.join(",")}`
        : undefined,
      MODEL_FILTER ? `model=${MODEL_FILTER}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    if (experiments.length === 0) {
      throw new Error(`no experiments matched ${filter}`);
    }
  }
  const evals = discoverEvals();
  if (EVAL_FILTERS.length > 0) {
    const evalIds = new Set(evals.map((e) => e.id));
    const missing = EVAL_FILTERS.filter((evalId) => !evalIds.has(evalId));
    if (missing.length > 0) {
      throw new Error(`no eval matched: ${missing.join(",")}`);
    }
  }

  const filtered = SMOKE
    ? Object.values(
        evals.reduce<Record<string, EvalManifest>>((acc, e) => {
          acc[e.stage] ??= e;
          return acc;
        }, {}),
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
      EVAL_FILTERS.length > 0 ? `eval=${EVAL_FILTERS.join(",")}` : undefined,
      SUITE_FILTERS.length > 0 ? `suite=${SUITE_FILTERS.join(",")}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    throw new Error(`no evals matched ${filter}`);
  }

  // Suppress noisy supabase-js logs from expected failures; --debug keeps them visible.
  const stderr = console.error;
  if (!DEBUG) console.error = () => undefined;

  console.log(
    `${experiments.length} experiment(s), ${suiteFiltered.length} eval(s), ` +
      `runs=${RUNS}, timeout=${TIMEOUT_SEC}s, concurrency=${CONCURRENCY}, ${STOP_ON_PASS ? "stop-on-pass" : "run-all-attempts"}`,
  );

  const allWork: Array<{ name: string; config: ExperimentConfig; ev: EvalManifest }> = [];

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
      if (ev.mode === "local-stack" && !config.localStack) {
        console.log(
          `SKIP ${name} x ${ev.id} (no local stack runtime — add \`localStack: localStackRuntime()\` from "@supabase-evals/sandbox" to experiments/${name}.ts)`,
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

  const runWork = async ({ name, config, ev }: (typeof allWork)[number]) => {
    const out = resultPath(name, ev);
    const start = Date.now();
    console.log(`⏳ RUN  ${name} x ${ev.id}`);
    const run = async () => {
      try {
        const res = await runOne(name, config, ev);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(
          out,
          JSON.stringify(
            { experiment: name, eval: ev.id, ...ev.metadata, ...res },
            null,
            2,
          ),
        );
        const elapsed = Math.round((Date.now() - start) / 1000);
        console.log(
          `${res.passed ? "✅ PASS" : "❌ FAIL"} ${name} x ${ev.id} (${formatRunSummary(res)}, ${elapsed}s)`,
        );
      } catch (e) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        stderr(`💥 ERR  ${name} x ${ev.id}: ${e instanceof Error ? e.message : String(e)} (${elapsed}s)`);
      }
    };
    if (ev.mode !== "local-stack") return run();
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
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
