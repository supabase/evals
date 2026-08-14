/**
 * Warm-boot snapshots: pre-bake everything a per-pair VM spends its cold setup
 * on — docker, pnpm + node_modules, the agent sandbox base image, and the
 * pulled Supabase stack images — into a Vercel Sandbox snapshot, so per-pair
 * VMs boot from it and only restart dockerd, fetch the target revision, and
 * reconcile any dependency drift.
 *
 * The build is a one-shot: `ensureSnapshot` provisions a builder VM, runs the
 * same cold-boot steps a pair does (`coldProvision`) plus the two image bakes,
 * tears the prewarmed stack fully down so only *images* survive into the
 * snapshot (a leftover container/volume/network would change the environment a
 * warm-booted agent sees), and snapshots the filesystem.
 *
 * `@vercel/sandbox@3`'s `listSnapshots` can't filter by name, so cross-run
 * reuse is done by passing the returned id back via `--snapshot-id` rather than
 * rediscovering it here.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SKILLS_CLI_VERSION,
  SUPABASE_CLI_VERSION,
} from '@supabase-evals/sandbox';
import {
  SANDBOX_CWD,
  coldProvision,
  createSandbox,
  errorMessage,
  runSandboxCommand,
  vercelCredentialsFromEnv,
} from './vercel-sandbox.js';

/** Bump to invalidate the key when the builder steps themselves change. */
const BUILDER_VERSION = '1';
/** One-time builder budget; the Supabase image pulls dominate it. */
const BUILDER_TIMEOUT_MS = 30 * 60 * 1_000;
const LABEL = '[snapshot]';

export interface EnsureSnapshotOptions {
  root: string;
  repoUrl: string;
  revision: string;
  vcpus: number;
}

/**
 * Fingerprint of everything the snapshot's contents depend on: the dependency
 * tree, the agent image definition + its pinned versions, and the builder
 * itself. Used only to name the builder VM (a per-pair `pnpm install`
 * reconciles any drift between this and the run's revision).
 */
export function computeSnapshotKey(root: string): string {
  return createHash('sha256')
    .update(`builder:${BUILDER_VERSION}\n`)
    .update(`supabase:${SUPABASE_CLI_VERSION}\n`)
    .update(`skills:${SKILLS_CLI_VERSION}\n`)
    .update(readFileSync(join(root, 'packages/sandbox/Dockerfile')))
    .update(readFileSync(join(root, 'pnpm-lock.yaml')))
    .digest('hex')
    .slice(0, 12);
}

/**
 * Build a warm-boot snapshot and return its id, or undefined on any failure —
 * the snapshot is an optimization, never a requirement, so the caller falls
 * back to cold git-source boots.
 */
export async function ensureSnapshot(
  options: EnsureSnapshotOptions
): Promise<string | undefined> {
  try {
    // The key names the builder for traceability; a random suffix keeps repeat
    // builds from colliding on the (still-lingering) previous builder's name —
    // v3 can't resolve snapshots by name anyway, so uniqueness costs nothing.
    const suffix = Math.random().toString(36).slice(2, 8);
    const name = `evals-snap-${computeSnapshotKey(options.root)}-${suffix}`;
    console.log(`${LABEL} building warm-boot snapshot ${name} (~3-10m, one-time)`);
    const start = Date.now();
    const id = await buildSnapshot(name, options);
    const minutes = Math.round((Date.now() - start) / 60_000);
    console.log(`${LABEL} built ${id} in ${minutes}m — reuse with --snapshot-id`);
    return id;
  } catch (error) {
    console.warn(
      `${LABEL} unavailable, falling back to cold boots: ${errorMessage(error)}`
    );
    return undefined;
  }
}

