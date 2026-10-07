import { parse as shellQuoteParse, type ParseEntry } from 'shell-quote';
import {
  leadingWord,
  PASSIVE_LEADING_WORDS,
  scopedCommandSegments,
  skipEnvOptions,
} from './detours.js';

/** The CLI state-home variables an invocation set in its own prefix, resolved to absolute paths. */
export type InvocationEnv = {
  SUPABASE_HOME?: string;
  HOME?: string;
  TMPDIR?: string;
};

export type SupabaseInvocation = {
  /** Index into the `commands` array the invocation came from. */
  commandIndex: number;
  /** Executed argv, normalised so `argv[0]` is always `supabase`. */
  argv: string[];
  /** The command's working directory, updated by any earlier `cd`/`pushd` in the same command (until its subshell closes) or `env -C`. */
  cwd?: string;
  /** A `SUPABASE_WORKDIR=<dir>` assignment prefixing the invocation. */
  workdir?: string;
  /** `SUPABASE_HOME`/`HOME`/`TMPDIR` assignments prefixing the invocation; values that could not be resolved to a path are dropped. */
  env?: InvocationEnv;
  /** The package-runner spec (e.g. `npx --yes supabase@2.120.0`) when the invocation ran an explicitly versioned `supabase` through `npx`/`bunx`/`pnpm dlx`/`yarn dlx`. */
  runner?: string;
  /** The tool call's completion time (epoch ms), present only when the agent parser records it. */
  at?: number;
};

export type CommandEntry = { command: string; cwd?: string; at?: number };

const SHELL_EXPANSION_RE = /[$`]/;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PASSTHROUGH_WORDS = new Set(['exec', 'command', 'time', 'nohup']);
const PACKAGE_RUNNERS = new Set(['npx', 'bunx']);
const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'while',
  'until',
  'do',
  '!',
]);
const CHDIR_WORDS = new Set(['cd', 'pushd']);
const WORKDIR_VARIABLE = 'SUPABASE_WORKDIR';
const WORKDIR_ASSIGNMENT = `${WORKDIR_VARIABLE}=`;
const ENV_VARIABLES = ['SUPABASE_HOME', 'HOME', 'TMPDIR'] as const;
const PWD_PREFIX_RE = /^\$\{?PWD\}?(?=\/|$)/;
const VERSIONED_SUPABASE_RE = /^supabase@.+/;
const HELP_FLAGS = new Set(['--help', '-h']);

// Flags that consume the next token, so the verb isn't mistaken for a value.
const VALUE_FLAGS = new Set([
  '--workdir',
  '--stack',
  '--stack-id',
  '--project-id',
  '--profile',
  '--output',
  '-o',
  '--output-format',
  '--network-id',
  '--dns-resolver',
  '--runtime',
  '--exclude',
  '-x',
]);

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function joinPath(base: string | undefined, path: string): string {
  const absolute = path.startsWith('/');
  const joined = absolute || base === undefined ? path : `${base}/${path}`;
  const parts: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${joined.startsWith('/') ? '/' : ''}${parts.join('/')}`;
}

function changeDir(
  cwd: string | undefined,
  target: string | undefined
): string | undefined {
  return target === undefined || target === '-' || target.startsWith('~')
    ? undefined
    : joinPath(cwd, target);
}

// Unlike lib's `tryShellQuoteParse`, keeps `$VAR` literal instead of
// expanding it to '', so a loop variable target is detectable as unresolved.
function parseKeepingVariables(text: string): ParseEntry[] | undefined {
  try {
    return shellQuoteParse(text, (key) => `$${key}`);
  } catch {
    return undefined;
  }
}

/** Executed words up to the first operator (redirection, subshell close); globs keep their pattern. */
function words(tokens: readonly ParseEntry[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    if (typeof token === 'string') out.push(token);
    else if ('op' in token && token.op === 'glob') out.push(token.pattern);
    else break;
  }
  return out;
}

type RawEnv = Partial<Record<(typeof ENV_VARIABLES)[number], string>>;

