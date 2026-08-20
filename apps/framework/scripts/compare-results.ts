#!/usr/bin/env tsx
/**
 * CLI version delta report: compare two experiments' per-eval result files
 * (results/<experiment>/<eval>.json) and print a per-scenario verdict table —
 * IMPROVED (FAIL→PASS) / REGRESSED (PASS→FAIL) / no change, with the checks
 * score delta. The verdict semantics are ported from eval-workspace's
 * scripts/ab.sh printer.
 *
 * Output is markdown, pasteable into Slack or a Linear comment, and used by
 * the eval-refresh workflow as the nightly pin-vs-beta run summary. Purely
 * informational: the exit code does not reflect regressions (a human reviews
 * the delta and files CLI issues; see CLI-2221).
 *
 *   pnpm compare-results -- \
 *     --baseline results/claude-code-sonnet-5 \
 *     --candidate results/claude-code-sonnet-5-cli-beta \
 *     [--output delta.md]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rawEvalResultSchema } from '@supabase-evals/core/eval-metadata';
import { readFlag } from '../lib/cli-args.js';

/** The slice of a per-eval result file the delta report reads. */
export interface ArmResult {
  eval: string;
  passed: boolean;
  checksPassed: number;
  checksTotal: number;
  resolvedCliVersion?: string;
}

/** One experiment arm: its display name plus its per-eval results. */
export interface Arm {
  name: string;
  results: ArmResult[];
}

export type Verdict =
  | 'improved'
  | 'regressed'
  | 'unchanged'
  | 'baseline-only'
  | 'candidate-only';

export interface EvalDelta {
  eval: string;
  verdict: Verdict;
  baseline?: ArmResult;
  candidate?: ArmResult;
}

/**
 * Read an arm's per-eval result files from a results/<experiment> directory.
 * Only top-level *.json files are results (subdirectories hold exported
 * attempt workspaces). Files that fail to parse are skipped with a warning —
 * a malformed snapshot shouldn't take down the whole report.
 */
export function loadArm(dir: string): Arm {
  const results: ArmResult[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const parsed = rawEvalResultSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`skipping unparseable result ${join(dir, file)}`);
      continue;
    }
    const checks = parsed.data.checks ?? [];
    results.push({
      eval: parsed.data.eval,
      passed: parsed.data.passed === true,
      checksPassed: checks.filter((check) => check.passed).length,
      checksTotal: checks.length,
      resolvedCliVersion: parsed.data.resolvedCliVersion,
    });
  }
  return { name: basename(resolve(dir)), results };
}

/** Per-eval verdicts over the union of both arms' evals, sorted by eval id. */
export function compareArms(baseline: Arm, candidate: Arm): EvalDelta[] {
  const baselineByEval = new Map(baseline.results.map((r) => [r.eval, r]));
  const candidateByEval = new Map(candidate.results.map((r) => [r.eval, r]));
  const ids = [
    ...new Set([...baselineByEval.keys(), ...candidateByEval.keys()]),
  ].sort();

  return ids.map((id) => {
    const b = baselineByEval.get(id);
    const c = candidateByEval.get(id);
    if (!b) return { eval: id, verdict: 'candidate-only', candidate: c };
    if (!c) return { eval: id, verdict: 'baseline-only', baseline: b };
    const verdict: Verdict =
      !b.passed && c.passed
        ? 'improved'
        : b.passed && !c.passed
          ? 'regressed'
          : 'unchanged';
    return { eval: id, verdict, baseline: b, candidate: c };
  });
}

/**
 * The versions an arm actually ran, from the results' `resolvedCliVersion`
 * (the `supabase --version` probed inside the sandbox — never the requested
 * pin). Usually one value; joined when attempts genuinely mixed versions.
 */
export function armCliVersions(arm: Arm): string {
  const versions = [
    ...new Set(
      arm.results
        .map((r) => r.resolvedCliVersion)
        .filter((v): v is string => v !== undefined)
    ),
  ].sort();
  return versions.length > 0 ? versions.join(', ') : 'unknown CLI version';
}

function passCell(result: ArmResult | undefined): string {
  if (!result) return '—';
  return result.passed ? '✅ pass' : '❌ fail';
}

function checksCell(delta: EvalDelta): string {
  const score = (r: ArmResult | undefined) =>
    r ? `${r.checksPassed}/${r.checksTotal}` : '—';
  return `${score(delta.baseline)} → ${score(delta.candidate)}`;
}

