#!/usr/bin/env tsx
/**
 * Skill-trigger correlation report.
 *
 * Reads trigger-suite result files (`results/<experiment>/<evalId>.json`) and
 * cross-tabulates `SkillResult.loaded` × `passed` per skill, answering the
 * question the raw pass-rate can't: does activating a skill actually *help*?
 *
 *   P(pass | loaded)      — pass rate when the skill fired
 *   P(pass | not loaded)  — pass rate when it didn't (the no-skills runs feed
 *                            this population: nothing loads, so every skill
 *                            counts as "not loaded" there)
 *   Δ = P(pass|loaded) − P(pass|not loaded)
 *
 * A positive Δ means the skill helps; a negative Δ means it hurts (bad advice
 * from a misfired skill is worse than none). Trigger quality (did it fire on
 * the right prompts?) is the suite's job; this report closes the *utility* gap
 * — activated vs helped — that evals never cross-tabulated before.
 *
 * Usage (run from apps/framework):
 *   node --import tsx/esm scripts/trigger-report.ts
 *   node --import tsx/esm scripts/trigger-report.ts \
 *     --results=trigger-claude-sonnet-5 \
 *     --no-skills=trigger-no-skills-claude-sonnet-5 \
 *     --diff=trigger-claude-sonnet-5-noisy
 *
 * `--diff=<dir>` adds a clean-vs-noisy comparison per skill (trigger-rate and
 * pass-rate shift under a noisy context window), flagging |Δ| ≥ 5pp with ⚠.
 *
 * Pure analytics over existing result files — no LLM, no sandbox, no DB.
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
const RESULTS_DIR = join(ROOT, 'results');

// ponytail: closed skill set inlined — canonical home is
// evals/trigger/golden.ts (TRIGGER_SKILLS).
const TRIGGER_SKILLS = [
  'supabase',
  'supabase-postgres-best-practices',
] as const;

type Run = {
  evalId: string;
  category: string;
  passed: boolean;
  loaded: Set<string>;
  available: Set<string>;
};

/** Pull the prompt category out of `investigate-trigger-<category>-<nn>`. */
function categoryFromEvalId(id: string): string | null {
  const m = id.match(/^investigate-trigger-(.+)-\d+$/);
  return m ? m[1]! : null;
}

/** Short column label for a skill (the `supabase-` prefix is redundant here). */
function shortSkill(s: string): string {
  return s === 'supabase' ? 'supabase' : s.replace('supabase-', '');
}

function resolveResultsArg(value: string): string {
  return isAbsolute(value) || value.startsWith('results/')
    ? value
    : join(RESULTS_DIR, value);
}

async function readResults(label: string): Promise<Run[]> {
  const dir = resolveResultsArg(label);
  if (!existsSync(dir)) {
    console.warn(`(no results at ${dir}; skipping)`);
    return [];
  }
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const runs: Run[] = [];
  for (const f of files) {
    const raw = JSON.parse(await readFile(join(dir, f), 'utf8')) as {
      eval?: string;
      passed?: boolean;
      skills?: { loaded?: string[]; available?: string[] };
    };
    const evalId = raw.eval;
    if (!evalId) continue;
    const category = categoryFromEvalId(evalId);
    if (!category) continue; // not a trigger-suite eval
    runs.push({
      evalId,
      category,
      passed: !!raw.passed,
      loaded: new Set(raw.skills?.loaded ?? []),
      available: new Set(raw.skills?.available ?? []),
    });
  }
  return runs;
}

type Cell = { passed: number; total: number };

function rate(cell: Cell): number {
  return cell.total === 0 ? NaN : (cell.passed / cell.total) * 100;
}

function pct(x: number): string {
  return Number.isNaN(x) ? '  —  ' : `${x.toFixed(1)}%`;
}

/** Cross-tab loaded × passed for one skill over a set of runs. */
function tabulate(
  skill: string,
  runs: Run[]
): {
  loaded: Cell;
  notLoaded: Cell;
  delta: number;
} {
  const loaded: Cell = { passed: 0, total: 0 };
  const notLoaded: Cell = { passed: 0, total: 0 };
  for (const r of runs) {
    const isLoaded = r.loaded.has(skill);
    // A no-skills run has the skill neither available nor loaded — it counts
    // as "not loaded" (the baseline population).
    const cell = isLoaded ? loaded : notLoaded;
    cell.total += 1;
    if (r.passed) cell.passed += 1;
  }
  return { loaded, notLoaded, delta: rate(loaded) - rate(notLoaded) };
}

