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
import { parseEvalMarkdown } from "@supabase-evals/core/eval-metadata";
import {
  normalizeExperimentName,
  readRepeatedFlag,
  readSuiteFilters,
} from "../lib/cli-args.js";
import { buildFileTools } from "./file-tools.js";
import { viteBuild, vitestRun } from "./project-runner.js";
import type {
  ExperimentConfig,
  EvalManifest,
  ToolScorer,
  ProjectScorer,
  ScoreResult,
  TranscriptPart,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

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
const STOP_ON_PASS = !args.has("--run-all-attempts");

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

function discoverEvals(): EvalManifest[] {
  const dir = join(ROOT, "evals");
  if (!existsSync(dir)) return [];
  const out: EvalManifest[] = [];
  for (const id of readdirSync(dir)) {
    const evalDir = join(dir, id);
    if (!statSync(evalDir).isDirectory()) continue;
    const appDir = join(evalDir, "app");
    const promptPath = join(evalDir, "PROMPT.md");
    const evalPath = join(evalDir, "EVAL.ts");
    const metadata = parseEvalMarkdown(
      readFileSync(promptPath, "utf8"),
      `evals/${id}/PROMPT.md`,
    ).metadata;
    const isProject =
      existsSync(join(appDir, "package.json")) &&
      existsSync(join(appDir, "src"));
    const mode = isProject ? "project" : "tool";
    out.push({
      id,
      mode,
      metadata,
      stage: metadata.stage,
      product: metadata.product,
      suite: metadata.suite,
      topic: metadata.topic,
      dir: evalDir,
      appDir: isProject ? appDir : undefined,
      promptPath,
      evalPath,
      seedDir: join(evalDir, "seed"),
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
  return ev.mode === "project"
    ? join(ROOT, "results", modelName, ev.id, "summary.json")
    : join(ROOT, "results", modelName, `${ev.id}.json`);
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

function materializeWorkspace(ev: EvalManifest, workspace: string) {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(dirname(workspace), { recursive: true });
  if (!ev.appDir) throw new Error(`project eval ${ev.id} is missing app/`);
  cpSync(ev.appDir, workspace, { recursive: true });
  writeFileSync(
    join(workspace, ".env.local"),
    [
      "VITE_SUPABASE_URL=http://supabase-evals.local",
      "VITE_SUPABASE_ANON_KEY=supabase-evals-anon-key",
      "",
    ].join("\n"),
  );
}

function copyWithheldTests(ev: EvalManifest, workspace: string) {
  const testsDir = join(ev.dir, "tests");
  if (existsSync(testsDir)) {
    cpSync(testsDir, join(workspace, "tests"), { recursive: true });
  }
}

function buildSystemPrompt(
  mode: "tool" | "project",
  skillContext: string,
  addendum?: string,
): string {
  const base =
    mode === "project"
      ? "You are an agent solving a Supabase frontend project eval task. " +
        "Use the provided file tools to inspect and modify the project files in the workspace. " +
        "Do not expect shell access. When you are done, end your turn with a short summary of what you changed."
      : "You are an agent solving a Supabase eval task. " +
        "Use the provided tools to inspect and modify the project. " +
        "When you are done, end your turn with a short summary of what you did " +
        "(or for audit tasks, your findings).";

  const blocks = [base, addendum, skillContext].filter(Boolean);
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
    | ProjectScorer
    | ToolScorer;
  let last: ScoreResult = {
    passed: false,
    checks: [{ name: "ran at least one attempt", passed: false }],
  };
  let lastToolCalls: unknown[] = [];
  let lastTranscript: TranscriptPart[] = [];
  let lastAgentReport = "";
  let lastStoppedReason = "not_started";

  for (let attempt = 1; attempt <= RUNS; attempt += 1) {
    if (ev.mode === "project") {
      const workspace = workspacePath(expName, ev.id, attempt);
      materializeWorkspace(ev, workspace);
      const fileTools = buildFileTools(workspace);
      const systemPrompt = buildSystemPrompt("project", skillContext);

      const run = await exp.agent.run({
        systemPrompt,
        userPrompt: prompt,
        tools: fileTools,
        timeoutSec: TIMEOUT_SEC,
      });

      copyWithheldTests(ev, workspace);
      const build = await viteBuild(workspace);
      const vitest = build.ok ? await vitestRun(workspace) : undefined;

      lastToolCalls = run.toolCalls;
      lastTranscript = run.transcript;
      lastAgentReport = run.agentReport;
      lastStoppedReason = run.stoppedReason;
      last = await (scorer as ProjectScorer)({
        workspace,
        projectResult: { build, vitest },
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
      continue;
    }

    // Tool mode: boot runtime, expose MCP tools, run agent, score result.
    const projectSeedSql = join(ev.seedDir, "project.sql");
    const logsSeedJsonl = join(ev.seedDir, "logs.jsonl");
    const functionsSeedDir = join(ev.seedDir, "functions");

    const session = await exp.runtime.startSession({
      projectSeedSql: existsSync(projectSeedSql) ? projectSeedSql : undefined,
      logsSeedJsonl: existsSync(logsSeedJsonl) ? logsSeedJsonl : undefined,
      functionsSeedDir: existsSync(functionsSeedDir) ? functionsSeedDir : undefined,
    });

    try {
      const systemPrompt = buildSystemPrompt(
        "tool",
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

function formatRunSummary(res: ScoreResult & { attempts: number }): string {
  const parts: string[] = [];
  if (res.checks?.length) {
    const passed = res.checks.filter((check) => check.passed).length;
    parts.push(`checks ${passed}/${res.checks.length}`);
  }
  parts.push(`attempts ${res.attempts}`);

  return parts.join(", ");
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

  console.log(
    `${experiments.length} experiment(s), ${suiteFiltered.length} eval(s), ` +
      `runs=${RUNS}, timeout=${TIMEOUT_SEC}s, ${STOP_ON_PASS ? "stop-on-pass" : "run-all-attempts"}`,
  );

  for (const { name, config } of experiments) {
    if (!DRY) {
      try {
        config.agent.assertReady();
      } catch (e) {
        console.error(
          `SKIP ${name} (${e instanceof Error ? e.message : String(e)})`,
        );
        continue;
      }
    }
    for (const ev of suiteFiltered) {
      const out = resultPath(name, ev);
      if (!FORCE && existsSync(out)) {
        console.log(`SKIP ${name} x ${ev.id} (already ran)`);
        continue;
      }
      if (DRY) {
        console.log(
          ev.mode === "project"
            ? `PLAN ${name} x ${ev.id}  stage=${ev.stage} suite=${ev.suite} mode=project tools=files.*`
            : `PLAN ${name} x ${ev.id}  stage=${ev.stage} suite=${ev.suite} runtime=${config.runtime.id} model=${config.agent.modelId}`,
        );
        continue;
      }
      console.log(`RUN  ${name} x ${ev.id}`);
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
        console.log(
          `  -> ${res.passed ? "PASS" : "FAIL"} (${formatRunSummary(res)})`,
        );
      } catch (e) {
        console.error(
          `  -> ERROR ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
