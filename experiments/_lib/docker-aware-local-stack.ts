/**
 * A `LocalStackRuntime` that installs the latest stable/beta Supabase CLI
 * (instead of the pinned default) and, when the calling experiment passes a
 * `docker` option, stages a sandbox where the Docker daemon is unreachable
 * or the `docker` binary is absent entirely — while still offering the agent
 * the exact same tools, MCP wiring, and prompt as the stock
 * `localStackRuntime()` for a normal (Docker-available) session. Which arm
 * runs is chosen by the experiment, not read from any eval-side marker.
 */

import {
  supabaseMcpServer,
  type EvalMetadata,
  type LocalStackRuntime,
  type LocalStackSession,
  type LocalStackSessionArgs,
} from '@supabase-evals/core';
import {
  buildLocalStackScoringContext,
  buildLocalStackTools,
  buildSkillsPrompt,
  buildToolSurfaceAddendum,
  computeExcludedServices,
  DockerSandbox,
  ensureSupabaseSandboxImage,
  installSkills,
  installSupabaseCli,
  localStackRuntime,
  toAgentSandbox,
  type SupabaseService,
} from '@supabase-evals/sandbox';
import { resolveCliVersion, type CliChannel } from './cli-channel.js';

/** Runs only evals that exercise the real CLI (never hosted-linked ones, which seed .temp pins instead). */
export function skipUnlessCli(ev: {
  id: string;
  metadata: EvalMetadata;
}): boolean {
  return ev.metadata.interface !== 'cli' || ev.metadata.hostedProject === true;
}

/** A Docker-less sandbox can only run evals that declare they need no Docker and don't expect a pre-started stack. */
export function skipUnlessDockerless(ev: {
  id: string;
  metadata: EvalMetadata;
}): boolean {
  return (
    skipUnlessCli(ev) ||
    ev.metadata.needsDocker !== false ||
    ev.metadata.projectRunning !== false
  );
}

export type DockerState = 'available' | 'no-daemon' | 'absent';

// CLI eval scorers duplicate this schema rather than import it, so evals stay
// self-contained; keep them in sync. Scorers should only read `channel` and
// `sessionStartedMs` — never `docker` (what the experiment staged) to decide
// pass/fail, or the eval would be grading against its own environment.
export const RUNTIME_MARKER_PATH = '/tmp/supabase-eval-runtime.json';

export type RuntimeMarker = {
  runtime: 'docker-aware-local-stack';
  channel: CliChannel;
  cliVersion: string;
  docker: DockerState;
  sessionStartedMs: number;
};

const SUPABASE_SHIM_PATH = '/usr/local/sbin/supabase';
const DOCKER_SHIM_PATH = '/usr/local/sbin/docker';

// Port 1 is never bound (the CLI's own e2e suite reserves it for exactly this
// purpose); not 2375, which Docker Desktop can legitimately expose.
const UNREACHABLE_DOCKER_HOST = 'tcp://127.0.0.1:1';

