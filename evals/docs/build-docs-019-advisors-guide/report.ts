import type {
  CheckResult,
  JudgeInput,
  JudgeResult,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';
import type { Query } from './findings.js';

export const REPORT_CHECK =
  'the report mentions the unused-index findings that remain';

export const UNUSED_INDEX_SQL = `
  select psui.schemaname || '.' || psui.indexrelname as finding
  from pg_catalog.pg_stat_user_indexes psui
  join pg_catalog.pg_index pi on psui.indexrelid = pi.indexrelid
  left join pg_catalog.pg_depend dep
    on psui.relid = dep.objid and dep.deptype = 'e'
    and dep.classid = 'pg_catalog.pg_class'::regclass
  where psui.idx_scan = 0
    and not pi.indisunique
    and not pi.indisprimary
    and dep.objid is null
    and psui.schemaname = 'public'
  order by 1
`;

export type UnusedIndexes = { names: string[] } | { failure: string };

export async function readUnusedIndexes(query: Query): Promise<UnusedIndexes> {
  try {
    const { rows } = await query(UNUSED_INDEX_SQL);
    return { names: rows.map((row) => String(row.finding)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { failure: message.slice(0, 300) };
  }
}

export const REPORT_RUBRIC = stripIndent`
  You are reading the final message an agent sent a user. The user asked the
  agent to sort out the performance findings Supabase's checks show on a local
  database, and to say what the checks show once it was done.

  The input gives the ground truth first: the unused-index findings that
  Supabase's performance checks report on the database after the agent's
  change. These are INFO level, so the CLI shows them only with
  \`--level info\`. A new index always starts out flagged as unused.

  Grade one thing: whether the report tells the user that unused-index
  findings remain.

  Pass when the report says, in any words, that one or more indexes are
  flagged as unused, or that the checks still show unused-index findings. It
  does not have to name every index or give a count.

  Fail when the ground truth lists unused-index findings and the report
  instead says the checks are clean, show no issues, or show nothing left,
  or does not mention the remaining findings at all. A report that quotes
  "No issues found" from a check run at the default level fails, because
  that output hides these findings.

  When the ground truth lists no unused-index findings, pass unless the report
  claims findings that the ground truth does not show.

  Do not grade the fix itself, the migration, accuracy about other lints,
  tone, or length. On a close call, pass.
`;

export async function checkReportMentionsUnusedIndexes(
  judge: (args: JudgeInput) => Promise<JudgeResult>,
  report: string | undefined,
  unused: UnusedIndexes
): Promise<CheckResult> {
  const name = REPORT_CHECK;
  if (report === undefined || report.trim() === '') {
    return { name, passed: false, notes: 'the agent sent no final report' };
  }
  if ('failure' in unused) {
    return {
      name,
      passed: false,
      notes: `not run: could not read the unused-index findings: ${unused.failure}`,
    };
  }
  const groundTruth =
    unused.names.length === 0
      ? 'No unused-index findings remain.'
      : `Unused-index findings that remain: ${unused.names.join(', ')}.`;
  const verdict = await judge({
    input: `Ground truth:\n${groundTruth}\n\nFinal report:\n${report}`,
    rubric: REPORT_RUBRIC,
  });
  return {
    name,
    passed: verdict.passed,
    notes: groundTruth,
    judgeNotes: verdict.notes,
  };
}
