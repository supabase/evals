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
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { jsonSchema, tool, type ToolSet } from "ai";
import { parseEvalMarkdown } from "@supabase-evals/core/eval-markdown";
import {
  createBareSandbox,
  frontmatterDescription,
  stripFrontmatter,
} from "@supabase-evals/sandbox";
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
const CONCURRENCY = Number(readFlag("concurrency") ?? 1);
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
    const p = join(ROOT, "skills", name, "SKILL.md");
    if (!existsSync(p)) {
      console.warn(
        `SKILL ${name} not found at skills/${name} — ensure the submodule is initialised (\`git submodule update --init\`); skipping`,
      );
      continue;
    }
    const md = readFileSync(p, "utf8");
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
  if (skills.length === 0) return "";
  return [
    "## Available skills",
    "",
    "The following agent skills are available. Only their names and descriptions are shown — " +
      "the full instructions are not loaded yet. When a task matches a skill, call the `load_skill` " +
      "tool with its name to load its full instructions.",
    "",
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join("\n");
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
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "The skill name to load (as listed under Available skills).",
            enum: skills.map((s) => s.name),
          },
        },
        required: ["name"],
      }),
      execute: async (input) => {
        const name = String((input as { name?: unknown })?.name ?? "");
        const entry = byName.get(name);
        if (!entry) {
          throw new Error(
            `unknown skill "${name}"; available: ${skills.map((s) => s.name).join(", ")}`,
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
  skillNames: string[],
): Array<{ name: string; dir: string }> {
  const sources: Array<{ name: string; dir: string }> = [];
  for (const name of skillNames) {
    const dir = join(ROOT, "skills", name);
    if (!existsSync(dir)) {
      console.warn(
        `SKILL ${name} not found at skills/${name} — ensure the submodule is initialised (\`git submodule update --init\`); skipping`,
      );
      continue;
    }
    sources.push({ name, dir: realpathSync(dir) });
  }
  return sources;
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
    pgvector: ev.metadata.product.includes("vectors"),
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
  addendum?: string,
  skillContext?: string,
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
  const prompt = parseEvalMarkdown(
    readFileSync(ev.promptPath, "utf8"),
    ev.promptPath,
  ).body;
  // A CLI agent always runs in a sandbox and reads skills from disk with its
  // file tools (both modes). An in-process (ai-sdk) agent has no sandbox, so in
  // tools mode its skills are advertised in the prompt and loaded via the
  // load_skill tool. Skill sources (name+dir) are shared by both paths.
  const agentRunsInSandbox = exp.agent.runsInSandbox ?? false;
  const skillSources = resolveSkillSources(exp.skills);
  const toolsSkills =
    ev.mode === "tools" && !agentRunsInSandbox ? loadToolsSkills(exp.skills) : [];
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
        // Skills are installed into the sandbox and discovered by the agent
        // (the session folds the discovery listing into its promptAddendum),
        // so no skill text is injected into the prompt here.
        skills: skillSources,
      });
      try {
        const run = await exp.agent.run({
          systemPrompt: buildSystemPrompt(
            "local-stack",
            session.promptAddendum,
          ),
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

    // Tools mode: the eval's tool surface is MCP (platform-lite). A CLI agent
    // gets the same sandbox as local-stack minus the running stack — with its
    // skills installed — and reaches the in-container MCP servers' host-side
    // platform-lite via host.docker.internal (so platform-lite binds 0.0.0.0).
    // An in-process agent runs host-side with no sandbox.
    const cliSandbox = agentRunsInSandbox
      ? await createBareSandbox({ skills: skillSources })
      : undefined;
    const session = await exp.runtime.startSession({
      ...readSessionSeedArgs(ev),
      hostname: agentRunsInSandbox ? "0.0.0.0" : undefined,
    });

    try {
      // CLI agents read their installed skills from disk (the bare sandbox folds
      // the discovery listing into its promptAddendum). In-process agents have
      // no filesystem, so their skills are advertised in the prompt and pulled
      // on demand via the load_skill tool.
      const skillsPrompt = agentRunsInSandbox
        ? cliSandbox!.promptAddendum
        : buildToolsSkillsPrompt(toolsSkills);
      const systemPrompt = buildSystemPrompt(
        "tools",
        session.promptAddendum,
        skillsPrompt,
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
      await cliSandbox?.close();
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
    let item: T | undefined;
    while ((item = queue.shift()) !== undefined) await fn(item);
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