export function dockerAwareLocalStackRuntime(options: {
  channel: CliChannel;
  docker?: DockerState;
}): LocalStackRuntime {
  const { channel } = options;
  const docker = options.docker ?? 'available';
  return {
    id:
      docker === 'available'
        ? `local-stack-cli-${channel}`
        : `local-stack-cli-${channel}-${docker}`,
    async startSession(
      args: LocalStackSessionArgs
    ): Promise<LocalStackSession> {
      // Stamped before setup so it's comparable with the scorer's PID-1 fallback.
      const sessionStartedMs = Date.now();
      const state = docker;
      // An eval's own `cliVersion:` frontmatter still wins over the channel,
      // same precedence as the stock local-stack runtime.
      const version = args.cliVersion ?? (await resolveCliVersion(channel));
      console.log(
        `[docker-aware-local-stack] channel=${channel} cliVersion=${version} docker=${state}`
      );

      if (state === 'available') {
        const session = await localStackRuntime({
          cliVersion: version,
        }).startSession(args);
        try {
          // The scoring context's exec has no root access inside the
          // sandbox, so this marker is agent-writable — fine here since it's
          // metrics-only, unlike the docker-less path's root-owned marker.
          await writeRuntimeMarker(
            (command) => session.scoringContext.exec(command),
            buildRuntimeMarker(channel, version, state, sessionStartedMs)
          );
        } catch (err) {
          await session.close();
          throw err;
        }
        return session;
      }

      if (args.projectRunning !== false) {
        throw new Error(
          'docker-less sandbox evals must set `projectRunning: false`; the harness cannot pre-start a stack without Docker'
        );
      }
      if (args.hosted) {
        throw new Error(
          'docker-less sandbox evals cannot link a hosted project — set hostedProject: false'
        );
      }

      const image = await ensureSupabaseSandboxImage();
      const sandbox = await DockerSandbox.create({
        image,
        network: 'host',
        mounts: args.mounts,
        mountDockerSocket: false,
      });

      try {
        if (!args.skipCliInstall) {
          await installSupabaseCli(sandbox, version);
        }

        // Deliberately no socket-group grant here: CI's sandbox already ends
        // its Docker setup with `chmod 666 /var/run/docker.sock`, so the grant
        // would be a no-op there — DOCKER_HOST below is the real mechanism.
        // For `absent`, a real Docker-less host wouldn't have DOCKER_HOST set
        // at all — but leaving it set here costs nothing and blocks any
        // future accidental socket exposure, so it stays for both states.
        sandbox.extraEnv = {
          ...sandbox.extraEnv,
          DOCKER_HOST: UNREACHABLE_DOCKER_HOST,
        };

        if (!args.skipCliInstall) {
          await installSupabaseShim(sandbox, args.includeServices);
        }

        // Captured before removal: no-daemon's shim echoes this for `docker
        // --version` so the CLI's #6563 runtime probe still picks Docker.
        let dockerVersion = '';
        if (state === 'no-daemon') {
          dockerVersion = (
            await sandbox.runShellAsRoot('docker --version')
          ).stdout.trim();
          if (!dockerVersion) {
            throw new Error(
              'failed to capture `docker --version` before removing the real binary'
            );
          }
        }

        // Assert the postcondition instead of trusting `rm -f`, which always exits 0.
        const removal = await sandbox.runShellAsRoot(
          'for b in docker dockerd docker-proxy; do p="$(command -v "$b" 2>/dev/null)" && rm -f "$p"; done; ! command -v docker >/dev/null 2>&1'
        );
        if (!removal.ok) {
          throw new Error(
            `docker is still on PATH after removal: ${removal.stderr || removal.stdout}`
          );
        }

        // The root shell above has a different PATH than the agent's
        // SANDBOX_PATH, so also assert the binary is gone from the PATH the
        // agent actually runs commands under.
        const pathCheck = await sandbox.runShell(
          '! command -v docker >/dev/null 2>&1'
        );
        if (!pathCheck.ok) {
          throw new Error(
            `docker is still on the agent's PATH after removal: ${pathCheck.stderr || pathCheck.stdout}`
          );
        }

        if (state === 'no-daemon') {
          await installDockerDaemonShim(sandbox, dockerVersion);
        }

        if (args.localDir) {
          await sandbox.copyToContainer(args.localDir, sandbox.workdir);
        }
        const skills = await installSkills(sandbox, args.skills ?? []);

        // With no bind mount, the socket must not exist at all — a stronger
        // guarantee than the old warn-probe that merely checked reachability.
        const socketAbsent = await sandbox.runShellAsRoot(
          'test ! -e /var/run/docker.sock'
        );
        if (!socketAbsent.ok) {
          throw new Error(
            'the Docker socket unexpectedly exists in a Docker-less sandbox'
          );
        }

        // Root-owned and read-only so the agent cannot rewrite it to fake
        // the environment it's being evaluated in.
        await sandbox.writeRootFile(
          RUNTIME_MARKER_PATH,
          JSON.stringify(
            buildRuntimeMarker(channel, version, state, sessionStartedMs)
          ),
          '0444'
        );

        return {
          tools: buildLocalStackTools(sandbox),
          sandbox: toAgentSandbox(sandbox),
          mcpServers: {
            supabase: (
              await supabaseMcpServer({ features: ['docs'] }).createConfig(
                undefined
              )
            ).config,
          },
          promptAddendum: [
            buildToolSurfaceAddendum(args.agent, {
              skipCliInstall: args.skipCliInstall,
            }),
            buildSkillsPrompt(args.agent, skills),
          ]
            .filter(Boolean)
            .join('\n\n'),
          scoringContext: buildLocalStackScoringContext(sandbox),
          exportWorkspace: (hostDir: string) =>
            sandbox.copyToHost(sandbox.workdir, hostDir),
          // Nothing to restore without Docker; the `available` path above
          // delegates to the stock session, which has its own ensureReady.
          ensureReady: async () => {},
          // No teardownSupabaseProject: nothing can have started without Docker.
          close: () => sandbox.stop(),
        };
      } catch (err) {
        await sandbox.stop();
        throw err;
      }
    },
  };
}

