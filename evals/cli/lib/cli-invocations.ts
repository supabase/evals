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
  /** The runner spec (e.g. `npx --yes supabase@2.120.0`, `npm i -g supabase@2.120.0`) when the invocation ran an explicitly versioned `supabase` through a package runner or a global install earlier in the run. */
  runner?: string;
  /** The tool call's completion time (epoch ms), present only when the agent parser records it. */
  at?: number;
};

export type CommandEntry = {
  command: string;
  cwd?: string;
  at?: number;
  /** The tool call errored; a global install in it is not applied. */
  failed?: boolean;
};

const SHELL_EXPANSION_RE = /[$`]/;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PASSTHROUGH_WORDS = new Set(['exec', 'command', 'time', 'nohup']);
const PACKAGE_RUNNERS = new Set(['npx', 'bunx']);
const NPM_EXEC_VERBS = new Set(['exec', 'x']);
const INSTALLERS = new Set(['npm', 'pnpm', 'bun']);
const INSTALL_VERBS = new Set(['i', 'install', 'add']);
const UNINSTALL_VERBS = new Set([
  'uninstall',
  'un',
  'remove',
  'rm',
  'r',
  'unlink',
]);
const GLOBAL_FLAGS = new Set(['-g', '--global']);
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const START_VERBS = new Set(['start', 'stack start']);
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
const HOME_PREFIX_RE = /^(?:\$\{?HOME\}?|~)(?=\/|$)/;
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

function expandPwd(value: string, cwd: string | undefined): string {
  return cwd === undefined ? value : value.replace(PWD_PREFIX_RE, cwd);
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

type Stripped = {
  argv: string[];
  workdir?: string;
  chdir?: string;
  rawEnv: RawEnv;
  runner?: string;
};

function skipRunnerOptions(
  argv: readonly string[],
  start: number
): { next: number; packageAt?: number } {
  let i = start;
  let packageAt: number | undefined;
  while (argv[i]?.startsWith('-')) {
    const flag = argv[i];
    if (flag === '--') {
      i++;
      break;
    }
    if (flag === '-p' || flag === '--package') {
      if (
        packageAt === undefined &&
        VERSIONED_SUPABASE_RE.test(argv[i + 1] ?? '')
      ) {
        packageAt = i + 1;
      }
      i += 2;
    } else {
      if (
        packageAt === undefined &&
        flag.startsWith('--package=') &&
        VERSIONED_SUPABASE_RE.test(flag.slice('--package='.length))
      ) {
        packageAt = i;
      }
      i++;
    }
  }
  return { next: i, packageAt };
}

function stripPrefixes(
  argv: readonly string[],
  seedEnv: RawEnv = {}
): Stripped {
  let i = 0;
  let workdir: string | undefined;
  let chdir: string | undefined;
  let rawEnv: RawEnv = { ...seedEnv };
  let runnerStart: number | undefined;
  let runnerEnd: number | undefined;
  let npmExec = false;
  while (i < argv.length && SHELL_KEYWORDS.has(argv[i])) i++;
  while (i < argv.length) {
    const word = argv[i];
    const next = argv[i + 1];
    const runnerSkip = PACKAGE_RUNNERS.has(word)
      ? 1
      : (word === 'npm' && NPM_EXEC_VERBS.has(next)) ||
          (word === 'pnpm' && next === 'dlx') ||
          (word === 'yarn' && next === 'dlx')
        ? 2
        : 0;
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
    } else if (runnerSkip > 0) {
      runnerStart = i;
      npmExec = word === 'npm';
      const options = skipRunnerOptions(argv, i + runnerSkip);
      runnerEnd = options.packageAt;
      i = options.next;
    } else if (word === 'pnpm' && next === 'exec') {
      runnerStart = undefined;
      i += 2;
    } else if (word === 'yarn' && next !== 'global') {
      runnerStart = undefined;
      i++;
    } else {
      break;
    }
  }
  if (runnerEnd === undefined && VERSIONED_SUPABASE_RE.test(argv[i] ?? '')) {
    runnerEnd = i;
  }
  const runner =
    runnerStart !== undefined && runnerEnd !== undefined
      ? argv.slice(runnerStart, runnerEnd + 1).join(' ')
      : undefined;
  const rest = argv.slice(i);
  if (npmExec && rest[1] === '--') rest.splice(1, 1);
  return {
    argv: rest,
    rawEnv,
    ...(workdir ? { workdir } : {}),
    ...(chdir === undefined ? {} : { chdir }),
    ...(runner === undefined ? {} : { runner }),
  };
}

/**
 * A path assignment resolved to an absolute path; undefined when it depends on
 * an unknown directory or other expansion. `$PWD` expands against the shell's
 * `shellCwd`, a plain relative value against the executable's `cwd` (which
 * `env -C` moves).
 */
function resolveEnvPath(
  value: string,
  shellCwd: string | undefined,
  cwd: string | undefined,
  home: string | undefined
): string | undefined {
  const expanded = expandAssigned(value, shellCwd, home);
  if (expanded === undefined) return undefined;
  if (expanded.startsWith('/')) return joinPath(undefined, expanded);
  return cwd === undefined ? undefined : joinPath(cwd, expanded);
}

/** A value with a leading `$PWD`/`$HOME`/`~` expanded; a plain relative value stays relative. Undefined when it depends on an unknown directory or other expansion. */
function expandAssigned(
  value: string,
  shellCwd: string | undefined,
  home: string | undefined
): string | undefined {
  const expanded = PWD_PREFIX_RE.test(value)
    ? shellCwd === undefined
      ? undefined
      : value.replace(PWD_PREFIX_RE, shellCwd)
    : HOME_PREFIX_RE.test(value)
      ? home === undefined
        ? undefined
        : value.replace(HOME_PREFIX_RE, home)
      : value;
  return expanded === undefined ||
    expanded === '' ||
    SHELL_EXPANSION_RE.test(expanded) ||
    expanded.startsWith('~')
    ? undefined
    : expanded;
}

function resolveEnv(
  rawEnv: RawEnv,
  shellCwd: string | undefined,
  cwd: string | undefined,
  home: string | undefined
): InvocationEnv | undefined {
  const env: InvocationEnv = {};
  for (const name of ENV_VARIABLES) {
    const raw = rawEnv[name];
    const resolved =
      raw === undefined ? undefined : resolveEnvPath(raw, shellCwd, cwd, home);
    if (resolved !== undefined) env[name] = resolved;
  }
  return Object.keys(env).length === 0 ? undefined : env;
}

function isSupabaseBinary(word: string | undefined): boolean {
  return (
    word !== undefined && basename(word).replace(/@.*$/, '') === 'supabase'
  );
}

function executedArgv(segment: string, seedEnv: RawEnv): Stripped {
  const lead = leadingWord(segment);
  if (lead && PASSIVE_LEADING_WORDS.has(lead)) {
    return { argv: [], rawEnv: {} };
  }
  const tokens = parseKeepingVariables(segment);
  return stripPrefixes(tokens === undefined ? [] : words(tokens), seedEnv);
}

type EnvName = (typeof ENV_VARIABLES)[number];

/** Shell state a command carries from segment to segment, restored when its subshell closes. */
type ShellState = {
  cwd?: string;
  vars: RawEnv;
  exported: ReadonlySet<EnvName>;
};

function isEnvName(name: string): name is EnvName {
  return (ENV_VARIABLES as readonly string[]).includes(name);
}

function exportedEnv(state: ShellState): RawEnv {
  const env: RawEnv = {};
  for (const name of state.exported) {
    const value = state.vars[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function assignVariables(
  state: ShellState,
  assignments: ReadonlyArray<readonly [EnvName, string | undefined]>,
  exportThem: boolean
): ShellState {
  const vars = { ...state.vars };
  const exported = new Set(state.exported);
  for (const [name, raw] of assignments) {
    if (raw !== undefined) {
      const expanded = expandAssigned(raw, state.cwd, state.vars.HOME);
      if (expanded === undefined) delete vars[name];
      else vars[name] = expanded;
    }
    if (exportThem) exported.add(name);
  }
  return { ...state, vars, exported };
}

function exportAssignments(
  words: readonly string[]
): Array<readonly [EnvName, string | undefined]> {
  const out: Array<readonly [EnvName, string | undefined]> = [];
  for (const word of words) {
    const eq = word.indexOf('=');
    const name = eq === -1 ? word : word.slice(0, eq);
    if (isEnvName(name))
      out.push([name, eq === -1 ? undefined : word.slice(eq + 1)]);
  }
  return out;
}

function isGlobalUninstall(argv: readonly string[]): boolean {
  const [tool, verb] = argv;
  const yarnGlobal =
    tool === 'yarn' && verb === 'global' && UNINSTALL_VERBS.has(argv[2]);
  const direct =
    INSTALLERS.has(tool) &&
    UNINSTALL_VERBS.has(verb) &&
    argv.some((word) => GLOBAL_FLAGS.has(word));
  return (
    (yarnGlobal || direct) &&
    argv.some((word) => word === 'supabase' || VERSIONED_SUPABASE_RE.test(word))
  );
}

function globalInstallSpec(argv: readonly string[]): string | undefined {
  const [tool, verb] = argv;
  const yarnGlobal = tool === 'yarn' && verb === 'global' && argv[2] === 'add';
  const direct =
    INSTALLERS.has(tool) &&
    INSTALL_VERBS.has(verb) &&
    argv.some((word) => GLOBAL_FLAGS.has(word));
  if (!yarnGlobal && !direct) return undefined;
  const at = argv.findIndex((word) => VERSIONED_SUPABASE_RE.test(word));
  return at === -1 ? undefined : argv.slice(0, at + 1).join(' ');
}

/** Whether the invocation brings a stack up (`start` or `stack start`). */
export function isStartInvocation(inv: SupabaseInvocation): boolean {
  return START_VERBS.has(invocationVerb(inv) ?? '');
}

/**
 * Every `supabase` invocation the agent actually executed, in order — parsed
 * from argv per executable segment, so an echoed, commented, committed or
 * heredoc'd command line never counts. `cd`/`pushd` and `export` of
 * `SUPABASE_HOME`/`HOME`/`TMPDIR` are tracked within a single command only,
 * starting from the entry's `cwd` and ending with its subshell. A global
 * `supabase@<version>` install marks every later invocation with its `runner`
 * until a global uninstall; an entry marked `failed` applies neither.
 * `--help`/`-h` invocations are skipped.
 */
export function findSupabaseInvocations(
  commands: readonly (string | CommandEntry)[]
): SupabaseInvocation[] {
  const invocations: SupabaseInvocation[] = [];
  let globalRunner: string | undefined;
  commands.forEach((entry, commandIndex) => {
    const command = typeof entry === 'string' ? entry : entry.command;
    let state: ShellState = {
      cwd: typeof entry === 'string' ? undefined : entry.cwd,
      vars: {},
      exported: new Set(),
    };
    const at = typeof entry === 'string' ? undefined : entry.at;
    const failed = typeof entry === 'string' ? false : entry.failed === true;
    const enclosing: ShellState[] = [];
    for (const { segment, opens, closes } of scopedCommandSegments(command)) {
      for (let n = 0; n < opens; n++) enclosing.push(state);
      const seed = exportedEnv(state);
      const { argv, workdir, chdir, rawEnv, runner } = executedArgv(
        segment,
        seed
      );
      const dir =
        chdir === undefined
          ? state.cwd
          : changeDir(state.cwd, expandPwd(chdir, state.cwd));
      if (CHDIR_WORDS.has(argv[0])) {
        state = { ...state, cwd: changeDir(state.cwd, argv[1]) };
      } else if (argv[0] === 'export') {
        state = assignVariables(state, exportAssignments(argv.slice(1)), true);
      } else if (argv.length === 0) {
        const assigned = ENV_VARIABLES.filter(
          (name) => rawEnv[name] !== seed[name]
        ).map((name) => [name, rawEnv[name]] as const);
        state = assignVariables(state, assigned, false);
      } else if (
        isSupabaseBinary(argv[0]) &&
        !argv.some((word) => HELP_FLAGS.has(word))
      ) {
        const env = resolveEnv(rawEnv, state.cwd, dir, state.vars.HOME);
        const effectiveRunner = runner ?? globalRunner;
        invocations.push({
          commandIndex,
          argv: ['supabase', ...argv.slice(1)],
          ...(dir === undefined ? {} : { cwd: dir }),
          ...(workdir === undefined ? {} : { workdir }),
          ...(env === undefined ? {} : { env }),
          ...(effectiveRunner === undefined ? {} : { runner: effectiveRunner }),
          ...(at === undefined ? {} : { at }),
        });
      } else if (!failed) {
        if (isGlobalUninstall(argv)) globalRunner = undefined;
        else globalRunner = globalInstallSpec(argv) ?? globalRunner;
      }
      for (let n = 0; n < closes && enclosing.length > 0; n++) {
        state = enclosing.pop() ?? state;
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

// Only `stop` takes `--project-id` as a local stack name; elsewhere it is a remote ref or unsupported.
function stopProjectId(inv: SupabaseInvocation): string | undefined {
  return invocationVerb(inv) === 'stop'
    ? flagValue(inv.argv, '--project-id')
    : undefined;
}

function stackFlagName(inv: SupabaseInvocation): string | undefined {
  return stopProjectId(inv) ?? flagValue(inv.argv, '--stack');
}

/**
 * The directory an invocation ran against: `--workdir` (or `SUPABASE_WORKDIR`)
 * resolved against its `cwd` (a leading `$PWD` is that `cwd`); undefined when
 * neither is known.
 */
export function invocationDirectory(
  inv: SupabaseInvocation
): string | undefined {
  const workdir = flagValue(inv.argv, '--workdir') ?? inv.workdir;
  if (workdir !== undefined) {
    return joinPath(inv.cwd, expandPwd(workdir, inv.cwd));
  }
  return inv.cwd === undefined ? undefined : joinPath(undefined, inv.cwd);
}

// `--stack-id` addresses a stack by id, so the directory says nothing about it.
function directoryName(inv: SupabaseInvocation): string | undefined {
  if (flagValue(inv.argv, '--stack-id') !== undefined) return undefined;
  const dir = invocationDirectory(inv);
  return dir === undefined ? undefined : basename(dir);
}

/** Whether the invocation ran in `dir`; a relative invocation directory is compared by basename only. */
export function invocationTargetsDir(
  inv: SupabaseInvocation,
  dir: string
): boolean {
  if (flagValue(inv.argv, '--stack-id') !== undefined) return false;
  const actual = invocationDirectory(inv);
  if (actual === undefined) return false;
  const wanted = joinPath(undefined, dir);
  return actual.startsWith('/') && wanted.startsWith('/')
    ? joinPath(undefined, actual) === wanted
    : basename(actual) === basename(wanted);
}

/**
 * Whether the invocation addresses `name`; `--all` addresses every stack. A
 * `stop --project-id` is authoritative whatever the directory; other verbs
 * ignore `--project-id`. Otherwise the directory it ran in wins: a `--stack`
 * name counts only when the directory's basename is not another of
 * `knownTargets`.
 */
export function invocationTargets(
  inv: SupabaseInvocation,
  name: string,
  knownTargets?: readonly string[]
): boolean {
  if (inv.argv.includes('--all')) return true;
  const projectId = stopProjectId(inv);
  if (projectId !== undefined) return projectId === name;
  const dir = directoryName(inv);
  if (dir === name) return true;
  if (stackFlagName(inv) !== name) return false;
  return dir === undefined || !knownTargets?.includes(dir);
}

/** Whether the addressed name comes from a shell expansion (`$s`, backticks), e.g. inside a loop. */
export function invocationTargetUnresolved(inv: SupabaseInvocation): boolean {
  const name = stackFlagName(inv) ?? directoryName(inv);
  return name !== undefined && SHELL_EXPANSION_RE.test(name);
}

function runnerVersion(runner: string): string {
  return runner.slice(runner.lastIndexOf('@') + 1).replace(/^v/, '');
}

/**
 * Distinct runner specs of invocations that ran an explicitly versioned
 * `supabase` (through a package runner or an earlier global install),
 * skipping runs of `installedVersion`. Dist-tags (`@latest`) cannot be
 * verified offline and are listed by `listUnverifiedRunners` instead.
 */
export function listCliOverrides(
  invocations: readonly SupabaseInvocation[],
  installedVersion?: string | null
): string[] {
  const installed = installedVersion?.trim().replace(/^v/, '');
  const runners = new Set<string>();
  for (const { runner } of invocations) {
    if (runner === undefined) continue;
    const version = runnerVersion(runner);
    if (SEMVER_RE.test(version) && version !== installed) runners.add(runner);
  }
  return [...runners];
}

/** Distinct runner specs pinned to a dist-tag or range rather than a semver version. */
export function listUnverifiedRunners(
  invocations: readonly SupabaseInvocation[]
): string[] {
  const runners = new Set<string>();
  for (const { runner } of invocations) {
    if (runner !== undefined && !SEMVER_RE.test(runnerVersion(runner))) {
      runners.add(runner);
    }
  }
  return [...runners];
}
