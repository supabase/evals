import { parse as shellQuoteParse, type ParseEntry } from 'shell-quote';
import {
  leadingWord,
  PASSIVE_LEADING_WORDS,
  unmaskedCommandSegments,
} from './detours.js';

export type SupabaseInvocation = {
  /** Index into the `commands` array the invocation came from. */
  commandIndex: number;
  /** Executed argv, normalised so `argv[0]` is always `supabase`. */
  argv: string[];
  /** Directory entered by an earlier `cd` in the same command, if any. */
  cwd?: string;
};

const SHELL_EXPANSION_RE = /[$`]/;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PASSTHROUGH_WORDS = new Set(['env', 'exec', 'command', 'time', 'nohup']);
const PACKAGE_RUNNERS = new Set(['npx', 'bunx']);

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

function stripPrefixes(argv: readonly string[]): string[] {
  let i = 0;
  while (i < argv.length) {
    const word = argv[i];
    if (ENV_ASSIGNMENT_RE.test(word) || PASSTHROUGH_WORDS.has(word)) {
      i++;
    } else if (word === 'timeout') {
      i += 2;
    } else if (PACKAGE_RUNNERS.has(word)) {
      i++;
      while (argv[i]?.startsWith('-')) i++;
    } else if (word === 'pnpm' && argv[i + 1] === 'dlx') {
      i += 2;
    } else {
      break;
    }
  }
  return argv.slice(i);
}

function isSupabaseBinary(word: string | undefined): boolean {
  return (
    word !== undefined && basename(word).replace(/@.*$/, '') === 'supabase'
  );
}

/**
 * Every `supabase` invocation the agent actually executed, in order — parsed
 * from argv per executable segment, so an echoed, committed or heredoc'd
 * command line never counts. `cd` is tracked within a single command only.
 */
export function findSupabaseInvocations(
  commands: readonly string[]
): SupabaseInvocation[] {
  const invocations: SupabaseInvocation[] = [];
  commands.forEach((command, commandIndex) => {
    let cwd: string | undefined;
    for (const segment of unmaskedCommandSegments(command)) {
      const lead = leadingWord(segment);
      if (lead && PASSIVE_LEADING_WORDS.has(lead)) continue;
      const tokens = parseKeepingVariables(segment);
      if (tokens === undefined) continue;
      const argv = stripPrefixes(words(tokens));
      if (argv[0] === 'cd') {
        const target = argv[1];
        cwd =
          target === undefined || target === '-' || target.startsWith('~')
            ? undefined
            : joinPath(cwd, target);
        continue;
      }
      if (!isSupabaseBinary(argv[0])) continue;
      invocations.push({
        commandIndex,
        argv: ['supabase', ...argv.slice(1)],
        ...(cwd === undefined ? {} : { cwd }),
      });
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
 * `--project-id`, else `--workdir`'s basename, else the `cd` directory's.
 */
function targetName(inv: SupabaseInvocation): string | undefined {
  const stack =
    flagValue(inv.argv, '--stack') ?? flagValue(inv.argv, '--project-id');
  if (stack !== undefined) return stack;
  if (flagValue(inv.argv, '--stack-id') !== undefined) return undefined;
  const workdir = flagValue(inv.argv, '--workdir');
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
