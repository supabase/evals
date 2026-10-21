import type { CheckResult } from '@supabase-evals/core';
import { mentionsNumber } from '../lib/report.js';
import { urlPort } from '../lib/stack.js';
import type { WorktreeStacks } from './stacks.js';
import { WORKTREES } from './worktrees.js';

/** Passes when, for each worktree, its real database port or API port appears in the final message as a whole number. */
export function checkReportedPorts(
  stacks: WorktreeStacks,
  report: string
): CheckResult {
  const name = 'reported ports match the running stacks';
  if (report.trim() === '') {
    return { name, passed: false, notes: 'the final message is empty' };
  }
  const results = WORKTREES.map((worktree) => {
    const stack = stacks[worktree];
    if (!stack.ok) return { worktree, problem: 'stack did not resolve' };
    const db = urlPort(stack.dbUrl);
    const api = stack.apiUrl === undefined ? undefined : urlPort(stack.apiUrl);
    if (db === undefined && api === undefined) {
      return {
        worktree,
        problem: 'could not parse a port from its stack URLs',
      };
    }
    const dbMentioned = db !== undefined && mentionsNumber(report, db);
    const apiMentioned = api !== undefined && mentionsNumber(report, api);
    return { worktree, db, api, dbMentioned, apiMentioned };
  });
  const describe = (port: number | undefined, mentioned: boolean) =>
    port === undefined
      ? 'n/a'
      : `${port} ${mentioned ? 'reported' : 'not reported'}`;
  return {
    name,
    passed: results.every(
      (r) => 'problem' in r === false && (r.dbMentioned || r.apiMentioned)
    ),
    notes: results
      .map((r) =>
        'problem' in r
          ? `${r.worktree}: ${r.problem}`
          : `${r.worktree} db port ${describe(r.db, r.dbMentioned)}, api port ${describe(r.api, r.apiMentioned)}`
      )
      .join('; '),
  };
}
