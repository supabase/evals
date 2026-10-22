import type { CheckResult, ToolCallRecord } from '@supabase-evals/core';
import {
  invocationPositionals,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { commandToolCalls } from '../lib/detours.js';
import { ORDERS_TABLE } from './fixtures.js';

export type InspectRun = {
  commandIndex: number;
  report: string;
  errored: boolean;
  namesOrders: boolean;
};

export const INSPECT_CHECK_NAME =
  'an inspect db report showed the orders table';

const ORDERS_RE = new RegExp(`\\b${ORDERS_TABLE}\\b`);
const HELP_FLAGS = new Set(['--help', '-h']);
const PATH_VALUE_FLAGS = new Set(['--db-url', '--output-dir']);
const CSI_SEQUENCE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

/** The report an executed `supabase inspect` invocation ran, such as `db outliers` or `report`; undefined for anything else, help included. */
export function inspectReport(inv: SupabaseInvocation): string | undefined {
  if (inv.argv.some((word) => HELP_FLAGS.has(word))) return undefined;
  const argv = inv.argv.filter(
    (_, i) => !PATH_VALUE_FLAGS.has(inv.argv[i - 1])
  );
  const [verb, first, second] = invocationPositionals({ ...inv, argv });
  if (verb !== 'inspect' || first === undefined) return undefined;
  return first === 'db' && second !== undefined ? `db ${second}` : first;
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === null || result === undefined) return '';
  return JSON.stringify(result).replace(/\\[nrt]/g, ' ');
}

/** A call's result and error together, since a command that exits non-zero keeps its output in `error`. */
const callText = ({ result, error }: ToolCallRecord): string =>
  `${resultText(result)}\n${error ?? ''}`.replace(CSI_SEQUENCE, '');

/** One run per executed `supabase inspect` report, read from the output of the tool call that ran it. */
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
        namesOrders: ORDERS_RE.test(callText(call)),
      },
    ];
  });
}

const describeRun = ({ commandIndex, report }: InspectRun) =>
  `tool call ${commandIndex + 1}: supabase inspect ${report}`;

export function checkInspectShowedOrders(
  runs: readonly InspectRun[]
): CheckResult {
  const name = INSPECT_CHECK_NAME;
  const shown = runs.find(({ namesOrders }) => namesOrders);
  if (shown !== undefined) {
    return { name, passed: true, notes: describeRun(shown) };
  }
  if (runs.length === 0) {
    return { name, passed: false, notes: 'no supabase inspect report ran' };
  }
  const ran = runs
    .map((run) => `${describeRun(run)}${run.errored ? ' (errored)' : ''}`)
    .join('; ');
  return {
    name,
    passed: false,
    notes: `${ran}; none printed the ${ORDERS_TABLE} table`,
  };
}