function buildRuntimeMarker(
  channel: CliChannel,
  cliVersion: string,
  docker: DockerState,
  sessionStartedMs: number
): RuntimeMarker {
  return {
    runtime: 'docker-aware-local-stack',
    channel,
    cliVersion,
    docker,
    sessionStartedMs,
  };
}

async function writeRuntimeMarker(
  exec: (
    command: string
  ) => Promise<{ ok: boolean; stdout: string; stderr: string }>,
  marker: RuntimeMarker
): Promise<void> {
  // base64 transport sidesteps quoting the JSON payload through the shell.
  const encoded = Buffer.from(JSON.stringify(marker), 'utf-8').toString(
    'base64'
  );
  const result = await exec(
    `echo ${encoded} | base64 -d > ${RUNTIME_MARKER_PATH}`
  );
  if (!result.ok) {
    throw new Error(
      `failed to write the runtime marker: ${result.stderr || result.stdout}`
    );
  }
}

async function installSupabaseShim(
  sandbox: DockerSandbox,
  includeServices: readonly string[] | undefined
): Promise<void> {
  const real = (
    await sandbox.runShellAsRoot('command -v supabase')
  ).stdout.trim();
  if (!real || real === SUPABASE_SHIM_PATH) {
    throw new Error(
      `could not resolve the real supabase binary before installing the CLI shim (got ${JSON.stringify(real)})`
    );
  }
  const excluded = computeExcludedServices(includeServices);
  await sandbox.writeRootFile(
    SUPABASE_SHIM_PATH,
    buildSupabaseShimScript(real, excluded),
    '0755'
  );
}

export function buildSupabaseShimScript(
  realBin: string,
  excluded: readonly SupabaseService[]
): string {
  const lines = [
    '#!/bin/bash',
    `export DOCKER_HOST=${UNREACHABLE_DOCKER_HOST}`,
    `REAL=${shellQuote(realBin)}`,
  ];
  if (excluded.length > 0) {
    lines.push(
      `if [ "$1" = "start" ]; then shift; exec "$REAL" start "$@" -x ${excluded.join(',')}; fi`
    );
  }
  lines.push('exec "$REAL" "$@"');
  return lines.join('\n');
}

async function installDockerDaemonShim(
  sandbox: DockerSandbox,
  dockerVersion: string
): Promise<void> {
  await sandbox.writeRootFile(
    DOCKER_SHIM_PATH,
    buildDockerDaemonShimScript(dockerVersion),
    '0755'
  );
}

export function buildDockerDaemonShimScript(dockerVersion: string): string {
  return [
    '#!/bin/bash',
    'case "$1" in',
    // --version must keep working so the CLI's new managed stack still
    // *chooses* Docker as its runtime (per supabase/cli#6563's probe).
    `  --version|-v) echo ${shellQuote(dockerVersion)}; exit 0 ;;`,
    'esac',
    `echo "Cannot connect to the Docker daemon at ${UNREACHABLE_DOCKER_HOST}. Is the docker daemon running?" >&2`,
    'exit 1',
  ].join('\n');
}

// Same implementation as packages/sandbox/src/local-stack-runtime.ts's.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
