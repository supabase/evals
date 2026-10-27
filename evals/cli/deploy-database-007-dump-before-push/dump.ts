import type { CheckResult, ToolCallRecord } from '@supabase-evals/core';
import {
  invocationSubcommand,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import {
  booleanFlag,
  isExplicitlyLocal,
  toolCallFailed,
  toolCallFailureLine,
} from '../lib/db-target.js';
import { type DbPush, isCreditedPush } from '../lib/db-push.js';
import { commandToolCalls, extractCommandEntries } from '../lib/detours.js';
import { NO_HOSTED_PROJECT } from './remote.js';

export type DbDump = {
  /** The invocation's index among all supabase invocations, so it orders against pushes. */
  order: number;
  dryRun: boolean;
  roleOnly: boolean;
  dataOnly: boolean;
  explicitlyLocal: boolean;
  failed: boolean;
  failure?: string;
};

export const DUMP_CHECK_NAME =
  'the agent dumped the hosted database with supabase db dump before pushing';

/** What `supabase db dump` prints when its pg_dump container fails, beyond the CLI errors shared with `db push`. */
export const DUMP_FAILURE_RE =
  /pg_dump: error|Cannot connect to the Docker daemon|error running container/i;

export function readDbDumps(
  invocations: readonly SupabaseInvocation[],
  toolCalls: readonly ToolCallRecord[]
): DbDump[] {
  const entries = extractCommandEntries(toolCalls);
  const calls = commandToolCalls(toolCalls);
  const dumps: DbDump[] = [];
  invocations.forEach((inv, order) => {
    if (invocationVerb(inv) !== 'db' || invocationSubcommand(inv) !== 'dump') {
      return;
    }
    const call = calls[inv.commandIndex];
    const command = entries[inv.commandIndex]?.command ?? '';
    const failed = toolCallFailed(call, DUMP_FAILURE_RE);
    const failure = failed
      ? toolCallFailureLine(call, DUMP_FAILURE_RE)
      : undefined;
    dumps.push({
      order,
      dryRun: booleanFlag(inv.argv, '--dry-run'),
      roleOnly: booleanFlag(inv.argv, '--role-only'),
      dataOnly: booleanFlag(inv.argv, '--data-only'),
      explicitlyLocal: isExplicitlyLocal(inv, command),
      failed,
      ...(failure === undefined ? {} : { failure }),
    });
  });
  return dumps;
}

// A bare `db dump` is credited: CLI 2.x dumps the linked project, while next dumps the
// local stack, whose database holds no coupon rows, so the backup check fails that run.
export function isCreditedDump(dump: DbDump): boolean {
  return (
    !dump.dryRun && !dump.roleOnly && !dump.explicitlyLocal && !dump.failed
  );
}

/** Whether a credited dump ran before the first credited push; null when there is no credited dump or no credited push to order. */
export function dumpedBeforePush(
  dumps: readonly DbDump[],
  pushes: readonly DbPush[]
): boolean | null {
  const credited = dumps.filter(isCreditedDump);
  const firstPush = Math.min(
    ...pushes.filter(isCreditedPush).map((push) => push.order)
  );
  if (credited.length === 0 || firstPush === Infinity) return null;
  return credited.some((dump) => dump.order < firstPush);
}

function describeDumps(dumps: readonly DbDump[]): string {
  if (dumps.length === 0) return 'no supabase db dump ran';
  const real = dumps.filter(
    (dump) => !dump.dryRun && !dump.roleOnly && !dump.explicitlyLocal
  );
  const kinds = [
    ...(dumps.some((dump) => dump.dryRun) ? ['dry-run'] : []),
    ...(dumps.some((dump) => !dump.dryRun && dump.roleOnly)
      ? ['role-only']
      : []),
    ...(dumps.some((dump) => !dump.dryRun && dump.explicitlyLocal)
      ? ['local']
      : []),
    ...(real.some((dump) => dump.failed) ? ['failed'] : []),
  ];
  const failure = real.find((dump) => dump.failure !== undefined)?.failure;
  return `only ${new Intl.ListFormat('en').format(kinds)} supabase db dump ran${failure === undefined ? '' : `; first failure: "${failure}"`}`;
}

/** A dump with no credited push after it passes here; the push check fails that run. */
export function checkDumpedBeforePush(
  hosted: boolean,
  dumps: readonly DbDump[],
  pushes: readonly DbPush[]
): CheckResult {
  const name = DUMP_CHECK_NAME;
  const fail = (notes: string): CheckResult => ({ name, passed: false, notes });

  if (!hosted) return fail(NO_HOSTED_PROJECT);
  if (!dumps.some(isCreditedDump)) return fail(describeDumps(dumps));
  if (dumpedBeforePush(dumps, pushes) === false) {
    return fail(
      'the first credited supabase db push ran before any credited supabase db dump'
    );
  }
  return { name, passed: true };
}
