#!/usr/bin/env tsx
/**
 * Standalone skill-trigger tester — decoupled from the eval harness.
 *
 * Point it at one or more skills and a bulk prompt set; for each prompt it
 * runs a minimal in-process agent (system prompt + `load_skill` tool only, no
 * MCP/sandbox/localStack) and records which skills it chose to load. Useful
 * while iterating on a SKILL.md description: no eval dirs, no results/
 * bookkeeping, no golden data required for a new skill.
 *
 * Usage:
 *   pnpm test-skill-triggers -- --skill=supabase-postgres-best-practices
 *   pnpm test-skill-triggers -- --skill=my-new-skill --prompts=./my-prompts.json --category=schema --limit=20
 *
 * Flags:
 *   --skill=<name>[,<name>...]  required. Skills advertised to the agent
 *                                (skills/<name>/SKILL.md). Testing one skill in
 *                                isolation means the agent only ever sees that
 *                                one option — the realistic single-skill case.
 *   --prompts=<path>            JSON file: string[] or {text, category?}[].
 *                                Defaults to the built-in 97-prompt corpus
 *                                (evals/trigger/prompts.ts).
 *   --category=<cat>[,<cat>...] filter the built-in corpus by category.
 *   --limit=<n>                 cap the number of prompts run.
 *   --concurrency=<n>           default 5.
 *   --out=<path>                write full per-prompt JSON results here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { aiSdkAgent, buildSkillResult } from '@supabase-evals/core';
import {
  buildLoadSkillTool,
  buildSystemPrompt,
  buildToolsSkillsPrompt,
  loadToolsSkills,
} from '../lib/tools-skills.js';
import { readRepeatedFlag } from '../lib/cli-args.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const TIMEOUT_SEC = 120;

const rawArgs = process.argv.slice(2);

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = rawArgs.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = rawArgs.indexOf(`--${name}`);
  if (idx !== -1) {
    const value = rawArgs[idx + 1];
    if (value && !value.startsWith('--')) return value;
  }
  return undefined;
}

const SKILL_NAMES = readRepeatedFlag(rawArgs, 'skill');
if (SKILL_NAMES.length === 0) {
  console.error(
    'Usage: test-skill-triggers -- --skill=<name>[,<name>...] [--prompts=<path>] ...'
  );
  process.exit(1);
}
const CATEGORY_FILTER = readRepeatedFlag(rawArgs, 'category');
const LIMIT = Number(readFlag('limit') ?? Infinity);
const CONCURRENCY = Number(readFlag('concurrency') ?? 5);
const PROMPTS_PATH = readFlag('prompts');
const OUT_PATH = readFlag('out');

type TestPrompt = { text: string; category?: string };

async function loadPrompts(): Promise<TestPrompt[]> {
  if (PROMPTS_PATH) {
    const raw = JSON.parse(readFileSync(PROMPTS_PATH, 'utf8'));
    const list: unknown[] = Array.isArray(raw) ? raw : [];
    return list.map((entry) =>
      typeof entry === 'string' ? { text: entry } : (entry as TestPrompt)
    );
  }
  const { prompts } = await import('../../../evals/trigger/prompts.js');
  return prompts;
}

// ponytail: fast iterative testing while tuning a skill description, not
// scored final results — Haiku is far cheaper, so default to it either way,
// OpenRouter or direct Anthropic (OpenRouter has its own daily budget cap
// independent of the Anthropic key, so runs need to survive it being spent).
const model = process.env.OPENROUTER_API_KEY
  ? createOpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
    })('anthropic/claude-haiku-4.5')
  : anthropic('claude-haiku-4-5');

const agent = aiSdkAgent({
  model,
  providerOptions: { anthropic: { effort: 'max' } },
});

type PromptResult = {
  text: string;
  category?: string;
  loaded: string[];
  error?: string;
};

async function runOne(
  prompt: TestPrompt,
  skills: ReturnType<typeof loadToolsSkills>
): Promise<PromptResult> {
  try {
    const skillsPrompt = buildToolsSkillsPrompt(skills);
    const systemPrompt = buildSystemPrompt('tools', undefined, skillsPrompt);
    const run = await agent.run({
      systemPrompt,
      userPrompt: prompt.text,
      tools: buildLoadSkillTool(skills),
      timeoutSec: TIMEOUT_SEC,
    });
    const { loaded } = buildSkillResult(
      skills.map((s) => s.name),
      run.toolCalls
    );
    return { text: prompt.text, category: prompt.category, loaded };
  } catch (e) {
    return {
      text: prompt.text,
      category: prompt.category,
      loaded: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

async function main() {
  agent.assertReady();
  const skills = loadToolsSkills(ROOT, SKILL_NAMES);
  if (skills.length === 0) {
    console.error(`No skills found for: ${SKILL_NAMES.join(', ')}`);
    process.exit(1);
  }

  let prompts = await loadPrompts();
  if (CATEGORY_FILTER.length > 0) {
    prompts = prompts.filter(
      (p) => p.category && CATEGORY_FILTER.includes(p.category)
    );
  }
  if (Number.isFinite(LIMIT)) prompts = prompts.slice(0, LIMIT);

  console.log(
    `Testing ${skills.map((s) => s.name).join(', ')} against ${prompts.length} prompt(s)...\n`
  );

  let done = 0;
  const results = await mapWithConcurrency(
    prompts,
    CONCURRENCY,
    async (prompt) => {
      const result = await runOne(prompt, skills);
      done += 1;
      const status = result.error
        ? `ERROR: ${result.error.slice(0, 60)}`
        : result.loaded.length > 0
          ? result.loaded.join(', ')
          : '—';
      console.log(
        `[${done}/${prompts.length}] ${status.padEnd(40)} ${result.text.slice(0, 70)}`
      );
      return result;
    }
  );

  const ok = results.filter((r) => !r.error);
  const errored = results.length - ok.length;
  if (errored > 0) {
    console.log(
      `\n${errored} prompt(s) errored and are excluded from the rates below.`
    );
  }

  console.log('\n── Activation rate by skill ──');
  for (const skill of skills) {
    const fired = ok.filter((r) => r.loaded.includes(skill.name)).length;
    console.log(
      `  ${skill.name}: ${fired}/${ok.length} (${ok.length ? Math.round((100 * fired) / ok.length) : 0}%)`
    );
  }

  const categories = [...new Set(ok.map((r) => r.category).filter(Boolean))];
  if (categories.length > 0) {
    console.log('\n── Activation rate by category ──');
    for (const category of categories) {
      const inCategory = ok.filter((r) => r.category === category);
      const fired = inCategory.filter((r) => r.loaded.length > 0).length;
      console.log(`  ${category}: ${fired}/${inCategory.length}`);
    }
  }

  if (OUT_PATH) {
    writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
    console.log(`\nWrote ${results.length} result(s) to ${OUT_PATH}`);
  }
}

main();