const VERDICT_LABELS: Record<
  Exclude<Verdict, 'baseline-only' | 'candidate-only'>,
  string
> = {
  improved: '🟢 IMPROVED (FAIL→PASS)',
  regressed: '🔴 REGRESSED (PASS→FAIL)',
  unchanged: 'no change',
};

/**
 * Render the delta as a markdown report (table + ab.sh-style bottom line).
 * Evals present in only one arm don't get table rows — the nightly baseline
 * legitimately runs many evals the version arm deliberately skips (frontmatter
 * pins, non-CLI interfaces) — but they are listed in a footnote so a pair
 * that went missing (e.g. a timed-out sandbox) stays visible.
 */
export function renderMarkdown(
  baseline: Arm,
  candidate: Arm,
  deltas: EvalDelta[]
): string {
  const baselineLabel = `${baseline.name} (${armCliVersions(baseline)})`;
  const candidateLabel = `${candidate.name} (${armCliVersions(candidate)})`;
  const compared = deltas.filter(
    (
      d
    ): d is EvalDelta & {
      verdict: 'improved' | 'regressed' | 'unchanged';
    } => d.verdict !== 'baseline-only' && d.verdict !== 'candidate-only'
  );

  const lines = [
    `## CLI version delta: ${armCliVersions(baseline)} → ${armCliVersions(candidate)}`,
    '',
    `Baseline: \`${baselineLabel}\` · Candidate: \`${candidateLabel}\``,
    '',
  ];

  if (compared.length > 0) {
    lines.push(
      '| Eval | Baseline | Candidate | Checks | Verdict |',
      '| --- | --- | --- | --- | --- |',
      ...compared.map(
        (d) =>
          `| ${d.eval} | ${passCell(d.baseline)} | ${passCell(d.candidate)} | ${checksCell(d)} | ${VERDICT_LABELS[d.verdict]} |`
      ),
      ''
    );
  }

  const count = (verdict: Verdict) =>
    compared.filter((d) => d.verdict === verdict).length;
  const improved = count('improved');
  const regressed = count('regressed');
  const unchanged = count('unchanged');
  lines.push(
    `**${improved} improved, ${regressed} regressed, ${unchanged} unchanged.**`,
    ''
  );

  if (regressed > 0) {
    lines.push(
      `→ the candidate CLI REGRESSED ${regressed} scenario(s) (PASS→FAIL) — review the transcript(s) and file a supabase/cli issue for real regressions.`
    );
  } else if (improved > 0) {
    lines.push(
      `→ the candidate CLI IMPROVED ${improved} scenario(s) (FAIL→PASS).`
    );
  } else if (compared.length > 0) {
    lines.push('→ no pass/fail change (compare the checks column above).');
  } else {
    lines.push('→ no evals were run by both arms — nothing to compare.');
  }
  lines.push('');

  const oneSided = (verdict: Verdict, label: string) => {
    const ids = deltas.filter((d) => d.verdict === verdict).map((d) => d.eval);
    if (ids.length > 0) {
      lines.push(`${label}: ${ids.map((id) => `\`${id}\``).join(', ')}`, '');
    }
  };
  oneSided('baseline-only', 'Baseline only (skipped or missing in candidate)');
  oneSided('candidate-only', 'Candidate only (skipped or missing in baseline)');

  return lines.join('\n');
}

function requireResultsDir(flag: string, value: string | undefined): string {
  if (!value) throw new Error(`--${flag} <results-dir> is required`);
  if (!existsSync(value)) throw new Error(`--${flag} not found: ${value}`);
  return value;
}

function main() {
  const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--');
  const baselineDir = requireResultsDir(
    'baseline',
    readFlag(rawArgs, 'baseline')
  );
  const candidateDir = requireResultsDir(
    'candidate',
    readFlag(rawArgs, 'candidate')
  );
  const output = readFlag(rawArgs, 'output');

  const baseline = loadArm(baselineDir);
  const candidate = loadArm(candidateDir);
  if (baseline.results.length === 0 && candidate.results.length === 0) {
    throw new Error(
      `no per-eval result files found in ${baselineDir} or ${candidateDir}`
    );
  }

  const markdown = renderMarkdown(
    baseline,
    candidate,
    compareArms(baseline, candidate)
  );
  process.stdout.write(markdown);
  if (output) {
    writeFileSync(output, markdown);
    console.error(`\nwritten to ${output}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
