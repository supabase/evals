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
import { bootMgmtApi } from "../shims/management-api.js";
import { assertCanRunExperiment, runAgent } from "./agent-driver.js";
import { buildFileTools } from "./file-tools.js";
import type {
  ExperimentConfig,
  EvalCategory,
  EvalManifest,
  Scorer,
  ScoreResult,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");
const SMOKE = args.has("--smoke");
const DRY = args.has("--dry");

async function loadExperiments() {
  const dir = join(ROOT, "experiments");
  const out: Array<{ name: string; config: ExperimentConfig }> = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    out.push({ name: f.replace(/\.ts$/, ""), config: mod.default as ExperimentConfig });
  }
  return out;
}

function readJsonIfExists<T>(p: string): T | undefined {
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : undefined;
}

function discoverEvals(): EvalManifest[] {
  const dir = join(ROOT, "evals");
  if (!existsSync(dir)) return [];
  const out: EvalManifest[] = [];
  for (const id of readdirSync(dir)) {
    const evalDir = join(dir, id);
    if (!statSync(evalDir).isDirectory()) continue;
    const appDir = join(evalDir, "app");
    const isProject =
      existsSync(join(appDir, "package.json")) && existsSync(join(appDir, "src"));
    const mode = isProject
      ? "project"
      : "tool";
    const [category, subcategory] = id.split("-");
    out.push({
      id,
      mode,
      category: category as EvalCategory,
      subcategory,
      dir: evalDir,
      appDir: isProject ? appDir : undefined,
      promptPath: join(evalDir, "PROMPT.md"),
      evalPath: join(evalDir, "EVAL.ts"),
      seedDir: join(evalDir, "seed"),
      skills: readJsonIfExists<string[]>(join(evalDir, "skills.json")) ?? [],
      tools: readJsonIfExists<any[]>(join(evalDir, "tools.json")) ?? [],
    });
  }
  return out;
}

function loadSkills(skillNames: string[]): string {
  const blocks: string[] = [];
  for (const name of skillNames) {
    const p = join(ROOT, "skills", name, "SKILL.md");
    if (existsSync(p)) blocks.push(`# Skill: ${name}\n\n${readFileSync(p, "utf8")}`);
    else blocks.push(`# Skill: ${name}\n\n(not installed — run \`npx skills add supabase/agent-skills\`)`);
  }
  return blocks.join("\n\n---\n\n");
}

function resultPath(modelName: string, ev: Pick<EvalManifest, "id" | "mode">) {
  return ev.mode === "project"
    ? join(ROOT, "results", modelName, ev.id, "summary.json")
    : join(ROOT, "results", modelName, `${ev.id}.json`);
}

function workspacePath(modelName: string, evalId: string, attempt: number) {
  return join(ROOT, "results", modelName, evalId, `attempt-${attempt}`, "workspace");
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
    ].join("\n")
  );
}

function copyWithheldTests(ev: EvalManifest, workspace: string) {
  const testsDir = join(ev.dir, "tests");
  if (existsSync(testsDir)) {
    cpSync(testsDir, join(workspace, "tests"), { recursive: true });
  }
}

