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

/** A tool call whose output may show an inspect report: one that ran inspect, or a later one that read a file such a call named. */
export type EvidenceCall = {
  commandIndex: number;
  kind: 'candidate' | 'later read';
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
const DATED_FOLDER_RE = /\b\d{4}-\d{2}-\d{2}\//;
const OUTPUT_PATH_RE =
  /(?:&?>>?|\btee(?:\s+-\S+)*|--output-dir[=\s])\s*(?!&)(["']?)([^\s"'|;&<>()]+)\1/g;
const UNHELPFUL_PATHS = new Set(['.', './', '/', '/dev/null']);

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

function outputPaths(command: string): string[] {
  return [...command.matchAll(OUTPUT_PATH_RE)]
    .map((match) => match[2])
    .filter((path) => !UNHELPFUL_PATHS.has(path));
}

/**
 * The calls whose output may show an inspect report, in call order: those that
 * ran inspect (parsed, or matched loosely in case parsing missed the shape) and
 * the later calls that mention a path or dated folder one of them wrote.
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
  const evidence: EvidenceCall[] = [];
  entries.forEach(({ command }, commandIndex) => {
    const candidate = candidates.has(commandIndex);
    const read =
      written.some((path) => command.includes(path)) ||
      (reported && DATED_FOLDER_RE.test(command));
    if (candidate) {
      written.push(...outputPaths(command));
      reported ||= REPORT_RE.test(command);
    }
    if (!candidate && !read) return;
    const output = callText(calls[commandIndex]);
    evidence.push({
      commandIndex,
      kind: candidate ? 'candidate' : 'later read',
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
        `Tool call ${commandIndex + 1} (${kind === 'candidate' ? 'candidate' : 'later read'})\nCommand:\n${command}\nOutput:\n${output}`
    )
    .join('\n\n');