function printCorrelationTable(runs: Run[]): void {
  console.log('\n=== Activated vs helped (per skill) ===');
  console.log(
    'skill                              P(pass|loaded)  P(pass|−load)   Δ      n+    n−'
  );
  for (const skill of TRIGGER_SKILLS) {
    const t = tabulate(skill, runs);
    console.log(
      `${skill.padEnd(34)}  ${pct(rate(t.loaded)).padStart(14)}  ${pct(rate(t.notLoaded)).padStart(14)}  ${Number.isNaN(t.delta) ? '  —  ' : (t.delta >= 0 ? '+' : '') + t.delta.toFixed(1).padStart(5)}pp  ${String(t.loaded.total).padStart(4)}  ${String(t.notLoaded.total).padStart(4)}`
    );
  }
}

function printCategoryBreakdown(runs: Run[]): void {
  const byCat = new Map<string, Run[]>();
  for (const r of runs) {
    const list = byCat.get(r.category) ?? [];
    list.push(r);
    byCat.set(r.category, list);
  }
  console.log('\n=== Per-category (trigger rate · pass rate · n) ===');
  console.log(
    'category          ' +
      TRIGGER_SKILLS.map((s) => shortSkill(s).padEnd(22)).join('  ')
  );
  for (const cat of [...byCat.keys()].sort()) {
    const catRuns = byCat.get(cat)!;
    const cells = TRIGGER_SKILLS.map((skill) => {
      const t = tabulate(skill, catRuns);
      const trigRate = (t.loaded.total / catRuns.length) * 100;
      const passRate = rate(t.loaded);
      // ponytail: NaN passRate (no loads in this category) shows as —
      return `${pct(trigRate).padStart(6)}·${pct(passRate).padStart(6)}·${String(catRuns.length).padStart(2)}`.padEnd(
        22
      );
    });
    console.log(`${cat.padEnd(18)} ${cells.join('  ')}`);
  }
}

function printDiff(clean: Run[], noisy: Run[]): void {
  console.log(
    '\n=== Clean vs noisy (trigger-rate Δ · pass-rate Δ per skill) ==='
  );
  console.log(
    'skill                              trig(clean→noisy)       pass(clean→noisy)'
  );
  for (const skill of TRIGGER_SKILLS) {
    const c = tabulate(skill, clean);
    const n = tabulate(skill, noisy);
    const trigC = (c.loaded.total / clean.length) * 100;
    const trigN = (n.loaded.total / noisy.length) * 100;
    const dTrig = trigN - trigC;
    const passC = rate(c.loaded);
    const passN = rate(n.loaded);
    const dPass = passN - passC;
    const warnTrig = Math.abs(dTrig) >= 5 ? ' ⚠' : '';
    const warnPass = Number.isNaN(dPass)
      ? ''
      : Math.abs(dPass) >= 5
        ? ' ⚠'
        : '';
    console.log(
      `${skill.padEnd(34)}  ${pct(trigC).padStart(7)}→${pct(trigN).padStart(7)}  ${fmtDelta(dTrig).padStart(7)}pp${warnTrig}   ${pct(passC).padStart(7)}→${pct(passN).padStart(7)}  ${Number.isNaN(dPass) ? '   —    ' : fmtDelta(dPass).padStart(7) + 'pp'}${warnPass}`
    );
  }
}

function fmtDelta(x: number): string {
  return (x >= 0 ? '+' : '') + x.toFixed(1);
}

async function main() {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const inline = args.find((a) => a.startsWith(`--${name}=`));
    if (inline) return inline.slice(`--${name}=`.length);
    const i = args.indexOf(`--${name}`);
    if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--'))
      return args[i + 1];
    return undefined;
  };

  const resultsLabel = get('results') ?? 'trigger-claude-sonnet-5';
  const noSkillsLabel = get('no-skills') ?? 'trigger-no-skills-claude-sonnet-5';
  const diffLabel = get('diff');

  const withSkills = await readResults(resultsLabel);
  const noSkills = await readResults(noSkillsLabel);
  const all = [...withSkills, ...noSkills];

  if (all.length === 0) {
    console.error(
      `no trigger results found (looked at ${resolveResultsArg(resultsLabel)} and ${resolveResultsArg(noSkillsLabel)}). ` +
        `Run the trigger suite first: pnpm eval -- --experiment=${resultsLabel} --suite=trigger`
    );
    process.exit(1);
  }

  console.log(
    `read ${withSkills.length} with-skills + ${noSkills.length} no-skills runs = ${all.length} total`
  );

  printCorrelationTable(all);
  printCategoryBreakdown(all);

  if (diffLabel) {
    const noisy = await readResults(diffLabel);
    if (noisy.length === 0) {
      console.error(`(--diff) no results at ${resolveResultsArg(diffLabel)}`);
      process.exit(1);
    }
    printDiff(withSkills, noisy);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
