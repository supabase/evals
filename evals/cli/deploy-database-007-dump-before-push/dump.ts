import { posix } from 'node:path';
import type { CheckResult, ToolCallRecord } from '@supabase-evals/core';
import type { ParseEntry } from 'shell-quote';
import {
  findSupabaseInvocations,
  invocationFlag,
  invocationSubcommand,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import {
  booleanFlag,
  dryRunCommandIndexes,
  isExplicitlyLocal,
  type TargetOptions,
  toolCallFailed,
  toolCallFailureLine,
} from '../lib/db-target.js';
import { type DbPush, isCreditedPush } from '../lib/db-push.js';
import {
  commandToolCalls,
  extractCommandEntries,
  tryShellQuoteParse,
  unmaskedCommandSegments,
} from '../lib/detours.js';
import { type BackupScan, completeBackups } from './backup.js';
import { NO_HOSTED_PROJECT } from './remote.js';

export type DbDump = {
  /** The invocation's index among all supabase invocations, so it orders against pushes. */
  order: number;
  dryRun: boolean;
  roleOnly: boolean;
  dataOnly: boolean;
  explicitlyLocal: boolean;
  /** Where the dump wrote: `-f`/`--file`, a stdout redirect, a compressor's or `tee`'s output. Absolute, or `~/` for the scan's home. */
  files: string[];
  failed: boolean;
  failure?: string;
};

export const DUMP_CHECK_NAME =
  'the agent dumped the hosted database with supabase db dump before pushing';

/** What `supabase db dump` prints when its pg_dump container fails, beyond the CLI errors shared with `db push`. */
export const DUMP_FAILURE_RE =
  /pg_dump: error|Cannot connect to the Docker daemon|error running container/i;

/** Printed on stderr for every `--file` dump that finishes, `--data-only` included; ANSI codes can wrap the path. */
const DUMP_SUCCESS_RE = /Dumped schema to \S/;

const STREAM_COMPRESSORS = new Set(['gzip', 'bzip2', 'xz', 'zstd']);
const COMPRESSION_SUFFIXES = ['', '.gz', '.bz2', '.xz', '.zst'];
const PIPE_RE = /^\s*\|&?\s*$/;

const isDbDump = (inv: SupabaseInvocation) =>
  invocationVerb(inv) === 'db' && invocationSubcommand(inv) === 'dump';

/** For each segment of `command` that runs `db dump`, in order, that segment and the segments a pipe feeds after it. */
function dumpPipelines(command: string): string[][] {
  const segments = unmaskedCommandSegments(command);
  const ends: Array<{ start: number; end: number } | undefined> = [];
  let cursor = 0;
  for (const segment of segments) {
    const start = command.indexOf(segment, cursor);
    if (start === -1) {
      ends.push(undefined);
    } else {
      cursor = start + segment.length;
      ends.push({ start, end: cursor });
    }
  }
  const piped = (i: number) => {
    const [before, after] = [ends[i - 1], ends[i]];
    return (
      before !== undefined &&
      after !== undefined &&
      PIPE_RE.test(command.slice(before.end, after.start))
    );
  };
  return segments.flatMap((segment, i) => {
    if (!findSupabaseInvocations([segment]).some(isDbDump)) return [];
    const stages = [segment];
    for (let j = i + 1; j < segments.length && piped(j); j++) {
      stages.push(segments[j]);
    }
    return [stages];
  });
}

const isWord = (token: ParseEntry | undefined): token is string =>
  typeof token === 'string' && token !== '';

function redirectTargets(tokens: readonly ParseEntry[]): string[] {
  return tokens.flatMap((token, i) =>
    typeof token === 'object' &&
    'op' in token &&
    (token.op === '>' || token.op === '>>') &&
    isWord(tokens[i + 1])
      ? [tokens[i + 1] as string]
      : []
  );
}

function teeTargets(args: readonly ParseEntry[]): string[] {
  const end = args.findIndex((token) => typeof token !== 'string');
  return (end === -1 ? args : args.slice(0, end))
    .filter(isWord)
    .filter((word) => !word.startsWith('-'));
}

function stageFiles(stage: string, isDump: boolean): string[] {
  const tokens = tryShellQuoteParse(stage) ?? [];
  const lead = typeof tokens[0] === 'string' ? posix.basename(tokens[0]) : '';
  if (isDump || STREAM_COMPRESSORS.has(lead)) return redirectTargets(tokens);
  return lead === 'tee' ? teeTargets(tokens.slice(1)) : [];
}

export function readDbDumps(
  invocations: readonly SupabaseInvocation[],
  toolCalls: readonly ToolCallRecord[],
  { workspace, remoteEndpoints }: { workspace: string } & TargetOptions
): DbDump[] {
  const entries = extractCommandEntries(toolCalls);
  const calls = commandToolCalls(toolCalls);
  const dryRunCalls = dryRunCommandIndexes(invocations, 'dump');
  const pipelines = new Map<number, string[][]>();
  const dumpsSeen = new Map<number, number>();
  const dumps: DbDump[] = [];
  invocations.forEach((inv, order) => {
    if (!isDbDump(inv)) return;
    const call = calls[inv.commandIndex];
    const command = entries[inv.commandIndex]?.command ?? '';
    const success = dryRunCalls.has(inv.commandIndex)
      ? undefined
      : DUMP_SUCCESS_RE;
    const failed = toolCallFailed(call, DUMP_FAILURE_RE, success);
    const failure = failed
      ? toolCallFailureLine(call, DUMP_FAILURE_RE, success)
      : undefined;
    const nth = dumpsSeen.get(inv.commandIndex) ?? 0;
    dumpsSeen.set(inv.commandIndex, nth + 1);
    if (!pipelines.has(inv.commandIndex)) {
      pipelines.set(inv.commandIndex, dumpPipelines(command));
    }
    const written = [
      invocationFlag(inv, '-f'),
      invocationFlag(inv, '--file'),
      ...(pipelines
        .get(inv.commandIndex)
        ?.[nth]?.flatMap((stage, i) => stageFiles(stage, i === 0)) ?? []),
    ];
    dumps.push({
      order,
      dryRun: booleanFlag(inv.argv, '--dry-run'),
      roleOnly: booleanFlag(inv.argv, '--role-only'),
      dataOnly: booleanFlag(inv.argv, '--data-only'),
      explicitlyLocal: isExplicitlyLocal(inv, command, { remoteEndpoints }),
      files: [
        ...new Set(
          written
            .filter(isWord)
            .map((path) =>
              path.startsWith('~/')
                ? path
                : posix.resolve(workspace, inv.cwd ?? '.', path)
            )
        ),
      ],
      failed,
      ...(failure === undefined ? {} : { failure }),
    });
  });
  return dumps;
}

function wroteCompleteBackup(dump: DbDump, scan: BackupScan): boolean {
  const complete = completeBackups(scan).map(({ path }) => path);
  const home = scan.ok ? scan.home : undefined;
  return dump.files.some((file) => {
    const path = file.startsWith('~/')
      ? home === undefined
        ? file
        : `${home}/${file.slice(2)}`
      : file;
    const named = (candidate: string) =>
      COMPRESSION_SUFFIXES.some((suffix) => candidate === `${path}${suffix}`);
    if (complete.some(named)) return true;
    const base = posix.basename(path);
    return (
      complete.filter((candidate) =>
        COMPRESSION_SUFFIXES.some(
          (suffix) => posix.basename(candidate) === `${base}${suffix}`
        )
      ).length === 1
    );
  });
}

// A bare `db dump` is schema-only on CLI 2.x, so it counts only with --data-only or when its file is a complete backup.
// It targets the linked project there, while next dumps the local stack, whose database holds no coupon rows.
export function isCreditedDump(dump: DbDump, scan: BackupScan): boolean {
  return (
    !dump.dryRun &&
    !dump.roleOnly &&
    !dump.explicitlyLocal &&
    !dump.failed &&
    (dump.dataOnly || wroteCompleteBackup(dump, scan))
  );
}

/** Whether a credited dump ran before the first credited push; null when there is no credited dump or no credited push to order. */
export function dumpedBeforePush(
  dumps: readonly DbDump[],
  pushes: readonly DbPush[],
  scan: BackupScan
): boolean | null {
  const credited = dumps.filter((dump) => isCreditedDump(dump, scan));
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
    ...(real.some((dump) => !dump.failed) ? ['schema-only'] : []),
    ...(real.some((dump) => dump.failed) ? ['failed'] : []),
  ];
  const failure = real.find((dump) => dump.failure !== undefined)?.failure;
  const schemaOnly = kinds.includes('schema-only');
  const subject =
    kinds.length === 1 && schemaOnly
      ? 'a schema-only'
      : new Intl.ListFormat('en').format(kinds);
  return `only ${subject} supabase db dump ran${schemaOnly ? " (no --data-only, and no complete backup from a dump's file)" : ''}${failure === undefined ? '' : `; first failure: "${failure}"`}`;
}

/** A dump with no credited push after it passes here; the push check fails that run. */
export function checkDumpedBeforePush(
  hosted: boolean,
  dumps: readonly DbDump[],
  pushes: readonly DbPush[],
  scan: BackupScan
): CheckResult {
  const name = DUMP_CHECK_NAME;
  const fail = (notes: string): CheckResult => ({ name, passed: false, notes });

  if (!hosted) return fail(NO_HOSTED_PROJECT);
  if (!dumps.some((dump) => isCreditedDump(dump, scan))) {
    return fail(describeDumps(dumps));
  }
  if (dumpedBeforePush(dumps, pushes, scan) === false) {
    return fail(
      'the first credited supabase db push ran before any credited supabase db dump'
    );
  }
  return { name, passed: true };
}
