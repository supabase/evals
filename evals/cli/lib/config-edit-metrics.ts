import type { CheckResult } from '@supabase-evals/core';
import {
  type CommandEntry,
  invocationSubcommand,
  invocationVerb,
  type SupabaseInvocation,
} from './cli-invocations.js';
import type { ConfigFormat } from './config-edit-checks.js';

export type ConfigEditCounts = {
  validateRuns: number;
  validateInvalid: number;
  validateUnavailable: number;
  otherConfigRuns: number;
  otherConfigFailures: number;
};

const NO_CONFIG_VERBS = new Set([
  'init',
  'login',
  'logout',
  'projects',
  'orgs',
  'completion',
  'help',
  'bootstrap',
  'snippets',
  'sso',
]);

export type ConfigEditEntry = CommandEntry & { output?: string };

const INVALID_REPORT_RE =
  /"valid"\s*:\s*false|✗\s*\d+\s+errors?\b|\bhas \d+ problems?/i;
const UNAVAILABLE_RE = /UnknownSubcommand|unknown command|"_tag"\s*:\s*"Help"/i;

/** Validate runs are classified by their own report (once per tool call, as its output cannot be split per invocation), since agents often chain validate with edits whose failure marks the whole tool call failed; other config-loading commands count a failed tool call. */
export function countConfigEditInvocations(
  entries: readonly ConfigEditEntry[],
  invocations: readonly SupabaseInvocation[]
): ConfigEditCounts {
  const counts: ConfigEditCounts = {
    validateRuns: 0,
    validateInvalid: 0,
    validateUnavailable: 0,
    otherConfigRuns: 0,
    otherConfigFailures: 0,
  };
  const classified = new Set<number>();
  for (const invocation of invocations) {
    const verb = invocationVerb(invocation);
    if (verb === undefined || NO_CONFIG_VERBS.has(verb)) continue;
    const entry = entries[invocation.commandIndex];
    const isValidate =
      verb === 'config' && invocationSubcommand(invocation) === 'validate';
    if (isValidate) {
      const output = entry?.output ?? '';
      counts.validateRuns++;
      if (classified.has(invocation.commandIndex)) continue;
      classified.add(invocation.commandIndex);
      if (INVALID_REPORT_RE.test(output)) counts.validateInvalid++;
      else if (UNAVAILABLE_RE.test(output)) counts.validateUnavailable++;
    } else {
      counts.otherConfigRuns++;
      if (entry?.failed === true) counts.otherConfigFailures++;
    }
  }
  return counts;
}

const COMMENT_LINE: Record<ConfigFormat, RegExp> = {
  toml: /^#/,
  jsonc: /^(\/\/|\/\*|\*)/,
};

function commentLines(format: ConfigFormat, text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => COMMENT_LINE[format].test(line));
}

/** The share of the seed's comment lines that still appear in the final file, or null when either is unavailable. */
export function commentSurvival(
  format: ConfigFormat,
  seedText: string,
  finalText: string | undefined
): number | null {
  if (finalText === undefined) return null;
  const seedLines = commentLines(format, seedText);
  if (seedLines.length === 0) return null;
  const remaining = new Map<string, number>();
  for (const line of commentLines(format, finalText)) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  let kept = 0;
  for (const line of seedLines) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) {
      kept++;
      remaining.set(line, left - 1);
    }
  }
  return Math.round((kept / seedLines.length) * 100) / 100;
}

/** Diagnostics only: the check always passes. */
export function checkConfigEditMetrics(facts: {
  format: ConfigFormat;
  validateConvention: boolean;
  counts: ConfigEditCounts;
  commentsKept: number | null;
  cli: Record<string, string | null | undefined>;
}): CheckResult {
  const { format, validateConvention, counts, commentsKept, cli } = facts;
  return {
    name: 'metrics',
    passed: true,
    notes: JSON.stringify({
      format,
      validateConvention,
      ...counts,
      ranValidate: counts.validateRuns > 0,
      commentsKept,
      ...cli,
    }),
  };
}
