/**
 * Warm-boot snapshots: pre-bake everything a pair's VM spends its first ~5
 * minutes on — dnf docker, pnpm + node_modules, the agent sandbox base image,
 * and the pulled Supabase stack images — into a Vercel Sandbox snapshot, so
 * per-pair sandboxes boot from it and only need a dockerd restart plus a git
 * fetch of the target revision.
 *
 * Snapshots are keyed by their inputs: the builder sandbox is named
 * `evals-snap-<hash>` and `Snapshot.list({ name })` resolves key → snapshot,
 * so a stale key simply misses and triggers a rebuild. Expiry is Vercel's
 * default (30 days after last use), which self-renews under regular runs.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Sandbox, Snapshot } from "@vercel/sandbox";
import {
  createSandbox,
  createStepRunner,
  credentialsFromEnv,
  prefixedWriter,
  startDocker,
} from "./vm-steps.js";

/** Bump to invalidate existing snapshots when the builder steps change. */
const BUILDER_VERSION = "1";

/** Budget for the one-time builder sandbox (image pulls dominate). */
const BUILDER_TIMEOUT_MS = 30 * 60_000;

function readVersionConstant(root: string, file: string, name: string): string {
  const source = readFileSync(join(root, file), "utf8");
  const match = source.match(new RegExp(`${name} = "([^"]+)"`));
  if (!match) throw new Error(`could not read ${name} from ${file}`);
  return match[1];
}

/**
 * Everything that changes what the snapshot contains: dependency tree, the
 * agent sandbox image definition and its pinned versions, and the builder
 * itself. Computed from the local working tree — the same inputs the run's
 * revision will carry in the common case, and a per-run `pnpm install`
 * reconciles any drift.
 */
export function computeSnapshotKey(root: string): string {
  const cliVersion = readVersionConstant(
    root,
    "packages/sandbox/src/supabase.ts",
    "SUPABASE_CLI_VERSION",
  );
  const skillsVersion = readVersionConstant(
    root,
    "packages/sandbox/src/skills.ts",
    "SKILLS_CLI_VERSION",
  );
  return createHash("sha256")
    .update(`builder:${BUILDER_VERSION}\n`)
    .update(`cli:${cliVersion}\n`)
    .update(`skills:${skillsVersion}\n`)
    .update(readFileSync(join(root, "packages/sandbox/Dockerfile")))
    .update(readFileSync(join(root, "pnpm-lock.yaml")))
    .digest("hex")
    .slice(0, 12);
}

export interface EnsureSnapshotOptions {
  root: string;
  repoUrl: string;
  revision: string;
  githubToken: string;
  vcpus: number;
}

/**
 * Resolve (or build) the warm-boot snapshot for the current key. Returns
 * undefined on any failure so the caller falls back to cold git-source boots
 * — the snapshot is an optimization, never a requirement.
 */
export async function ensureSnapshot(
  options: EnsureSnapshotOptions,
): Promise<string | undefined> {
  const stdout = prefixedWriter("[snapshot]", process.stdout);
  const stderr = prefixedWriter("[snapshot]", process.stderr);
  const log = (message: string) => stdout.write(`${message}\n`);

  try {
    const key = computeSnapshotKey(options.root);
    const name = `evals-snap-${key}`;

    const existing = await findSnapshot(name);
    if (existing) {
      log(`reusing snapshot ${existing} (key ${key})`);
      return existing;
    }

    log(`no snapshot for key ${key} — building one (~10m, once per key)`);
    const start = Date.now();
    const snapshotId = await buildSnapshot(name, options, { stdout, stderr, log });
    log(
      `snapshot ${snapshotId} built in ${Math.round((Date.now() - start) / 60000)}m`,
    );
    return snapshotId;
  } catch (err) {
    stderr.write(
      `snapshot unavailable, falling back to cold boots: ${err instanceof Error ? err.message : err}\n`,
    );
    return undefined;
  } finally {
    stdout.end();
    stderr.end();
  }
}

async function findSnapshot(name: string): Promise<string | undefined> {
  const result = await Snapshot.list({ name, ...credentialsFromEnv() });
  let newest: { id: string; createdAt: number } | undefined;
  for await (const snapshot of result) {
    if (snapshot.status !== "created") continue;
    if (!newest || snapshot.createdAt > newest.createdAt) {
      newest = { id: snapshot.id, createdAt: snapshot.createdAt };
    }
  }
  return newest?.id;
}