function stripPrefixes(argv: readonly string[]): {
  argv: string[];
  workdir?: string;
  chdir?: string;
  rawEnv: RawEnv;
  runner?: string;
} {
  let i = 0;
  let workdir: string | undefined;
  let chdir: string | undefined;
  let rawEnv: RawEnv = {};
  let runnerStart: number | undefined;
  while (i < argv.length && SHELL_KEYWORDS.has(argv[i])) i++;
  while (i < argv.length) {
    const word = argv[i];
    if (word.startsWith(WORKDIR_ASSIGNMENT)) {
      workdir = word.slice(WORKDIR_ASSIGNMENT.length);
      i++;
    } else if (word === 'env') {
      const options = skipEnvOptions(argv, i + 1);
      i = options.next;
      if (options.chdir !== undefined) {
        chdir =
          chdir === undefined ? options.chdir : joinPath(chdir, options.chdir);
      }
      if (
        options.clearsEnvironment ||
        options.unset?.includes(WORKDIR_VARIABLE)
      ) {
        workdir = undefined;
      }
      if (options.clearsEnvironment) rawEnv = {};
      for (const name of options.unset ?? []) {
        delete rawEnv[name as keyof RawEnv];
      }
    } else if (ENV_ASSIGNMENT_RE.test(word)) {
      const name = word.slice(0, word.indexOf('='));
      if ((ENV_VARIABLES as readonly string[]).includes(name)) {
        rawEnv[name as keyof RawEnv] = word.slice(name.length + 1);
      }
      i++;
    } else if (PASSTHROUGH_WORDS.has(word)) {
      i++;
    } else if (word === 'timeout') {
      i += 2;
    } else if (PACKAGE_RUNNERS.has(word)) {
      runnerStart = i;
      i++;
      while (argv[i]?.startsWith('-')) i++;
    } else if (
      word === 'pnpm' &&
      (argv[i + 1] === 'dlx' || argv[i + 1] === 'exec')
    ) {
      runnerStart = argv[i + 1] === 'dlx' ? i : undefined;
      i += 2;
    } else if (word === 'yarn') {
      runnerStart = argv[i + 1] === 'dlx' ? i : undefined;
      i += argv[i + 1] === 'dlx' ? 2 : 1;
    } else {
      break;
    }
  }
  const runner =
    runnerStart !== undefined && VERSIONED_SUPABASE_RE.test(argv[i] ?? '')
      ? argv.slice(runnerStart, i + 1).join(' ')
      : undefined;
  return {
    argv: argv.slice(i),
    rawEnv,
    ...(workdir ? { workdir } : {}),
    ...(chdir === undefined ? {} : { chdir }),
    ...(runner === undefined ? {} : { runner }),
  };
}

/** A path assignment resolved against `cwd`; undefined when it depends on an unknown directory or other expansion. */
function resolveEnvPath(
  value: string,
  cwd: string | undefined
): string | undefined {
  const expanded = PWD_PREFIX_RE.test(value)
    ? cwd === undefined
      ? undefined
      : value.replace(PWD_PREFIX_RE, cwd)
    : value;
  if (
    expanded === undefined ||
    expanded === '' ||
    SHELL_EXPANSION_RE.test(expanded) ||
    expanded.startsWith('~')
  ) {
    return undefined;
  }
  if (expanded.startsWith('/')) return joinPath(undefined, expanded);
  return cwd === undefined ? undefined : joinPath(cwd, expanded);
}

function resolveEnv(
  rawEnv: RawEnv,
  cwd: string | undefined
): InvocationEnv | undefined {
  const env: InvocationEnv = {};
  for (const name of ENV_VARIABLES) {
    const raw = rawEnv[name];
    const resolved = raw === undefined ? undefined : resolveEnvPath(raw, cwd);
    if (resolved !== undefined) env[name] = resolved;
  }
  return Object.keys(env).length === 0 ? undefined : env;
}

function isSupabaseBinary(word: string | undefined): boolean {
  return (
    word !== undefined && basename(word).replace(/@.*$/, '') === 'supabase'
  );
}

function executedArgv(segment: string): ReturnType<typeof stripPrefixes> {
  const lead = leadingWord(segment);
  if (lead && PASSIVE_LEADING_WORDS.has(lead)) {
    return { argv: [], rawEnv: {} };
  }
  const tokens = parseKeepingVariables(segment);
  return stripPrefixes(tokens === undefined ? [] : words(tokens));
}

