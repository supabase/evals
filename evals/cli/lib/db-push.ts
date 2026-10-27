import type { CheckResult, ToolCallRecord } from '@supabase-evals/core';
import {
  invocationSubcommand,
  invocationVerb,
  type SupabaseInvocation,
} from './cli-invocations.js';
import {
  booleanFlag,
  isExplicitlyLocal,
  toolCallFailed,
  toolCallFailureLine,
} from './db-target.js';
import { commandToolCalls, extractCommandEntries } from './detours.js';

export type DbPush = {
  /** The invocation's index among all supabase invocations, so it orders against other verbs. */
  order: number;
  dryRun: boolean;
  /** Only `--local` or a loopback `--db-url`/`--remote=<url>`: a bare `db push` targets the linked project on CLI 2.x but the local stack on next. */
  explicitlyLocal: boolean;
  yes: boolean;
  failed: boolean;
  /** The push's tool call printed that there was nothing to apply, so it changed nothing. */
  upToDate: boolean;
  failure?: string;
};

export const PUSH_CHECK_NAME = 'the agent pushed with supabase db push';

const UP_TO_DATE_RE = /\bis up to date\b|"upToDate"\s*:\s*true/i;

function pushedNothing(call: ToolCallRecord | undefined): boolean {
  return typeof call?.result === 'string' && UP_TO_DATE_RE.test(call.result);
}

export function readDbPushes(
  invocations: readonly SupabaseInvocation[],
  toolCalls: readonly ToolCallRecord[]
): DbPush[] {
  const entries = extractCommandEntries(toolCalls);
  const calls = commandToolCalls(toolCalls);
  const pushes: DbPush[] = [];
  invocations.forEach((inv, order) => {
    if (invocationVerb(inv) !== 'db' || invocationSubcommand(inv) !== 'push') {
      return;
    }
    const call = calls[inv.commandIndex];
    const command = entries[inv.commandIndex]?.command ?? '';
    const failed = toolCallFailed(call);
    const failure = failed ? toolCallFailureLine(call) : undefined;
    pushes.push({
      order,
      dryRun: booleanFlag(inv.argv, '--dry-run'),
      explicitlyLocal: isExplicitlyLocal(inv, command),
      yes: booleanFlag(inv.argv, '--yes'),
      failed,
      upToDate: pushedNothing(call),
      ...(failure === undefined ? {} : { failure }),
    });
  });
  return pushes;
}

/** A push that isn't a dry run and isn't explicitly local. */
export function isRealPush(push: DbPush): boolean {
  return !push.dryRun && !push.explicitlyLocal;
}

/** A push that isn't a dry run, isn't explicitly local, and neither failed nor found nothing to apply. */
export function isCreditedPush(push: DbPush): boolean {
  return isRealPush(push) && !push.failed && !push.upToDate;
}

export function describePushes(pushes: readonly DbPush[]): string {
  if (pushes.length === 0) return 'no supabase db push ran';
  const real = pushes.filter(isRealPush);
  const kinds = [
    ...(pushes.some((push) => push.dryRun) ? ['dry-run'] : []),
    ...(pushes.some((push) => !push.dryRun && push.explicitlyLocal)
      ? ['local']
      : []),
    ...(real.some((push) => !push.failed && push.upToDate)
      ? ['up-to-date']
      : []),
    ...(real.some((push) => push.failed) ? ['failed'] : []),
  ];
  const failure = real.find((push) => push.failure !== undefined)?.failure;
  return `only ${new Intl.ListFormat('en').format(kinds)} supabase db push ran${failure === undefined ? '' : `; first failure: "${failure}"`}`;
}

/** Passes for a credited push; a separate check scores whether it landed. */
export function checkPushed(pushes: readonly DbPush[]): CheckResult {
  const name = PUSH_CHECK_NAME;
  return pushes.some(isCreditedPush)
    ? { name, passed: true }
    : { name, passed: false, notes: describePushes(pushes) };
}
