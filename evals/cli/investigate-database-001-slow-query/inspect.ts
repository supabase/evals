import type { CheckResult, ToolCallRecord } from '@supabase-evals/core';
import type { ParseEntry } from 'shell-quote';
import {
  findSupabaseInvocations,
  invocationFlag,
  invocationPositionals,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import {
  commandToolCalls,
  extractCommandEntries,
  leadingWord,
  tryShellQuoteParse,
  unmaskedCommandSegments,
} from '../lib/detours.js';
import { ORDERS_TABLE } from './fixtures.js';

export type InspectRun = {
  commandIndex: number;
  report: string;
  errored: boolean;
  namesOrders: boolean;
  /** The later tool call whose read of the run's output named orders. */
  readInCall?: number;
  /** The run's call named orders, but other commands in it may have printed that. */
  sharedOutput?: true;
};

export const INSPECT_CHECK_NAME =
  'an inspect db report showed the orders table';

const ORDERS_RE = new RegExp(`\\b${ORDERS_TABLE}\\b`);
const HELP_FLAGS = new Set(['--help', '-h']);
const PATH_VALUE_FLAGS = new Set(['--db-url', '--output-dir']);
const CSI_SEQUENCE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const QUIET_VERBS = new Set([
  'start',
  'stop',
  'status',
  'stack start',
  'stack stop',
  'stack status',
  'stack list',
]);
const NEUTRAL_WORDS = new Set([
  'cd',
  'pushd',
  'popd',
  'export',
  'set',
  'true',
  ':',
  'sleep',
]);
const FILTER_WORDS = new Set([
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'sed',
  'awk',
  'jq',
  'cut',
  'sort',
  'uniq',
  'column',
  'tee',
  'less',
  'more',
  'wc',
  'tr',
  'nl',
  'cat',
  'fold',
]);

type FilterSyntax = {
  patternFlags: readonly string[];
  valueFlags: Readonly<Record<string, number>>;
};
const GREP_SYNTAX: FilterSyntax = {
  patternFlags: ['-e', '-f', '--regexp', '--file'],
  valueFlags: { '-m': 1, '-A': 1, '-B': 1, '-C': 1 },
};
const FILTER_SYNTAX: Readonly<Record<string, FilterSyntax>> = {
  grep: GREP_SYNTAX,
  egrep: GREP_SYNTAX,
  fgrep: GREP_SYNTAX,
  rg: GREP_SYNTAX,
  sed: { patternFlags: ['-e', '-f', '--expression', '--file'], valueFlags: {} },
  awk: { patternFlags: ['-f', '--file'], valueFlags: { '-v': 1, '-F': 1 } },
  jq: {
    patternFlags: ['-f', '--from-file'],
    valueFlags: { '--arg': 2, '--argjson': 2 },
  },
};
const VAR_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NUMERIC_RE = /^[+-]?\d+$/;
const GLOB_CHAR_RE = /[*?[{]/;
const DATED_FOLDER_RE = /^(?:\.\/)?\d{4}-\d{2}-\d{2}\//;
const CURRENT_DIR_RE = /^(?:\.\/?)?$/;

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

type Operand = { text: string; globbed: boolean };
type Location = (operand: Operand) => boolean;
type Segment =
  | { kind: 'inspect'; report: string; locations: Location[] }
  | { kind: 'filter'; reads: Operand[]; writes: Location[] }
  | { kind: 'quiet' }
  | { kind: 'other' };

const QUIET: Segment = { kind: 'quiet' };
const OTHER: Segment = { kind: 'other' };

const withoutDot = (path: string) => path.replace(/^(?:\.\/)+/, '');

/** The location of a file or directory: that path and everything below it. */
function under(path: string): Location[] {
  const root = withoutDot(path).replace(/\/+$/, '');
  if (root === '') return [];
  return [
    ({ text, globbed }) => {
      const operand = withoutDot(text);
      return operand.startsWith(`${root}/`) || (!globbed && operand === root);
    },
  ];
}

const datedFolders: Location = ({ text }) => DATED_FOLDER_RE.test(text);

/**
 * The file operands of a command's arguments and the files it writes. Every
 * non-flag word is a file except a number, the pattern or program a
 * `FILTER_SYNTAX` command takes first (or through its pattern flag), and what
 * `tr` takes; a separated flag value it doesn't know counts as a file.
 * `unresolved` is set for a variable or substitution that could not be read.
 */
function readArguments(
  tokens: readonly ParseEntry[],
  word = ''
): { operands: Operand[]; writes: string[]; unresolved: boolean } {
  const syntax = FILTER_SYNTAX[word];
  const operands: Operand[] = [];
  const writes: string[] = [];
  let unresolved = false;
  let patternPending = syntax !== undefined;
  const addOperand = (pattern: string, globbed: boolean) => {
    const text = globbed ? pattern.split(GLOB_CHAR_RE, 1)[0] : pattern;
    operands.push({ text, globbed });
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (typeof token === 'string') {
      if (token === '' || token.includes('`')) {
        unresolved = true;
      } else if (token.startsWith('-')) {
        const supplied = syntax?.patternFlags.find(
          (flag) =>
            token === flag ||
            token.startsWith(flag.startsWith('--') ? `${flag}=` : flag)
        );
        if (supplied !== undefined) {
          patternPending = false;
          if (token === supplied) i++;
        } else {
          i += syntax?.valueFlags[token] ?? 0;
        }
      } else if (patternPending) {
        patternPending = false;
      } else if (!NUMERIC_RE.test(token) && word !== 'tr') {
        addOperand(token, false);
      }
    } else if ('op' in token && token.op === 'glob') {
      addOperand(token.pattern, true);
    } else if ('op' in token) {
      const target = tokens[i + 1];
      if (token.op === '>' || token.op === '>>') {
        if (typeof target === 'string') writes.push(target);
        i++;
      } else if (token.op === '>&') {
        i++;
      } else if (token.op === '<' && typeof target === 'string') {
        addOperand(target, false);
        i++;
      }
    }
  }
  return { operands, writes, unresolved };
}

function outputLocations(
  inv: SupabaseInvocation,
  report: string,
  writes: readonly string[]
): Location[] {
  const locations = writes.flatMap(under);
  if (report !== 'report') return locations;
  const dir = invocationFlag(inv, '--output-dir');
  return dir === undefined || CURRENT_DIR_RE.test(dir)
    ? [...locations, datedFolders]
    : [...locations, ...under(dir)];
}

const isQuiet = (inv: SupabaseInvocation) =>
  QUIET_VERBS.has(invocationVerb(inv) ?? '') || inv.argv.includes('--version');

function classify(segment: string, cwd: string | undefined): Segment {
  const tokens = tryShellQuoteParse(segment) ?? [];
  const [inv] = findSupabaseInvocations([
    { command: segment, ...(cwd === undefined ? {} : { cwd }) },
  ]);
  if (inv !== undefined) {
    const report = inspectReport(inv);
    if (report !== undefined) {
      const { writes } = readArguments(tokens);
      return {
        kind: 'inspect',
        report,
        locations: outputLocations(inv, report, writes),
      };
    }
    return isQuiet(inv) ? QUIET : OTHER;
  }
  if (
    tokens.length > 0 &&
    tokens.every(
      (token) => typeof token === 'string' && VAR_ASSIGNMENT_RE.test(token)
    )
  ) {
    return QUIET;
  }
  const word = leadingWord(segment);
  if (word === undefined) return OTHER;
  if (NEUTRAL_WORDS.has(word)) return QUIET;
  if (!FILTER_WORDS.has(word)) return OTHER;
  const start = tokens.findIndex(
    (token) =>
      typeof token === 'string' &&
      token.slice(token.lastIndexOf('/') + 1).toLowerCase() === word
  );
  if (start === -1) return OTHER;
  const { operands, unresolved } = readArguments(tokens.slice(start + 1), word);
  if (unresolved) return OTHER;
  return word === 'tee'
    ? {
        kind: 'filter',
        reads: [],
        writes: operands
          .filter(({ globbed }) => !globbed)
          .flatMap(({ text }) => under(text)),
      }
    : { kind: 'filter', reads: operands, writes: [] };
}

type Tracked = { run: InspectRun; locations: Location[] };

/** One run per executed `supabase inspect` report, credited with naming orders only when the output that named it came from inspect alone, or from reading what inspect wrote. */
export function findInspectRuns(
  toolCalls: readonly ToolCallRecord[]
): InspectRun[] {
  const calls = commandToolCalls(toolCalls);
  const entries = extractCommandEntries(toolCalls);
  const tracked: Tracked[] = [];
  calls.forEach((call, commandIndex) => {
    const { command, cwd } = entries[commandIndex];
    const segments = unmaskedCommandSegments(command).map((segment) =>
      classify(segment, cwd)
    );
    const teed = segments.flatMap((segment) =>
      segment.kind === 'filter' ? segment.writes : []
    );
    const here = segments.flatMap((segment): Tracked[] =>
      segment.kind === 'inspect'
        ? [
            {
              run: {
                commandIndex,
                report: segment.report,
                errored: call.error !== undefined,
                namesOrders: false,
              },
              locations: [...segment.locations, ...teed],
            },
          ]
        : []
    );
    tracked.push(...here);

    const covering = (operand: Operand) =>
      tracked.filter(({ locations }) =>
        locations.some((location) => location(operand))
      );
    const reads = segments.flatMap((segment) =>
      segment.kind === 'filter' ? segment.reads : []
    );
    if (!ORDERS_RE.test(callText(call))) return;
    const shared =
      segments.some(({ kind }) => kind === 'other') ||
      reads.some((read) => covering(read).length === 0);
    if (shared) {
      for (const { run } of here) run.sharedOutput = true;
      return;
    }
    for (const { run } of new Set([...here, ...reads.flatMap(covering)])) {
      if (run.namesOrders) continue;
      run.namesOrders = true;
      if (run.commandIndex !== commandIndex) run.readInCall = commandIndex;
    }
  });
  return tracked.map(({ run }) => run);
}

const describeRun = ({ commandIndex, report, readInCall }: InspectRun) =>
  `tool call ${commandIndex + 1}: supabase inspect ${report}${
    readInCall === undefined ? '' : ` via tool call ${readInCall + 1}`
  }`;

function describeUnshown(run: InspectRun) {
  const qualifiers = [
    ...(run.errored ? ['errored'] : []),
    ...(run.sharedOutput ? ['output shared with other commands'] : []),
  ];
  return `${describeRun(run)}${
    qualifiers.length > 0 ? ` (${qualifiers.join('; ')})` : ''
  }`;
}

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
  return {
    name,
    passed: false,
    notes: `${runs.map(describeUnshown).join('; ')}; none printed the ${ORDERS_TABLE} table`,
  };
}
