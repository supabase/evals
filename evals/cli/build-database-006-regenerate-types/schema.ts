import type {
  CheckResult,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import {
  invocationFlag,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { commandToolCalls } from '../lib/detours.js';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';
import {
  genTypesRunSucceeded,
  isGenTypes,
  OUTPUT_FAILURE,
  subcommand,
  type StackLifecycle,
} from './metrics.js';

export const NEW_MIGRATION_VERSION = '20260315000000';

export type SchemaProbe =
  | {
      ok: true;
      applied: boolean;
      columns: Record<string, string>;
      appliedError?: string;
    }
  | { ok: false; notes: string };

const COLUMNS_SQL =
  "select column_name, udt_name from information_schema.columns where table_schema = 'public' and table_name = 'tasks'";

const MISSING_HISTORY =
  /relation "supabase_migrations\.schema_migrations" does not exist/;
const APPLIED_SQL = `select count(*) from supabase_migrations.schema_migrations where version = '${NEW_MIGRATION_VERSION}'`;

/** `public.tasks` column names mapped to their Postgres type names, plus whether the new migration is in the applied history. */
export async function readTasksSchema(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stack: StackProbe
): Promise<SchemaProbe> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  const psql = (sql: string) =>
    `psql ${shellQuote(stack.dbUrl)} -tAc ${shellQuote(sql)}`;
  try {
    const columnsResult = await ctx.exec(psql(COLUMNS_SQL));
    if (!columnsResult.ok) {
      return {
        ok: false,
        notes: `columns query failed: ${describeFailure(columnsResult)}`,
      };
    }
    const columns: Record<string, string> = {};
    for (const line of columnsResult.stdout.split('\n')) {
      const [name, type] = line.trim().split('|');
      if (name && type) columns[name] = type;
    }
    const appliedResult = await ctx.exec(psql(APPLIED_SQL));
    const applied =
      appliedResult.ok && Number.parseInt(appliedResult.stdout.trim(), 10) > 0;
    // A missing history table fails this query, which means nothing was applied.
    const unexpectedFailure =
      !appliedResult.ok &&
      !MISSING_HISTORY.test(`${appliedResult.stderr}${appliedResult.stdout}`);
    return {
      ok: true,
      applied,
      columns,
      ...(unexpectedFailure
        ? { appliedError: describeFailure(appliedResult) }
        : {}),
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export type MigrationEvidence = {
  command: string;
  via: 'apply-output' | 'gen-types-db-url';
};

export type MigrationEvidenceSource =
  | 'probe'
  | 'tool-output'
  | 'gen-types-db-url'
  | 'none';

const APPLYING_LINE = new RegExp(
  `Applying migration ${NEW_MIGRATION_VERSION}_`,
  'g'
);
const LOCAL_APPLY_COMMANDS = new Set([
  'start',
  'db start',
  'db reset',
  'migration up',
  'stack start',
  'stack restart',
]);
const REMOTE_TARGET_FLAGS = ['--linked', '--db-url'];

function appliesMigrationsLocally(invocation: SupabaseInvocation): boolean {
  const verb = invocationVerb(invocation);
  const command =
    verb === 'db' || verb === 'migration'
      ? `${verb} ${subcommand(invocation)}`
      : verb;
  return (
    command !== undefined &&
    LOCAL_APPLY_COMMANDS.has(command) &&
    !invocation.argv.some((arg) =>
      REMOTE_TARGET_FLAGS.some(
        (flag) => arg === flag || arg.startsWith(`${flag}=`)
      )
    )
  );
}

function appliedWithoutError(output: string): boolean {
  const applied = [...output.matchAll(APPLYING_LINE)].at(-1);
  return (
    applied?.index !== undefined &&
    !OUTPUT_FAILURE.test(output.slice(applied.index))
  );
}

const DB_URL_HOST =
  /^[a-z][a-z\d+.-]*:\/\/(?:[^/?#]*@)?(\[[^\]]*\]|[^/?#:@]*)/i;
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;

function isLocalDbUrl(url: string): boolean {
  const host = DB_URL_HOST.exec(url)?.[1]
    ?.replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (host === undefined || /[$`]/.test(host)) return true;
  if (host.includes(':')) return host === '::1';
  return (
    !host.includes('.') ||
    host.endsWith('.localhost') ||
    LOOPBACK_IPV4.test(host) ||
    host === '0.0.0.0' ||
    host === 'host.docker.internal'
  );
}

/** The last local `supabase` invocation whose successful tool output shows the new migration applied and not followed by an error, else the last successful `gen types --db-url` run against a local or unreadable database. */
export function readMigrationEvidence(
  toolCalls: readonly ToolCallRecord[],
  invocations: readonly SupabaseInvocation[]
): MigrationEvidence | undefined {
  const calls = commandToolCalls(toolCalls);
  const last = (
    via: MigrationEvidence['via'],
    credits: (invocation: SupabaseInvocation, call?: ToolCallRecord) => boolean
  ): MigrationEvidence | undefined =>
    invocations
      .filter((invocation) =>
        credits(invocation, calls[invocation.commandIndex])
      )
      .map((invocation) => ({ command: invocation.argv.join(' '), via }))
      .at(-1);
  return (
    last(
      'apply-output',
      (invocation, call) =>
        appliesMigrationsLocally(invocation) &&
        call?.error === undefined &&
        typeof call?.result === 'string' &&
        appliedWithoutError(call.result)
    ) ??
    last('gen-types-db-url', (invocation, call) => {
      const url = invocationFlag(invocation, '--db-url');
      return (
        isGenTypes(invocation) &&
        url !== undefined &&
        isLocalDbUrl(url) &&
        genTypesRunSucceeded(call)
      );
    })
  );
}

export function migrationEvidenceSource(
  probe: SchemaProbe,
  evidence: MigrationEvidence | undefined
): MigrationEvidenceSource {
  if (probe.ok) return 'probe';
  if (evidence === undefined) return 'none';
  return evidence.via === 'gen-types-db-url'
    ? 'gen-types-db-url'
    : 'tool-output';
}

export function checkMigrationApplied(
  probe: SchemaProbe,
  lifecycle?: StackLifecycle,
  evidence?: MigrationEvidence
): CheckResult {
  const name = 'new migration is applied to the local database';
  if (!probe.ok && evidence !== undefined) {
    const reason = lifecycle?.stoppedByAgent
      ? `the agent stopped the stack, last stack command: \`${lifecycle.lastCommand}\``
      : probe.notes;
    return {
      name,
      passed: true,
      notes:
        evidence.via === 'gen-types-db-url'
          ? `credited to the successful \`${evidence.command}\`, which read a local database the harness cannot see; the harness could not probe the local stack (${reason})`
          : `applied per the output of \`${evidence.command}\`; the harness could not probe the database afterwards (${reason})`,
    };
  }
  if (!probe.ok) {
    return {
      name,
      passed: false,
      notes: lifecycle?.stoppedByAgent
        ? `the agent stopped the stack (last stack command: \`${lifecycle.lastCommand}\`), so the harness could not probe the database; ${probe.notes}`
        : probe.notes,
    };
  }
  const problems: string[] = [];
  if (!probe.applied) {
    problems.push(
      `${NEW_MIGRATION_VERSION} not in applied history${probe.appliedError === undefined ? '' : ` (history query failed: ${probe.appliedError})`}`
    );
  }
  if (probe.columns.status !== 'task_status') {
    problems.push(
      `status is ${probe.columns.status ?? 'missing'}, expected task_status`
    );
  }
  if (!('due_on' in probe.columns)) problems.push('due_on missing');
  if ('is_complete' in probe.columns)
    problems.push('is_complete still present');
  return {
    name,
    passed: problems.length === 0,
    notes:
      problems.length === 0
        ? `${NEW_MIGRATION_VERSION} applied; public.tasks has status and due_on and no is_complete`
        : problems.join('; '),
  };
}