async function buildSnapshot(
  name: string,
  options: EnsureSnapshotOptions,
  io: {
    stdout: ReturnType<typeof prefixedWriter>;
    stderr: ReturnType<typeof prefixedWriter>;
    log: (message: string) => void;
  },
): Promise<string> {
  const cliVersion = readVersionConstant(
    options.root,
    "packages/sandbox/src/supabase.ts",
    "SUPABASE_CLI_VERSION",
  );
  const skillsVersion = readVersionConstant(
    options.root,
    "packages/sandbox/src/skills.ts",
    "SKILLS_CLI_VERSION",
  );

  const sandbox = await createSandbox(
    {
      name,
      runtime: "node22",
      resources: { vcpus: options.vcpus },
      timeout: BUILDER_TIMEOUT_MS,
      // Rebuilds evict the previous key-less snapshot of the same builder
      // name; the snapshot itself never expires while in regular use.
      keepLastSnapshots: { count: 1 },
      tags: {
        runner: "supabase-evals",
        purpose: "snapshot-builder",
        run: process.env.GITHUB_RUN_ID ?? "local",
      },
      source: {
        type: "git",
        url: options.repoUrl,
        revision: options.revision,
        username: "x-access-token",
        password: options.githubToken,
      },
    },
    io.stderr,
  );
  io.log(`builder sandbox ${sandbox.name} created`);
  try {
    const run = createStepRunner(sandbox, io);
    await startDocker(sandbox, run, { install: true });
    await run(
      "checkout submodules",
      `git config --global url."https://github.com/".insteadOf "git@github.com:"\ngit submodule update --init --recursive`,
    );
    await run("install pnpm", "npm install -g pnpm@10.24.0", { sudo: true });
    await run("pnpm install", "pnpm install --frozen-lockfile");

    // The exact image ensureSupabaseSandboxImage builds per session — with
    // the tag already in the daemon, the eval-time build is a cache hit.
    await run(
      "build agent sandbox image",
      `docker build --build-arg SKILLS_CLI_VERSION=${skillsVersion} ` +
        `--tag supabase-evals-sandbox:base-skills-${skillsVersion} - < packages/sandbox/Dockerfile`,
    );

    // Pre-pull the Supabase stack by running a throwaway project once with
    // the pinned CLI: `supabase start` pulls every service image into
    // /var/lib/docker (snapshotted), then the project is torn down so no
    // containers or volumes leak into the snapshot.
    // The VM is Amazon Linux (rpm), unlike the Debian agent container which
    // installs the .deb — same pinned version, so the same image tags get
    // pulled.
    await run(
      "install supabase CLI",
      `ARCH="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" && ` +
        `curl -fsSL "https://github.com/supabase/cli/releases/download/v${cliVersion}/supabase_${cliVersion}_linux_$ARCH.rpm" -o /tmp/supabase.rpm && ` +
        `rpm -i /tmp/supabase.rpm && rm /tmp/supabase.rpm`,
      { sudo: true },
    );
    await run(
      "prewarm supabase images",
      `mkdir -p /tmp/prewarm && cd /tmp/prewarm && supabase init && supabase start && supabase stop --no-backup && cd / && rm -rf /tmp/prewarm`,
    );

    // Hygiene: nothing secret or run-specific may live in the snapshot.
    await run(
      "scrub credentials",
      `git config --global --remove-section credential 2>/dev/null || true\nrm -f ~/.git-credentials .env`,
    );
    // Step/state files from this build must not leak into warm boots (the
    // nonce in step paths already prevents collisions; this is hygiene).
    await run("scrub temp files", "rm -f /tmp/step-* /tmp/eval-results.tgz", {
      sudo: true,
    });

    io.log("snapshotting (stops the builder)…");
    const snapshot = await sandbox.snapshot();
    return snapshot.snapshotId;
  } catch (err) {
    // snapshot() stops the sandbox on success; on failure stop it ourselves.
    await sandbox.stop().catch(() => undefined);
    throw err;
  }
}
