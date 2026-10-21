import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  errorMessage,
  inProjectDir,
  shellQuote,
  truncate,
} from '../lib/shell.js';

export const WORKTREE_TABLES = [
  { worktree: 'feature-a', table: 'widgets' },
  { worktree: 'feature-b', table: 'gadgets' },
  { worktree: 'feature-c', table: 'gizmos' },
] as const;

export type WorktreeTable = (typeof WORKTREE_TABLES)[number];
export type Worktree = WorktreeTable['worktree'];
export const WORKTREES: readonly Worktree[] = WORKTREE_TABLES.map(
  (entry) => entry.worktree
);
export type WorktreeDirs = Partial<Record<Worktree, string>>;

export type WorktreeEntry = {
  path: string;
  /** Full symbolic ref (`refs/heads/x`), absent when detached or bare. */
  branch?: string;
  detached: boolean;
  bare: boolean;
};

/** Parses `git worktree list --porcelain` into one entry per worktree. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const rawLine of porcelain.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('worktree ')) {
      current = {
        path: line.slice('worktree '.length),
        detached: false,
        bare: false,
      };
      entries.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'bare') {
      current.bare = true;
    }
  }
  return entries;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/**
 * Matches `names` against a repo's worktrees by path basename and requires
 * each to be on its own branch. `problems` is empty when everything lines up.
 */
export function matchWorktrees(
  entries: readonly WorktreeEntry[],
  names: readonly string[]
): {
  matched: Record<string, WorktreeEntry | undefined>;
  problems: string[];
} {
  const matched: Record<string, WorktreeEntry | undefined> = {};
  const problems: string[] = [];
  for (const name of names) {
    const entry = entries.find((e) => basename(e.path) === name);
    matched[name] = entry;
    if (!entry) {
      problems.push(`no worktree named ${name}`);
    } else if (entry.bare) {
      problems.push(`${name} is a bare worktree`);
    } else if (entry.detached || !entry.branch) {
      problems.push(`${name} is not checked out on a branch`);
    }
  }
  const branches = names
    .map((name) => matched[name]?.branch)
    .filter((b): b is string => typeof b === 'string');
  const duplicates = branches.filter((b, i) => branches.indexOf(b) !== i);
  for (const dup of new Set(duplicates)) {
    problems.push(`more than one worktree is on ${dup}`);
  }
  return { matched, problems };
}

/**
 * Directory owning a `.git` entry reported by `find` (`/ws/repo/.git` →
 * `/ws/repo`). Both a `.git` directory and a linked worktree's `.git` file
 * let `git worktree list` enumerate every worktree of the repo.
 */
export function repoDirFromGitEntry(gitEntry: string): string {
  const trimmed = gitEntry.trim().replace(/\/+$/, '');
  if (trimmed === '.git') return '.';
  const parent = trimmed.replace(/\/\.git$/, '');
  return parent.length > 0 ? parent : '/';
}

export type RepoCandidate = { repoDir: string; entries: WorktreeEntry[] };

function matchScore(
  { entries }: RepoCandidate,
  names: readonly string[]
): number {
  const { matched, problems } = matchWorktrees(entries, names);
  const found = names.filter((name) => matched[name] !== undefined).length;
  return found * 2 + (problems.length === 0 ? 1 : 0);
}

/** The repo whose worktrees best match `names`; ties go to the lexicographically first directory. */
export function pickRepo(
  candidates: readonly RepoCandidate[],
  names: readonly string[]
): RepoCandidate | undefined {
  return [...candidates].sort(
    (a, b) =>
      matchScore(b, names) - matchScore(a, names) ||
      a.repoDir.localeCompare(b.repoDir)
  )[0];
}

async function findRepoCandidates(
  ctx: Pick<LocalStackEvalContext, 'exec'>
): Promise<{ candidates: RepoCandidate[]; failures: string[] }> {
  const found = await ctx.exec(
    `find "$(pwd -P)" -mindepth 1 -maxdepth 4 \\( -type d -o -type f \\) -name .git -not -path '*/node_modules/*' -not -path '*/.agents/*' -not -path '*/.claude/*' -not -path '*/.codex/*' 2>/dev/null | sort`
  );
  const repoDirs = [
    ...new Set(
      found.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map(repoDirFromGitEntry)
    ),
  ];
  const candidates: RepoCandidate[] = [];
  const failures: string[] = [];
  for (const repoDir of repoDirs) {
    const list = await ctx.exec(
      inProjectDir(repoDir, 'git worktree list --porcelain 2>&1')
    );
    if (list.ok) {
      candidates.push({ repoDir, entries: parseWorktreeList(list.stdout) });
    } else {
      failures.push(
        `git worktree list failed in ${repoDir}: ${truncate((list.stderr || list.stdout).trim(), 200)}`
      );
    }
  }
  return { candidates, failures };
}

/** A same-named directory under the workspace, for a worktree git does not know about; the first in sorted order. */
async function findWorktreeDir(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  name: string
): Promise<string | undefined> {
  const result = await ctx.exec(
    `find "$(pwd -P)" -mindepth 1 -maxdepth 3 -type d -name ${shellQuote(name)} -not -path '*/node_modules/*' -not -path '*/.git/*' | sort | head -n 1`
  );
  const dir = result.stdout.trim();
  return result.ok && dir ? dir : undefined;
}

/**
 * Asks git, not the filesystem, where the worktrees are: agents have put them
 * outside the workspace, and `git worktree list` reports them by absolute
 * path. Their directories drive every later check.
 */
export async function checkWorktrees(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  names: readonly Worktree[] = WORKTREES
): Promise<{ check: CheckResult; dirs: WorktreeDirs }> {
  const name = `git worktrees ${names.join(', ')} exist on distinct branches`;
  const dirs: WorktreeDirs = {};
  try {
    const { candidates, failures } = await findRepoCandidates(ctx);
    const repo = pickRepo(candidates, names);
    const matched = repo ? matchWorktrees(repo.entries, names) : undefined;
    for (const worktree of names) {
      dirs[worktree] =
        matched?.matched[worktree]?.path ??
        (await findWorktreeDir(ctx, worktree));
    }
    if (!repo || !matched) {
      return {
        check: {
          name,
          passed: false,
          notes:
            failures.length > 0
              ? failures.join('; ')
              : 'no git repository in the workspace',
        },
        dirs,
      };
    }
    const { problems } = matched;
    return {
      check: {
        name,
        passed: problems.length === 0,
        notes:
          problems.length > 0
            ? `${problems.join('; ')} (repo ${repo.repoDir})`
            : names
                .map((n) => `${n} → ${matched.matched[n]?.branch}`)
                .join(', '),
      },
      dirs,
    };
  } catch (error) {
    return { check: { name, passed: false, notes: errorMessage(error) }, dirs };
  }
}
