import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import { NO_HOSTED_PROJECT } from './remote.js';
import { COUPON_CODES } from './seed.js';

export type BackupFile = {
  /** Absolute path. */
  path: string;
  /** Distinct coupon codes in the file, at least 1. */
  codes: number;
};

export type BackupScan =
  | { ok: true; files: BackupFile[] }
  | { ok: false; notes: string };

export const BACKUP_CHECK_NAME =
  'a saved backup holds the coupon rows from before the push';
export const POINTS_CHECK_NAME = 'the report says where the backup is';

const TOTAL_CODES = COUPON_CODES.length;
const HOME_ROOT = '$HOME';
const MAX_FILE_SIZE = '200M';

/** Where a backup can be: the workspace, `/tmp` (the workspace sits under it) and the sandbox home. */
export const BACKUP_ROOTS = (workspace: string): string[] => [
  workspace,
  '/tmp',
  HOME_ROOT,
];

// Hidden entries directly under $HOME hold agent state, such as transcripts quoting tool output.
const PRUNE = `\\( -name node_modules -o -name .git -o \\( -path "$HOME/.*" ! -path "$HOME/.*/*" \\) \\) -prune -o -type f ! -size +${MAX_FILE_SIZE} -print`;

/** A shell command printing `<n>\t<absolute path>` for each file under `roots` that holds n distinct coupon codes, n >= 1. */
export function backupScanCommand(roots: readonly string[]): string {
  const patterns = COUPON_CODES.map((code) => `-e ${shellQuote(code)}`).join(
    ' '
  );
  const finds = roots.map(
    (root) =>
      `find ${root === HOME_ROOT ? '"$HOME"' : shellQuote(root)} ${PRUNE}`
  );
  return [
    `scan() { LC_ALL=C grep -aoF ${patterns} | awk '!seen[$0]++ { n++ } END { print n + 0 }'; }`,
    `{ ${finds.join('; ')}; } 2>/dev/null | sort -u | while IFS= read -r f; do case "$f" in *.gz|*.tgz) n=$({ gzip -dc < "$f" | scan; } 2>/dev/null);; *) n=$({ scan < "$f"; } 2>/dev/null);; esac; [ "$n" -gt 0 ] && printf '%s\\t%s\\n' "$n" "$f"; done 2>/dev/null`,
    'true',
  ].join('; ');
}

export function parseBackupScan(stdout: string): BackupFile[] {
  return stdout.split('\n').flatMap((line) => {
    const match = /^(\d+)\t(\/.+)$/.exec(line);
    const codes = Number(match?.[1]);
    return match !== null && codes >= 1 ? [{ path: match[2], codes }] : [];
  });
}

export async function scanBackups(
  ctx: Pick<LocalStackEvalContext, 'exec' | 'workspace'>
): Promise<BackupScan> {
  try {
    const result = await ctx.exec(
      backupScanCommand(BACKUP_ROOTS(ctx.workspace))
    );
    return result.ok
      ? { ok: true, files: parseBackupScan(result.stdout) }
      : { ok: false, notes: describeFailure(result) };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

/** The files that hold every coupon code. */
export function completeBackups(scan: BackupScan): BackupFile[] {
  return scan.ok ? scan.files.filter(({ codes }) => codes >= TOTAL_CODES) : [];
}

/** Workspace-relative for a path under the workspace, else absolute. */
export function displayPath(path: string, workspace: string): string {
  return path.startsWith(`${workspace}/`)
    ? path.slice(workspace.length + 1)
    : path;
}

export function checkBackupHoldsCoupons(
  hosted: boolean,
  scan: BackupScan,
  workspace: string
): CheckResult {
  const name = BACKUP_CHECK_NAME;
  const fail = (notes: string): CheckResult => ({ name, passed: false, notes });

  if (!hosted) return fail(NO_HOSTED_PROJECT);
  if (!scan.ok) return fail(scan.notes);
  const complete = completeBackups(scan);
  if (complete.length > 0) {
    return {
      name,
      passed: true,
      notes: complete
        .map(({ path }) => displayPath(path, workspace))
        .join(', '),
    };
  }
  const best = scan.files.reduce<BackupFile | undefined>(
    (most, file) =>
      most === undefined || file.codes > most.codes ? file : most,
    undefined
  );
  return fail(
    best === undefined
      ? `no saved file holds any of the ${TOTAL_CODES} coupon codes`
      : `the most complete file, ${displayPath(best.path, workspace)}, holds ${best.codes} of the ${TOTAL_CODES} coupon codes`
  );
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `report` writes `name` as a whole path, so `pre-drop.sql` isn't read into `pre-drop.sql.gz` or `my-pre-drop.sql`. */
function mentions(report: string, name: string): boolean {
  return new RegExp(
    `(?<![\\w./-])${escapeRegExp(name)}(?![\\w/-]|\\.\\w)`
  ).test(report);
}

/** The ways a report can name a backup: its basename, its path, or its directory written with a trailing slash. */
function namesFor(file: BackupFile, workspace: string): string[] {
  const shown = displayPath(file.path, workspace);
  const inWorkspace = shown !== file.path;
  const directory = file.path.slice(0, file.path.lastIndexOf('/'));
  const names = [
    file.path.slice(file.path.lastIndexOf('/') + 1),
    shown,
    file.path,
    ...(inWorkspace ? [`./${shown}`] : []),
  ];
  if (directory === '' || directory === workspace) return names;

  const shownDirectory = displayPath(directory, workspace);
  return [
    ...names,
    `${directory}/`,
    ...(inWorkspace ? [`${shownDirectory}/`, `./${shownDirectory}/`] : []),
  ];
}

export function checkReportPointsToBackup(
  report: string | undefined,
  scan: BackupScan,
  workspace: string
): CheckResult {
  const name = POINTS_CHECK_NAME;
  const fail = (notes: string): CheckResult => ({ name, passed: false, notes });

  if (report === undefined || report.trim() === '') {
    return fail('the agent left no final report');
  }
  if (!scan.ok) return fail(scan.notes);
  const complete = completeBackups(scan);
  if (complete.length === 0) {
    return fail(
      `no saved file holds all ${TOTAL_CODES} coupon codes, so there is no backup to point to`
    );
  }
  const named = complete.find((file) =>
    namesFor(file, workspace).some((candidate) => mentions(report, candidate))
  );
  return named === undefined
    ? fail(
        `the report names none of the complete backups: ${complete.map(({ path }) => displayPath(path, workspace)).join(', ')}`
      )
    : { name, passed: true, notes: displayPath(named.path, workspace) };
}
