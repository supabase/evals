import { basename } from 'node:path';
import type { CheckResult, ToolCallRecord } from '@supabase-evals/core';
import {
  invocationPositionals,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { commandToolCalls, extractCommandEntries } from '../lib/detours.js';
import { ORDERS_TABLE } from './fixtures.js';

export type InspectRun = {
  commandIndex: number;
  report: string;
  errored: boolean;
};

/** A tool call whose output may show an inspect report: one that ran inspect, or a later one that names a path or report file such a call wrote. */
export type EvidenceCall = {
  commandIndex: number;
  kind: 'candidate' | 'later call naming an output path';
  command: string;
  output: string;
  namesOrders: boolean;
};

export const INSPECT_CHECK_NAME =
  'an inspect db report showed the orders table';

const ORDERS_RE = new RegExp(`\\b${ORDERS_TABLE}\\b`);
const HELP_FLAGS = new Set(['--help', '-h']);
const PATH_VALUE_FLAGS = new Set(['--db-url', '--output-dir']);
const CSI_SEQUENCE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const LOOSE_INSPECT_RE = /\bsupabase\b[\s\S]*\binspect\b/;
const REPORT_RE = /\binspect\s+report\b/;
const DATED_FOLDER_RE = /\b\d{4}-\d{2}-\d{2}\b/;
const REPORT_CSV_RE =
  /\b(?:bloat|blocking|calls|db_stats|index_stats|locks|long_running_queries|outliers|replication_slots|role_stats|table_stats|traffic_profile|unused_indexes|vacuum_stats)\.csv\b/;
const OUTPUT_DIR_RE = /--output-dir(?:=|\s+)(["']?)([^\s"'|;&<>()]*)\1/g;
const CWD_DIR_RE = /^\.\/?$/;
const CSV_GLOB_RE =
  /(?<![^\s"'=(])(?:\.\/)?\*{1,2}\/[^\s"'|;&<>()\/]*\.csv(?![\w.])/;
const CSV_FIND_RE =
  /\bfind(?:\s+\.\/?)?(?=\s+-)[^|;&]*?\s-i?name\s+(["']?)\*\.csv\1(?![\w.])/;
const OUTPUT_PATH_RE =
  /(?:(?<![->])&?>>?|\btee(?:\s+-\S+)*|(--output-dir[=\s]))\s*(?![&=])(["']?)([^\s"'|;&<>()]+)\2/g;

/** The report an executed `supabase inspect` invocation ran, such as `db outliers` or `report`; undefined for anything else, help included. */
export function inspectReport(inv: SupabaseInvocation): string | undefined {
  if (inv.argv.some((word) => HELP_FLAGS.has(word))) return undefined;
  const argv = inv.argv.filter(
    (_, i) => !PATH_VALUE_FLAGS.has(inv.argv[i - 1])
  );
  const [verb, first, second] = invocationPositionals({ ...inv, argv });
  if (verb !== 'inspect' || first === undefined) return undefined;
  if (first !== 'db') return first;
  return second === undefined ? undefined : `db ${second}`;
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === null || result === undefined) return '';
  return JSON.stringify(result, (_key, value: unknown) =>
    typeof value === 'string' ? value.replace(CSI_SEQUENCE, '') : value
  ).replace(/\\[nrt]/g, ' ');
}

/** A call's result and error together, since a command that exits non-zero keeps its output in `error`. */
const callText = ({ result, error }: ToolCallRecord): string =>
  `${resultText(result)}\n${error ?? ''}`.replace(CSI_SEQUENCE, '');

/** One run per executed `supabase inspect` report. */
export function findInspectRuns(
  toolCalls: readonly ToolCallRecord[],
  invocations: readonly SupabaseInvocation[]
): InspectRun[] {
  const calls = commandToolCalls(toolCalls);
  return invocations.flatMap((inv): InspectRun[] => {
    const report = inspectReport(inv);
    const call = calls[inv.commandIndex];
    if (report === undefined || call === undefined) return [];
    return [
      {
        commandIndex: inv.commandIndex,
        report,
        errored: call.error !== undefined,
      },
    ];
  });
}

const unescapeQuotes = (command: string): string =>
  command.replace(/\\(["\\])/g, '$1');

const isOutputPath = (path: string): boolean =>
  /\w/.test(path) && !/^\d+$/.test(path) && path !== '/dev/null';

const reportsIntoCwd = (command: string): boolean => {
  const text = unescapeQuotes(command);
  return (
    REPORT_RE.test(text) &&
    [...text.matchAll(OUTPUT_DIR_RE)].every(([, , dir]) => CWD_DIR_RE.test(dir))
  );
};

const readsCsvsFromCwd = (command: string): boolean =>
  CSV_GLOB_RE.test(command) || CSV_FIND_RE.test(command);

const sameDirectory = (a: string | undefined, b: string | undefined): boolean =>
  a === undefined || b === undefined || a === b;

/** What a later call would contain if it read a file the command wrote: the target, and for a redirect or relative path its name, since the reader may `cd` first. */
function outputPaths(command: string): string[] {
  return [...unescapeQuotes(command).matchAll(OUTPUT_PATH_RE)].flatMap(
    ([, outputDir, , target]) => {
      const path = target.replace(/^\.\//, '');
      if (!isOutputPath(path)) return [];
      return (
        outputDir && path.startsWith('/') ? [path] : [path, basename(path)]
      ).filter(isOutputPath);
    }
  );
}

/**
 * The calls whose output may show an inspect report, in call order: those that
 * ran inspect (parsed, or matched loosely in case parsing missed the shape) and
 * the later calls that mention a path one of them wrote or, after `inspect
 * report`, a dated folder or report file name, or a CSV glob from the
 * directory the report wrote into.
 */
export function findInspectEvidence(
  toolCalls: readonly ToolCallRecord[],
  runs: readonly InspectRun[]
): EvidenceCall[] {
  const calls = commandToolCalls(toolCalls);
  const entries = extractCommandEntries(toolCalls);
  const candidates = new Set(runs.map(({ commandIndex }) => commandIndex));
  entries.forEach(({ command }, i) => {
    if (LOOSE_INSPECT_RE.test(command)) candidates.add(i);
  });

  const written: string[] = [];
  let reported = false;
  const reportCwds: Array<string | undefined> = [];
  const evidence: EvidenceCall[] = [];
  entries.forEach(({ command, cwd }, commandIndex) => {
    const candidate = candidates.has(commandIndex);
    const body = unescapeQuotes(command);
    const text = `${cwd ?? ''} ${body}`;
    const read =
      written.some((path) => text.includes(path)) ||
      (reported && (DATED_FOLDER_RE.test(text) || REPORT_CSV_RE.test(text))) ||
      (reportCwds.some((reportCwd) => sameDirectory(reportCwd, cwd)) &&
        readsCsvsFromCwd(body));
    if (candidate) {
      written.push(...outputPaths(command));
      reported ||= REPORT_RE.test(command);
      if (reportsIntoCwd(command)) reportCwds.push(cwd);
    }
    if (!candidate && !read) return;
    const output = callText(calls[commandIndex]);
    evidence.push({
      commandIndex,
      kind: candidate ? 'candidate' : 'later call naming an output path',
      command,
      output,
      namesOrders: ORDERS_RE.test(output),
    });
  });
  return evidence;
}

const describeRun = ({ commandIndex, report, errored }: InspectRun) =>
  `tool call ${commandIndex + 1}: supabase inspect ${report}${errored ? ' (errored)' : ''}`;

/** The failing result when no judge is needed: no inspect call ran, or no evidence call's output names `orders`. */
export function gateInspectEvidence(
  runs: readonly InspectRun[],
  evidence: readonly EvidenceCall[]
): CheckResult | undefined {
  const name = INSPECT_CHECK_NAME;
  if (!evidence.some(({ kind }) => kind === 'candidate')) {
    return { name, passed: false, notes: 'no supabase inspect report ran' };
  }
  if (evidence.some(({ namesOrders }) => namesOrders)) return undefined;
  return {
    name,
    passed: false,
    notes: [
      ...runs.map(describeRun),
      `no inspect output named the ${ORDERS_TABLE} table`,
    ].join('; '),
  };
}

/** Every evidence call in full — command and recorded output — for the attribution judge. */
export const formatInspectJudgeInput = (
  evidence: readonly EvidenceCall[]
): string =>
  evidence
    .map(
      ({ commandIndex, kind, command, output }) =>
        `Tool call ${commandIndex + 1} (${kind})\nCommand:\n${command}\nOutput:\n${output}`
    )
    .join('\n\n');
