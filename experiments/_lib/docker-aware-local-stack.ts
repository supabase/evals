/**
 * A `LocalStackRuntime` that installs the latest stable/beta Supabase CLI
 * (instead of the pinned default) and, for evals that declare a Docker-less
 * `sandbox-environment.json`, stages a sandbox where the Docker daemon is
 * unreachable or the `docker` binary is absent entirely — while still
 * offering the agent the exact same tools, MCP wiring, and prompt as the
 * stock `localStackRuntime()` for a normal (Docker-available) session.
 */

import { dirname } from 'node:path';
import {
  supabaseMcpServer,
  type LocalStackRuntime,
  type LocalStackSession,
  type LocalStackSessionArgs,
} from '@supabase-evals/core';
import {
  buildLocalStackScoringContext,
  buildLocalStackTools,
  buildSkillsPrompt,
  computeExcludedServices,
  DockerSandbox,
  ensureSupabaseSandboxImage,
  installSkills,
  installSupabaseCli,
  localStackRuntime,
  teardownSupabaseProject,
  toAgentSandbox,
  type SupabaseService,
} from '@supabase-evals/sandbox';
import { resolveCliVersion, type CliChannel } from './cli-channel.js';
import {
  readSandboxEnvironment,
  type DockerState,
} from './sandbox-environment.js';

// Schema is duplicated in evals/build-database-002-stack-lifecycle/scoring.ts
// so evals stay self-contained; keep the two in sync.
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
}): LocalStackRuntime {
  const { channel } = options;
  return {
    id: `local-stack-cli-${channel}`,
    async startSession(
      args: LocalStackSessionArgs
    ): Promise<LocalStackSession> {
      // Stamped before setup so it's comparable with the scorer's PID-1 fallback.
      const sessionStartedMs = Date.now();
      const state = args.localDir
        ? readSandboxEnvironment(dirname(args.localDir))
        : 'available';
      // An eval's own `cliVersion:` frontmatter still wins over the channel,
      // same precedence as the stock local-stack runtime.
      const version = args.cliVersion ?? (await resolveCliVersion(channel));

      if (state === 'available') {
        const session = await localStackRuntime({
          cliVersion: version,
        }).startSession(args);
        try {
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
      });

      try {
        if (!args.skipCliInstall) {
          await installSupabaseCli(sandbox, version);
        }

        // Deliberately no socket-group grant here: CI's sandbox already ends
        // its Docker setup with `chmod 666 /var/run/docker.sock`, so the grant
        // would be a no-op there — DOCKER_HOST below is the real mechanism.
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

        if (state === 'no-daemon') {
          await installDockerDaemonShim(sandbox, dockerVersion);
        }

        if (args.localDir) {
          await sandbox.copyToContainer(args.localDir, sandbox.workdir);
        }
        const skills = await installSkills(sandbox, args.skills ?? []);

        const ping = await sandbox.runShell(
          'curl -sf --unix-socket /var/run/docker.sock http://localhost/_ping'
        );
        if (ping.ok) {
          console.warn(
            '[docker-aware-local-stack] raw docker socket is reachable by the sandbox user; relying on DOCKER_HOST + shims'
          );
        }

        await writeRuntimeMarker(
          (command) => sandbox.runShell(command),
          buildRuntimeMarker(channel, version, state, sessionStartedMs)
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
            buildBaseAddendum(args.skipCliInstall),
            buildSkillsPrompt(skills),
          ]
            .filter(Boolean)
            .join('\n\n'),
          scoringContext: buildLocalStackScoringContext(sandbox),
          exportWorkspace: (hostDir: string) =>
            sandbox.copyToHost(sandbox.workdir, hostDir),
          close: async () => {
            await teardownSupabaseProject(sandbox);
            await sandbox.stop();
          },
        };
      } catch (err) {
        await sandbox.stop();
        throw err;
      }
    },
  };
}

// Copied verbatim from local-stack-runtime.ts's baseAddendum: it says docker
// is installed, and we never hint that it's actually broken.
function buildBaseAddendum(skipCliInstall: boolean | undefined): string {
  let addendum =
    'docker, psql, git, and curl are installed in the workspace. ' +
    'Use the bash tool to run commands (the working directory is always the workspace root) ' +
    'and the files tools to inspect and modify files.';

  if (!skipCliInstall) {
    addendum = 'The Supabase CLI (`supabase`), ' + addendum;
    addendum +=
      ' Services started with `supabase start` are reachable on their default 127.0.0.1 ports.';
  }

  return addendum;
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
    `REAL=${JSON.stringify(realBin)}`,
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
    '  --version|-v) echo ' + JSON.stringify(dockerVersion) + '; exit 0 ;;',
    'esac',
    `echo "Cannot connect to the Docker daemon at ${UNREACHABLE_DOCKER_HOST}. Is the docker daemon running?" >&2`,
    'exit 1',
  ].join('\n');
}