async function buildSnapshot(
  name: string,
  options: EnsureSnapshotOptions
): Promise<string> {
  const sandbox = await createSandbox(LABEL, {
    ...vercelCredentialsFromEnv(),
    name,
    runtime: 'node24',
    source: {
      type: 'git',
      url: options.repoUrl,
      revision: options.revision,
      depth: 1,
    },
    resources: { vcpus: options.vcpus },
    timeout: BUILDER_TIMEOUT_MS,
    // Bound this builder to a single retained snapshot (belt-and-braces against
    // an auto-snapshot-on-stop landing alongside our explicit one).
    keepLastSnapshots: { count: 1 },
    tags: {
      runner: 'supabase-evals',
      run: process.env.GITHUB_RUN_ID ?? 'local',
      purpose: 'snapshot-builder',
    },
  });
  console.log(`${LABEL} builder sandbox ${sandbox.name} created`);
  try {
    // The exact cold-boot provisioning a per-pair VM does, so a warm boot only
    // adds the target-revision checkout on top of an identical base.
    await coldProvision(sandbox, LABEL);

    // --- The two bakes that make warm boots pay off. ---
    // The exact tag + build args ensureSupabaseSandboxImage uses, so its
    // `docker image inspect` is a cache hit at eval time.
    await runSandboxCommand(sandbox, LABEL, 'build agent image', {
      cmd: 'bash',
      args: [
        '-c',
        `docker build --build-arg SKILLS_CLI_VERSION=${SKILLS_CLI_VERSION} ` +
          `--tag supabase-evals-sandbox:base-skills-${SKILLS_CLI_VERSION} ` +
          `- < packages/sandbox/Dockerfile`,
      ],
      cwd: SANDBOX_CWD,
      timeoutMs: 10 * 60 * 1_000,
    });
    // Pre-pull the Supabase stack: the pinned CLI on the VM host runs a
    // throwaway `supabase start` (pulls every service image into the daemon,
    // which is snapshotted). The VM is Amazon Linux (rpm); the agent container
    // is Debian (.deb) — same pinned version, so the same image tags get
    // pulled and the agent's own `supabase start` is a cache hit.
    await runSandboxCommand(sandbox, LABEL, 'install supabase CLI', {
      cmd: 'bash',
      args: [
        '-c',
        `ARCH="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" && ` +
          `curl -fsSL "https://github.com/supabase/cli/releases/download/v${SUPABASE_CLI_VERSION}/supabase_${SUPABASE_CLI_VERSION}_linux_$ARCH.rpm" -o /tmp/supabase.rpm && ` +
          `rpm -i /tmp/supabase.rpm && rm /tmp/supabase.rpm`,
      ],
      sudo: true,
      timeoutMs: 2 * 60 * 1_000,
    });
    await runSandboxCommand(sandbox, LABEL, 'prewarm supabase images', {
      cmd: 'bash',
      args: [
        '-c',
        'mkdir -p /tmp/prewarm && cd /tmp/prewarm && supabase init && supabase start && supabase stop --no-backup && cd / && rm -rf /tmp/prewarm',
      ],
      timeoutMs: 15 * 60 * 1_000,
    });

    // Fidelity guard: only *images* may survive into the snapshot. Force-remove
    // any container/volume/network the prewarm left so a warm-booted agent gets
    // the same clean daemon a cold boot would (no port clashes, stale state, or
    // pre-existing project). Images are kept — that's the whole point.
    await runSandboxCommand(sandbox, LABEL, 'reset docker state', {
      cmd: 'bash',
      args: [
        '-c',
        'docker ps -aq | xargs -r docker rm -f\n' +
          'docker volume ls -q | xargs -r docker volume rm -f\n' +
          'docker network prune -f\n' +
          'remaining="$(docker ps -aq)"; if [ -n "$remaining" ]; then echo "containers survived prewarm: $remaining" >&2; exit 1; fi',
      ],
      timeoutMs: 2 * 60 * 1_000,
    });
    // Nothing run-specific may live in the snapshot.
    await runSandboxCommand(sandbox, LABEL, 'scrub', {
      cmd: 'bash',
      args: ['-c', 'rm -f .env /tmp/eval-results.tgz /tmp/step-*'],
      cwd: SANDBOX_CWD,
      timeoutMs: 30_000,
    });

    console.log(`${LABEL} snapshotting (stops the builder)…`);
    const snapshot = await sandbox.snapshot();
    return snapshot.snapshotId;
  } catch (error) {
    // snapshot() stops the sandbox on success; on failure stop it ourselves.
    await sandbox.stop().catch(() => undefined);
    throw error;
  }
}