/**
 * Every `supabase` invocation the agent actually executed, in order — parsed
 * from argv per executable segment, so an echoed, commented, committed or
 * heredoc'd command line never counts. `cd`/`pushd` is tracked within a single
 * command only, starting from the entry's `cwd` and ending with its subshell.
 * `--help`/`-h` invocations are skipped.
 */
export function findSupabaseInvocations(
  commands: readonly (string | CommandEntry)[]
): SupabaseInvocation[] {
  const invocations: SupabaseInvocation[] = [];
  commands.forEach((entry, commandIndex) => {
    const command = typeof entry === 'string' ? entry : entry.command;
    let cwd = typeof entry === 'string' ? undefined : entry.cwd;
    const at = typeof entry === 'string' ? undefined : entry.at;
    const enclosing: Array<string | undefined> = [];
    for (const { segment, opens, closes } of scopedCommandSegments(command)) {
      for (let n = 0; n < opens; n++) enclosing.push(cwd);
      const { argv, workdir, chdir, rawEnv, runner } = executedArgv(segment);
      const dir = chdir === undefined ? cwd : changeDir(cwd, chdir);
      if (CHDIR_WORDS.has(argv[0])) {
        cwd = changeDir(cwd, argv[1]);
      } else if (
        isSupabaseBinary(argv[0]) &&
        !argv.some((word) => HELP_FLAGS.has(word))
      ) {
        const env = resolveEnv(rawEnv, dir);
        invocations.push({
          commandIndex,
          argv: ['supabase', ...argv.slice(1)],
          ...(dir === undefined ? {} : { cwd: dir }),
          ...(workdir === undefined ? {} : { workdir }),
          ...(env === undefined ? {} : { env }),
          ...(runner === undefined ? {} : { runner }),
          ...(at === undefined ? {} : { at }),
        });
      }
      for (let n = 0; n < closes && enclosing.length > 0; n++) {
        cwd = enclosing.pop();
      }
    }
  });
  return invocations;
}

function positionals(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('-')) {
      if (!token.includes('=') && VALUE_FLAGS.has(token)) i++;
      continue;
    }
    out.push(token);
  }
  return out;
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1];
    if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
  }
  return undefined;
}

/** The subcommand an invocation ran, e.g. `stop` or `stack destroy`. */
export function invocationVerb(inv: SupabaseInvocation): string | undefined {
  const [first, second] = positionals(inv.argv);
  if (first === 'stack' && second !== undefined) return `stack ${second}`;
  return first;
}

/**
 * The stack or project name an invocation addresses: `--stack` or
 * `--project-id`, else the basename of `--workdir` (or `SUPABASE_WORKDIR`),
 * else the `cd` directory's.
 */
function targetName(inv: SupabaseInvocation): string | undefined {
  const stack =
    flagValue(inv.argv, '--stack') ?? flagValue(inv.argv, '--project-id');
  if (stack !== undefined) return stack;
  if (flagValue(inv.argv, '--stack-id') !== undefined) return undefined;
  const workdir = flagValue(inv.argv, '--workdir') ?? inv.workdir;
  const dir = workdir === undefined ? inv.cwd : joinPath(inv.cwd, workdir);
  return dir === undefined ? undefined : basename(dir);
}

/** Whether the invocation addresses `name`; `--all` addresses every stack. */
export function invocationTargets(
  inv: SupabaseInvocation,
  name: string
): boolean {
  return inv.argv.includes('--all') || targetName(inv) === name;
}

/** Whether the addressed name comes from a shell expansion (`$s`, backticks), e.g. inside a loop. */
export function invocationTargetUnresolved(inv: SupabaseInvocation): boolean {
  const name = targetName(inv);
  return name !== undefined && SHELL_EXPANSION_RE.test(name);
}

/**
 * Distinct runner specs of invocations that ran an explicitly versioned
 * `supabase` through a package runner, skipping runs of `installedVersion`.
 */
export function listCliOverrides(
  invocations: readonly SupabaseInvocation[],
  installedVersion?: string | null
): string[] {
  const installed = installedVersion?.trim().replace(/^v/, '');
  const runners = new Set<string>();
  for (const { runner } of invocations) {
    if (runner === undefined) continue;
    const version = runner.slice(runner.lastIndexOf('@') + 1).replace(/^v/, '');
    if (version !== installed) runners.add(runner);
  }
  return [...runners];
}
