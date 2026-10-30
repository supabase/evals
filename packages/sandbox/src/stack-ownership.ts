/**
 * Which local Supabase stacks an eval session owns, so every run starts from a
 * fresh database and teardown removes what the session created.
 *
 * `supabase stop --no-backup` can't do this on its own. Inside the sandbox
 * (Docker client 20.10, API 1.41) CLI 2.117.0 removes the containers, then
 * exits 1 with "failed to prune volumes" (CLI-2637), leaving the database
 * volume and network behind. The next `supabase start` under the same project
 * id finds the volume and boots from it ("Starting database from backup..."),
 * so a later run inherits the earlier agent's schema, grants and migration
 * history. Project ids are fixed per fixture (`project_id` in config.toml,
 * several shared across evals) or, when linked to platform-lite, the fixed
 * hosted ref, so the leak crosses runs and evals alike.
 *
 * The harness therefore removes a stack's containers, volumes and networks
 * itself, by the CLI's project label, through the host Docker CLI:
 *
 *  - Setup claims the project ids the seeded workspace resolves to. Leftovers
 *    under a claimed id are removed when the host-side ledger records the id
 *    as harness-owned (or it's a `sandbox-` id); otherwise they may belong to
 *    a developer's own stack, so setup fails with the commands to remove them
 *    rather than run on that data or delete it.
 *  - Teardown removes the claimed ids, plus ids the workspace resolves to by
 *    then that had no resources when the session began (stacks the agent
 *    started itself).
 *
 * The ledger keeps an id until its resources are confirmed gone, so a run
 * killed before teardown (Ctrl-C) is cleaned up by the next session that
 * claims the id.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { type DockerSandbox, dockerCli } from './docker-sandbox.js';

/** The label the Supabase CLI puts on a stack's containers, volumes and networks. */
export const CLI_PROJECT_LABEL = 'com.supabase.cli.project';

/** Project ids that are eval-owned by construction (`supabase init` in a sandbox workspace). */
const SANDBOX_PROJECT_ID_PREFIX = 'sandbox-';

/**
 * Host-side record of project ids the harness has started stacks under. One
 * empty file per id, so concurrent harness processes never rewrite a shared
 * file.
 */
const STACK_LEDGER_DIR = join(
  homedir(),
  '.cache',
  'supabase-evals',
  'local-stacks'
);

interface StackClaim {
  /** Project ids claimed at setup; their resources are this session's. */
  claimed: ReadonlySet<string>;
  /** Project ids with resources on the daemon when the session began. */
  preexisting: ReadonlySet<string>;
}

const claims = new WeakMap<DockerSandbox, StackClaim>();

/**
 * The session holding each claimed id in this process; sessions can't share a
 * stack. A claim whose sandbox has stopped (`id` empty) no longer counts.
 */
const activeClaims = new Map<string, DockerSandbox>();

function claimedByOther(projectId: string, sandbox: DockerSandbox): boolean {
  const owner = activeClaims.get(projectId);
  return owner !== undefined && owner !== sandbox && owner.id !== '';
}

/** Whether setup claimed this sandbox's stacks (and so teardown may stop them). */
export function hasStackClaim(sandbox: DockerSandbox): boolean {
  return claims.has(sandbox);
}

/**
 * Lists every `supabase/config.toml` under the workspace with its
 * `project_id` line, one `<path>\t<line>` per file. node_modules is pruned.
 */
const LIST_PROJECT_CONFIGS =
  "find . -name node_modules -prune -o -path '*/supabase/config.toml' -type f -print | " +
  `while IFS= read -r f; do printf '%s\\t%s\\n' "$f" "$(grep -m1 -E '^[[:space:]]*project_id[[:space:]]*=' "$f")"; done`;

/**
 * The project ids the CLI would use for each config in a
 * {@link LIST_PROJECT_CONFIGS} listing: `$SUPABASE_PROJECT_ID` when set (it
 * overrides config.toml), else the config's `project_id`, else the basename of
 * the directory holding `supabase/` (the CLI's default).
 */