async function runOne(
  expName: string,
  exp: ExperimentConfig,
  ev: EvalManifest
): Promise<ScoreResult & { attempts: number; toolCalls: unknown[] }> {
  const tools = ev.tools.length ? ev.tools : exp.defaultTools;
  const skills = ev.skills.length ? ev.skills : exp.defaultSkills;
  const skillContext = loadSkills(skills);
  const prompt = readFileSync(ev.promptPath, "utf8");
  const scorer = (await import(pathToFileURL(ev.evalPath).href)).default as Scorer;

  let last: ScoreResult = { passed: false, score: 0, notes: "no attempts" };
  let lastToolCalls: unknown[] = [];

  for (let attempt = 1; attempt <= exp.runs; attempt += 1) {
    if (ev.mode === "project") {
      const workspace = workspacePath(expName, ev.id, attempt);
      materializeWorkspace(ev, workspace);
      const projectToolCalls: any[] = [];
      const fileTools = buildFileTools(workspace, projectToolCalls);
      const systemPrompt =
        "You are an agent solving a Supabase frontend project eval task. " +
        "Use the provided file tools to inspect and modify the project files in the workspace. " +
        "Do not expect shell access. When you are done, end your turn with a short summary of what you changed.\n\n" +
        skillContext;

      const run = await runAgent({
        agent: exp.agent,
        provider: exp.provider,
        model: exp.model,
        providerOptions: exp.providerOptions,
        systemPrompt,
        userPrompt: prompt,
        tools: fileTools,
        toolCalls: projectToolCalls,
        timeoutSec: exp.timeoutSec,
      });

      copyWithheldTests(ev, workspace);
      lastToolCalls = run.toolCalls;
      last = await scorer({
        workspace,
        toolCalls: run.toolCalls,
        agentReport: run.agentReport,
      } as any);

      if (exp.earlyExit && last.passed) {
        return { ...last, attempts: attempt, toolCalls: run.toolCalls };
      }
      continue;
    }

    const projectSeedSql = join(ev.seedDir, "project.sql");
    const logsSeedNdjson = join(ev.seedDir, "logs.ndjson");
    const mgmt = await bootMgmtApi({
      projectSeedSql: existsSync(projectSeedSql) ? projectSeedSql : undefined,
      logsSeedNdjson: existsSync(logsSeedNdjson) ? logsSeedNdjson : undefined,
    });

    try {
      const systemPrompt =
        "You are an agent solving a Supabase eval task. " +
        "Use the provided tools to inspect and modify the project. " +
        "When you are done, end your turn with a short summary of what you did " +
        "(or for audit tasks, your findings).\n\n" +
        skillContext;

      const run = await runAgent({
        agent: exp.agent,
        provider: exp.provider,
        model: exp.model,
        providerOptions: exp.providerOptions,
        systemPrompt,
        userPrompt: prompt,
        mgmt,
        allowedTools: tools as any,
        timeoutSec: exp.timeoutSec,
      });

      lastToolCalls = run.toolCalls;
      last = await scorer({
        mgmt,
        client: mgmt.backends.projectDb.client,
        toolCalls: run.toolCalls,
        agentReport: run.agentReport,
      });

      if (exp.earlyExit && last.passed) {
        return { ...last, attempts: attempt, toolCalls: run.toolCalls };
      }
    } finally {
      await mgmt.close();
    }
  }
  return { ...last, attempts: exp.runs, toolCalls: lastToolCalls };
}

async function main() {
  const experiments = await loadExperiments();
  const evals = discoverEvals();
  console.log(`${experiments.length} experiment(s), ${evals.length} eval(s)`);

  const filtered = SMOKE
    ? Object.values(
        evals.reduce<Record<string, EvalManifest>>((acc, e) => {
          acc[e.category] ??= e;
          return acc;
        }, {})
      )
    : evals;

  for (const { name, config } of experiments) {
    if (!DRY) {
      try {
        assertCanRunExperiment(config);
      } catch (e) {
        console.error(`SKIP ${name} (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
    }
    for (const ev of filtered) {
      const out = resultPath(name, ev);
      if (!FORCE && existsSync(out)) {
        console.log(`SKIP ${name} x ${ev.id} (already ran)`);
        continue;
      }
      if (DRY) {
        console.log(
          ev.mode === "project"
            ? `PLAN ${name} x ${ev.id}  mode=project tools=files.*`
            : `PLAN ${name} x ${ev.id}  tools=${(ev.tools.length ? ev.tools : config.defaultTools).join(",")}`
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
            { experiment: name, eval: ev.id, ...res },
            null,
            2
          )
        );
        console.log(`  -> ${res.passed ? "PASS" : "FAIL"} (score ${res.score.toFixed(2)}, attempts ${res.attempts})`);
      } catch (e) {
        console.error(`  -> ERROR ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