export function parseProjectIds(
  listing: string,
  workdir: string,
  envProjectId?: string
): string[] {
  const ids = new Set<string>();
  for (const line of listing.split('\n')) {
    if (!line.trim()) continue;
    if (envProjectId) {
      ids.add(envProjectId);
      continue;
    }
    const [path = '', setting = ''] = line.split('\t');
    const value = /^\s*project_id\s*=\s*(["'])(.*?)\1/.exec(setting)?.[2];
    if (value) {
      ids.add(value);
      continue;
    }
    const projectDir = dirname(dirname(path));
    ids.add(projectDir === '.' ? basename(workdir) : basename(projectDir));
  }
  return [...ids];
}

/** Project ids the sandbox workspace's configs resolve to. */
export async function workspaceProjectIds(
  sandbox: DockerSandbox
): Promise<string[]> {
  const listing = await sandbox.runShell(LIST_PROJECT_CONFIGS);
  if (!listing.ok) {
    throw new Error(
      `failed to list the workspace's Supabase configs: ${listing.stderr}`
    );
  }
  return parseProjectIds(
    listing.stdout,
    sandbox.workdir,
    sandbox.extraEnv.SUPABASE_PROJECT_ID
  );
}

function lines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Project ids that have any CLI-labelled container, volume or network on the daemon. */
async function daemonProjectIds(): Promise<Set<string>> {
  const format = `{{.Label "${CLI_PROJECT_LABEL}"}}`;
  const ids = new Set<string>();
  for (const list of [
    ['ps', '-a'],
    ['volume', 'ls'],
    ['network', 'ls'],
  ]) {
    const result = await dockerCli([
      ...list,
      '--filter',
      `label=${CLI_PROJECT_LABEL}`,
      '--format',
      format,
    ]);
    if (!result.ok) {
      throw new Error(
        `failed to list local Supabase stacks (docker ${list.join(' ')}): ${result.stderr}`
      );
    }
    for (const id of lines(result.stdout)) ids.add(id);
  }
  return ids;
}

/** `[kind, list args, remove args]` for each resource type a stack owns. */
const STACK_RESOURCES = [
  ['container', ['ps', '-aq'], ['rm', '-f', '-v']],
  ['volume', ['volume', 'ls', '-q'], ['volume', 'rm', '-f']],
  ['network', ['network', 'ls', '-q'], ['network', 'rm']],
] as const;

/**
 * Remove a project's containers, then volumes, then networks (each in use by
 * the one before) through the host Docker CLI. Returns what is left, as
 * `<kind> <id>` entries, so callers can tell whether the stack is gone.
 */
export async function removeStackResources(
  projectId: string
): Promise<string[]> {
  const filter = ['--filter', `label=${CLI_PROJECT_LABEL}=${projectId}`];
  const remaining: string[] = [];
  for (const [kind, list, remove] of STACK_RESOURCES) {
    const listed = await dockerCli([...list, ...filter]);
    const ids = lines(listed.stdout);
    if (ids.length > 0) await dockerCli([...remove, ...ids]);
    const after = await dockerCli([...list, ...filter]);
    if (!after.ok) {
      remaining.push(`${kind} listing failed: ${after.stderr.trim()}`);
    }
    for (const id of lines(after.stdout)) remaining.push(`${kind} ${id}`);
  }
  return remaining;
}

function ledgerPath(projectId: string): string {
  return join(STACK_LEDGER_DIR, encodeURIComponent(projectId));
}

function ledgerHas(projectId: string): boolean {
  return existsSync(ledgerPath(projectId));
}

function ledgerAdd(projectId: string): void {
  mkdirSync(STACK_LEDGER_DIR, { recursive: true });
  writeFileSync(ledgerPath(projectId), '');
}

function ledgerDelete(projectId: string): void {
  rmSync(ledgerPath(projectId), { force: true });
}

/**
 * Split the ids a session is about to use by what already exists for them:
 * leftovers the harness owns (`remove`) and resources it can't vouch for
 * (`conflicts`). Ids with nothing on the daemon need neither.
 */
export function planStackClaim(
  ids: readonly string[],
  existing: ReadonlySet<string>,
  isHarnessOwned: (projectId: string) => boolean
): { remove: string[]; conflicts: string[] } {
  const remove: string[] = [];
  const conflicts: string[] = [];
  for (const id of ids) {
    if (!existing.has(id)) continue;
    if (id.startsWith(SANDBOX_PROJECT_ID_PREFIX) || isHarnessOwned(id)) {
      remove.push(id);
    } else {
      conflicts.push(id);
    }
  }
  return { remove, conflicts };
}

function conflictError(conflicts: readonly string[]): Error {
  const commands = conflicts.flatMap((id) => {
    const filter = `--filter label=${CLI_PROJECT_LABEL}=${id}`;
    return [
      `docker rm -f $(docker ps -aq ${filter})`,
      `docker volume rm $(docker volume ls -q ${filter})`,
      `docker network rm $(docker network ls -q ${filter})`,
    ];
  });
  const ids = conflicts.map((id) => JSON.stringify(id)).join(', ');
  return new Error(
    `Docker already has local Supabase stack resources for project id ${ids}, ` +
      "which this eval's workspace uses, so the run would start on " +
      'their database. The harness has no record of starting them (they may be ' +
      'your own stack, or left over from a run before the harness tracked its ' +
      'stacks), so it will not remove them. If they are disposable, remove them ' +
      `and rerun:\n  ${commands.join('\n  ')}`
  );
}

/**
 * Claim the project ids the seeded workspace resolves to, before anything
 * starts: remove harness-owned leftovers under them, refuse to run on
 * anything else, and record them in the ledger so a run killed before
 * teardown is still cleaned up next time.
 */
export async function claimWorkspaceStacks(
  sandbox: DockerSandbox
): Promise<void> {
  const ids = await workspaceProjectIds(sandbox);
  const busy = ids.filter((id) => claimedByOther(id, sandbox));
  if (busy.length > 0) {
    throw new Error(
      `project id ${busy.join(', ')} is in use by another session in this process; ` +
        'local-stack sessions sharing a project id cannot run concurrently'
    );
  }

  const existing = await daemonProjectIds();
  const { remove, conflicts } = planStackClaim(ids, existing, ledgerHas);
  if (conflicts.length > 0) throw conflictError(conflicts);
  for (const id of remove) {
    const remaining = await removeStackResources(id);
    if (remaining.length > 0) {
      throw new Error(
        `failed to remove leftovers of local Supabase stack ${JSON.stringify(id)}: ${remaining.join(', ')}`
      );
    }
    existing.delete(id);
  }

  for (const id of ids) {
    ledgerAdd(id);
    activeClaims.set(id, sandbox);
  }
  claims.set(sandbox, { claimed: new Set(ids), preexisting: existing });
}

/**
 * Remove the claimed stacks' resources, keeping the claim. For resetting a
 * partial stack between `supabase start` attempts, which would otherwise
 * boot from the failed attempt's volume.
 */
export async function resetClaimedStacks(
  sandbox: DockerSandbox
): Promise<void> {
  for (const id of claims.get(sandbox)?.claimed ?? []) {
    await removeStackResources(id);
  }
}

/**
 * Remove every stack this session owns and release its claim. Best-effort:
 * an id whose resources survive stays in the ledger for the next session
 * that claims it.
 */
export async function releaseWorkspaceStacks(
  sandbox: DockerSandbox
): Promise<void> {
  const claim = claims.get(sandbox);
  if (!claim) return;
  claims.delete(sandbox);

  const ids = new Set(claim.claimed);
  try {
    for (const id of await workspaceProjectIds(sandbox)) {
      // Never another live session's stack, nor one that predates this one.
      if (!claim.preexisting.has(id) && !claimedByOther(id, sandbox)) {
        ids.add(id);
      }
    }
  } catch (err) {
    console.warn(
      '[sandbox] could not list the workspace configs at teardown (removing the claimed stacks only):',
      err instanceof Error ? err.message : err
    );
  }

  for (const id of ids) {
    try {
      ledgerAdd(id);
      const remaining = await removeStackResources(id);
      if (remaining.length === 0) {
        ledgerDelete(id);
      } else {
        console.warn(
          `[sandbox] local Supabase stack ${JSON.stringify(id)} was not fully removed (the next session claiming it will retry): ${remaining.join(', ')}`
        );
      }
    } catch (err) {
      console.warn(
        `[sandbox] removing local Supabase stack ${JSON.stringify(id)} failed (the next session claiming it will retry):`,
        err instanceof Error ? err.message : err
      );
    }
  }
  for (const id of claim.claimed) {
    if (activeClaims.get(id) === sandbox) activeClaims.delete(id);
  }
}
