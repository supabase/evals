import { posix } from 'node:path';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { createClient } from '@supabase/supabase-js';
import {
  supabaseMcpServer,
  type AgentHarnessId,
  type AgentSandbox,
  type HostedLink,
  type LocalStackEnvironmentMarker,
  type LocalStackRuntime,
  type LocalStackScoringContext,
  type LocalStackStatus,
  type McpServerConfig,
} from '@supabase-evals/core';
import { isRecord } from '@supabase-evals/core/json';
import { DockerSandbox } from './docker-sandbox.js';
import { createAgentEnvironment } from './agent-environment.js';
import {
  computeExcludedServices,
  ensureEdgeRuntime,
  ensureSupabaseSandboxImage,
  installSupabaseCli,
  SUPABASE_CLI_VERSION,
  teardownSupabaseProject,
} from './supabase.js';
import { buildSkillsPrompt, installSkills } from './skills.js';
import {
  isCliChannel,
  resolveCliVersionOption,
  type CliChannel,
} from './cli-channel.js';
import type { SupabaseService } from './types.js';

const DEFAULT_BASH_TIMEOUT_SEC = 240;
const MAX_BASH_TIMEOUT_SEC = 600;
const MAX_TOOL_OUTPUT_CHARS = 16_000;

/** Retry budget for reading the stack's API keys from `supabase status` (gotrue readiness lag). */
const STACK_CONFIG_RETRIES = 5;
const STACK_CONFIG_RETRY_MS = 2_000;

/**
 * The Supabase local-stack environment: a sandboxed developer machine where
 * the agent's tool — the real Supabase CLI — can run the local Docker stack.
 * Declared per experiment (like MCP servers and skills); consumed by evals
 * with `interface: cli`. Each session is a fresh sandbox.
 *
 * This deliberately does not touch the remote/hosted platform (mocked by
 * platform-lite). Hosted CLI workflows (`supabase link`, `functions deploy`,
 * `secrets set`) would pair this environment with platform-lite via a CLI
 * profile — out of scope for now.
 */
export interface LocalStackRuntimeOptions {
  /**
   * Supabase CLI version baked into the sandbox image: an exact version
   * (e.g. `2.109.1`) or a channel tag (`'stable'` | `'beta'`) resolved
   * against npm's dist-tag and memoised per process. An eval's own
   * `cliVersion:` frontmatter pin always wins over this option.
   */
  cliVersion?: CliChannel | (string & {});
  /**
   * Supabase MCP feature groups to expose to the agent when the eval links to
   * a hosted project (`hostedProject: true`). The MCP server runs host-side and
   * is pointed at the mocked hosted platform (platform-lite), so its tools act
   * on the same project the agent's CLI is linked to. Restrict this list to
   * limit the tools available. Defaults to the groups platform-lite implements
   * (`storage`/`branching` are omitted — platform-lite has no such endpoints).
   * For evals with no hosted project, the agent still gets a docs-only server
   * (`search_docs`), since the other groups need a platform to talk to.
   */
  mcpFeatures?: string[];
  /**
   * Explicit MCP server map, keyed by name. When set it overrides the default
   * Supabase MCP wiring entirely. These run host-side and do not connect to the
   * sandbox; pass `{}` to disable MCP altogether.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Docker availability to stage in the sandbox (default `'available'`).
   * `'no-daemon'` leaves `docker --version` working but unreachable;
   * `'absent'` removes the binary entirely. Both require
   * `projectRunning: false` and no hosted project link, since the harness
   * cannot pre-start a stack or link a hosted project without Docker.
   */
  docker?: DockerState;
}

/**
 * Docker's availability inside a local-stack sandbox session. See
 * {@link LocalStackRuntimeOptions.docker}.
 */
export type DockerState = 'available' | 'no-daemon' | 'absent';

/**
 * Path of the marker each session writes recording its staged environment,
 * for scorers to report, never to gate pass/fail. Agent-writable on the
 * `'available'` path (metrics-only); root-owned and read-only (0444) on the
 * Docker-less paths, so the agent can't fake the environment it's graded in.
 */
export const LOCAL_STACK_MARKER_PATH = '/tmp/supabase-eval-runtime.json';

// The shared scoring-context shape (LocalStackScoringContext.environmentMarker)
// lives in core; re-exported here so existing imports of this type from
// @supabase-evals/sandbox keep working.
export type { LocalStackEnvironmentMarker } from '@supabase-evals/core';

// Shadow the real `docker`/`supabase` binaries from the first entry on the
// sandbox PATH (see SANDBOX_PATH in docker-sandbox.ts).
const SUPABASE_SHIM_PATH = '/usr/local/sbin/supabase';
const DOCKER_SHIM_PATH = '/usr/local/sbin/docker';

// Port 1 is never bound (the CLI's own e2e suite reserves it for this too);
// not 2375, which Docker Desktop can legitimately expose.
const UNREACHABLE_DOCKER_HOST = 'tcp://127.0.0.1:1';

/**
 * Supabase MCP feature groups exposed by default: `docs` only. The sandbox has
 * no web tools, so `search_docs` is the one capability the agent otherwise
 * lacks. Every other group is withheld on purpose — these are CLI evals, and
 * exposing e.g. `functions`/`database` would let the agent bypass the very CLI
 * workflow under test (it could deploy via the MCP instead of `supabase
 * functions deploy`). Widen per experiment via `mcpFeatures` for evals that
 * genuinely want the agent to drive the platform through MCP; the
 * platform-dependent groups then require a hosted project to point at.
 */
const DEFAULT_MCP_FEATURES = ['docs'];

export function localStackRuntime(
  options: LocalStackRuntimeOptions = {}
): LocalStackRuntime {
  return {
    id: buildRuntimeId(options),
    cliChannel:
      options.cliVersion !== undefined && isCliChannel(options.cliVersion)
        ? options.cliVersion
        : undefined,
    async startSession({
      agent,
      cliVersion,
      localDir,
      includeServices,
      projectRunning,
      hosted,
      skills,
      mounts,
      skipCliInstall,
    }) {
      // Stamped before setup so it's comparable with the scorer's PID-1 fallback.
      const sessionStartedMs = Date.now();
      const docker = options.docker ?? 'available';
      // Only an unpinned eval inherits a channel; an eval's own pin always wins.
      const channel =
        cliVersion === undefined &&
        options.cliVersion !== undefined &&
        isCliChannel(options.cliVersion)
          ? options.cliVersion
          : undefined;
      const version =
        cliVersion ??
        (await resolveCliVersionOption(options.cliVersion)) ??
        SUPABASE_CLI_VERSION;

      if (docker === 'available') {
        const env = await createAgentEnvironment({
          cliVersion: version,
          localDir,
          skills,
          mounts,
          localStack: {
            includeServices,
            projectRunning,
            hosted: hosted
              ? {
                  port: hosted.port,
                  pgPort: hosted.pgPort,
                  ref: hosted.ref,
                  accessToken: hosted.accessToken,
                }
              : undefined,
            skipCliInstall,
          },
        });
        const sandbox = env.sandbox;

        const mcpServers = await resolveMcpServers(options, hosted);

        const session = {
          tools: buildLocalStackTools(sandbox, docker),
          sandbox: toAgentSandbox(sandbox),
          mcpServers,
          promptAddendum: [
            buildToolSurfaceAddendum(agent, { skipCliInstall, docker }),
            buildSkillsPrompt(agent, env.skills),
          ]
            .filter(Boolean)
            .join('\n\n'),
          scoringContext: buildLocalStackScoringContext(sandbox, hosted),
          ensureReady: () => ensureEdgeRuntime(sandbox, includeServices),
          exportWorkspace: (hostDir: string) =>
            sandbox.copyToHost(sandbox.workdir, hostDir),
          close: async () => {
            await teardownSupabaseProject(sandbox);
            await env.close();
          },
        };

        // Metrics-only and best-effort here; the Docker-less path's marker
        // is root-owned and fails hard instead.
        try {
          await writeLocalStackMarkerViaExec(
            (command) => session.scoringContext.exec(command),
            buildLocalStackMarker(docker, version, sessionStartedMs, channel)
          );
        } catch (err) {
          console.warn(
            `[local-stack] could not write ${LOCAL_STACK_MARKER_PATH}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
        return session;
      }

      // Docker-less staging: the harness cannot pre-start a stack or link a
      // hosted project without Docker.
      if (projectRunning !== false) {
        throw new Error(
          'docker-less sandbox evals must set `projectRunning: false`; the harness cannot pre-start a stack without Docker'
        );
      }
      if (hosted) {
        throw new Error(
          'docker-less sandbox evals cannot link a hosted project — set hostedProject: false'
        );
      }

      const image = await ensureSupabaseSandboxImage();
      const sandbox = await DockerSandbox.create({
        image,
        network: 'host',
        mounts,
        mountDockerSocket: false,
      });

      try {
        if (!skipCliInstall) {
          await installSupabaseCli(sandbox, version);
        }

        // No socket-group grant (unlike setupSupabaseSandbox): CI's sandbox
        // setup ends with `chmod 666 /var/run/docker.sock`, which would make
        // any permission-based restriction a no-op — DOCKER_HOST below is
        // what actually blocks access. Left set for `absent` too since it's
        // harmless and guards against future socket exposure.
        sandbox.extraEnv = {
          ...sandbox.extraEnv,
          DOCKER_HOST: UNREACHABLE_DOCKER_HOST,
        };

        if (!skipCliInstall) {
          await installSupabaseShim(sandbox, includeServices);
        }

        // Captured before removal: no-daemon's shim echoes this for `docker
        // --version` so the CLI's #6563 runtime probe still picks Docker.
        let dockerVersion = '';
        if (docker === 'no-daemon') {
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

        // The root shell's PATH differs from the agent's SANDBOX_PATH, so
        // also assert the binary is gone from the PATH the agent runs under.
        const pathCheck = await sandbox.runShell(
          '! command -v docker >/dev/null 2>&1'
        );
        if (!pathCheck.ok) {
          throw new Error(
            `docker is still on the agent's PATH after removal: ${pathCheck.stderr || pathCheck.stdout}`
          );
        }

        if (docker === 'no-daemon') {
          await installDockerDaemonShim(sandbox, dockerVersion);
        }

        if (localDir) {
          await sandbox.copyToContainer(localDir, sandbox.workdir);
        }
        const installedSkills = await installSkills(sandbox, skills ?? []);

        // No bind mount means the socket must not exist at all — stronger
        // than checking reachability from inside the container.
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
          LOCAL_STACK_MARKER_PATH,
          JSON.stringify(
            buildLocalStackMarker(docker, version, sessionStartedMs, channel)
          ),
          '0444'
        );

        const dockerlessMcpServers = await resolveMcpServers(
          options,
          undefined
        );

        return {
          tools: buildLocalStackTools(sandbox, docker),
          sandbox: toAgentSandbox(sandbox),
          // Same wiring as the `available` path; `hosted` is always
          // undefined here (guarded above), so this falls back to `docs`.
          mcpServers: dockerlessMcpServers,
          promptAddendum: [
            buildToolSurfaceAddendum(agent, { skipCliInstall, docker }),
            buildSkillsPrompt(agent, installedSkills),
          ]
            .filter(Boolean)
            .join('\n\n'),
          scoringContext: buildLocalStackScoringContext(sandbox),
          exportWorkspace: (hostDir: string) =>
            sandbox.copyToHost(sandbox.workdir, hostDir),
          // Nothing to restore without Docker; the `available` path above
          // delegates to its own session's ensureReady.
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

// Log-line id (see run-eval.ts's PLAN line): default options read as
// 'local-stack', otherwise the non-default bits are appended, e.g.
// 'local-stack-beta-absent'.
function buildRuntimeId(options: LocalStackRuntimeOptions): string {
  const bits: string[] = [];
  if (options.cliVersion !== undefined) bits.push(options.cliVersion);
  const docker = options.docker ?? 'available';
  if (docker !== 'available') bits.push(docker);
  return bits.length > 0 ? `local-stack-${bits.join('-')}` : 'local-stack';
}

function buildLocalStackMarker(
  docker: DockerState,
  cliVersion: string,
  sessionStartedMs: number,
  channel?: CliChannel
): LocalStackEnvironmentMarker {
  return {
    runtime: 'local-stack',
    channel,
    cliVersion,
    docker,
    sessionStartedMs,
  };
}

async function writeLocalStackMarkerViaExec(
  exec: (
    command: string
  ) => Promise<{ ok: boolean; stdout: string; stderr: string }>,
  marker: LocalStackEnvironmentMarker
): Promise<void> {
  // base64 transport sidesteps quoting the JSON payload through the shell.
  const encoded = Buffer.from(JSON.stringify(marker), 'utf-8').toString(
    'base64'
  );
  const result = await exec(
    `echo ${encoded} | base64 -d > ${LOCAL_STACK_MARKER_PATH}`
  );
  if (!result.ok) {
    throw new Error(
      `failed to write the local-stack environment marker: ${result.stderr || result.stdout}`
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

/**
 * Shim that shadows `supabase` on PATH in a Docker-less sandbox. Here the
 * agent, not the harness, runs `supabase start`, so this is the only route
 * by which the eval's `includeServices` still gets applied (`-x <excluded>`).
 */
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
    // --version must keep working so the CLI's runtime probe
    // (supabase/cli#6563) still chooses Docker as its runtime.
    `  --version|-v) echo ${shellQuote(dockerVersion)}; exit 0 ;;`,
    'esac',
    `echo "Cannot connect to the Docker daemon at ${UNREACHABLE_DOCKER_HOST}. Is the docker daemon running?" >&2`,
    'exit 1',
  ].join('\n');
}

/**
 * Names the workspace's binaries accurately for the resolved Docker state,
 * so the Docker-less paths don't claim a binary or daemon the agent doesn't
 * have.
 */
function describeDockerTools(docker: DockerState): string {
  switch (docker) {
    case 'available':
      return 'docker, psql, git, and curl are installed in the workspace';
    case 'no-daemon':
      return (
        'psql, git, and curl are installed in the workspace; docker is ' +
        'installed but there is no daemon for it to connect to'
      );
    case 'absent':
      return 'psql, git, and curl are installed in the workspace; docker is not installed';
  }
}

/**
 * Describes the session's tool surface: the binaries installed in the workspace
 * and the in-process `bash`/`files_*` tools from `buildLocalStackTools`.
 *
 * ai-sdk only. Those tools exist solely for `aiSdkAgent`; `createCliAgent`
 * ignores `args.tools`, so a CLI agent works the same workspace through its own
 * built-in tools and this text would name tools it does not have.
 */
export function buildToolSurfaceAddendum(
  agent: AgentHarnessId,
  options: { skipCliInstall?: boolean; docker?: DockerState } = {}
): string {
  if (agent !== 'ai-sdk') return '';
  const docker = options.docker ?? 'available';
  let addendum =
    `${describeDockerTools(docker)}. ` +
    'Use the bash tool to run commands (the working directory is always the workspace root) ' +
    'and the files tools to inspect and modify files.';

  if (!options.skipCliInstall) {
    addendum = 'The Supabase CLI (`supabase`), ' + addendum;
    // Without a reachable daemon, `supabase start` cannot bring services up
    // at all, so the reachability claim would be false on both Docker-less
    // states.
    if (docker === 'available') {
      addendum +=
        ' Services started with `supabase start` are reachable on their default 127.0.0.1 ports.';
    }
  }
  return addendum;
}

/**
 * Build the MCP server map for a session. An explicit `options.mcpServers`
 * wins. Otherwise, when the eval links to a hosted project, expose a Supabase
 * MCP server pointed at the mocked hosted platform (platform-lite) — host-side,
 * reaching it on the loopback port it's published on — filtered to the
 * requested feature groups so its tools act on the linked project. With no
 * hosted project there's no platform to talk to, so fall back to the
 * platform-independent docs server (`search_docs`).
 */
export async function resolveMcpServers(
  options: LocalStackRuntimeOptions,
  hosted?: HostedLink
): Promise<Record<string, McpServerConfig>> {
  if (options.mcpServers) return options.mcpServers;

  const features = options.mcpFeatures ?? DEFAULT_MCP_FEATURES;
  // Anything beyond `docs` talks to a project, so it needs a platform to point
  // at — the mocked hosted one (platform-lite), reached host-side on the
  // loopback port it's published on. `docs` alone runs standalone, with no
  // context (supabaseMcpServer omits --api-url and supplies a throwaway token).
  const platformDependent = features.some((feature) => feature !== 'docs');
  const { config } = await supabaseMcpServer({ features }).createConfig(
    platformDependent && hosted
      ? {
          apiUrl: `http://127.0.0.1:${hosted.port}`,
          accessToken: hosted.accessToken,
        }
      : undefined
  );
  return { supabase: config };
}

/**
 * Adapt the Docker sandbox to the minimal `AgentSandbox` surface a CLI agent
 * needs: run a command in the workspace and read files back out. CLI agents
 * (Claude Code) use this directly instead of the ai-sdk `tools` above.
 */
export function toAgentSandbox(sandbox: DockerSandbox): AgentSandbox {
  return {
    workspace: sandbox.workdir,
    exec: (command, options) => sandbox.runShell(command, options),
    readFile: (path) => sandbox.readFile(path),
  };
}

export function buildLocalStackTools(
  sandbox: DockerSandbox,
  docker: DockerState = 'available'
): ToolSet {
  return {
    bash: tool({
      description:
        'Run a bash command in the eval workspace (Linux). The working directory ' +
        'is always the workspace root; `cd` does not persist between calls. The ' +
        `Supabase CLI (\`supabase\`), ${describeDockerTools(docker)}.`,
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Bash command to run.' },
          timeout_sec: {
            type: 'number',
            description: `Optional timeout in seconds (default ${DEFAULT_BASH_TIMEOUT_SEC}, max ${MAX_BASH_TIMEOUT_SEC}). Increase for slow commands like \`supabase start\`.`,
          },
        },
        required: ['command'],
      }),
      execute: async (input) => {
        const command = String((input as any)?.command ?? '');
        const requested = Number((input as any)?.timeout_sec);
        const timeoutSec = Number.isFinite(requested)
          ? Math.min(Math.max(requested, 1), MAX_BASH_TIMEOUT_SEC)
          : DEFAULT_BASH_TIMEOUT_SEC;
        const result = await sandbox.runShell(command, {
          timeoutMs: timeoutSec * 1000,
        });
        return {
          exit_code: result.exitCode,
          stdout: truncateOutput(result.stdout),
          stderr: truncateOutput(result.stderr),
        };
      },
    }),
    files_list: tool({
      description:
        'List files in the workspace. Paths are relative to the workspace root.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Optional relative directory path.',
          },
        },
      }),
      execute: async (input) => {
        const path = resolveSandboxPath(String((input as any)?.path ?? '.'));
        const result = await sandbox.runShell(
          `[ -d ${shellQuote(path)} ] || exit 0; find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -printf '%y\\t%p\\n' | sort -k2`
        );
        if (!result.ok) throw new Error(result.stderr || 'files_list failed');
        const entries = result.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [kind, ...rest] = line.split('\t');
            const entryPath = rest.join('\t').replace(/^\.\//, '');
            return { path: entryPath, type: kind === 'd' ? 'dir' : 'file' };
          });
        return { entries };
      },
    }),
    files_read: tool({
      description: 'Read a UTF-8 text file from the workspace.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path to read.' },
        },
        required: ['path'],
      }),
      execute: async (input) => {
        const path = resolveSandboxPath(String((input as any)?.path ?? ''));
        return { contents: await sandbox.readFile(path) };
      },
    }),
    files_write: tool({
      description:
        'Write a UTF-8 text file in the workspace, creating parent directories if needed.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path to write.' },
          contents: { type: 'string', description: 'Full file contents.' },
        },
        required: ['path', 'contents'],
      }),
      execute: async (input) => {
        const path = resolveSandboxPath(String((input as any)?.path ?? ''));
        await sandbox.writeFiles({
          [path]: String((input as any)?.contents ?? ''),
        });
        return { ok: true };
      },
    }),
    files_edit: tool({
      description:
        'Replace exactly one string occurrence in a UTF-8 text file in the workspace.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path to edit.' },
          old_string: { type: 'string', description: 'Exact text to replace.' },
          new_string: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'old_string', 'new_string'],
      }),
      execute: async (input) => {
        const path = resolveSandboxPath(String((input as any)?.path ?? ''));
        const oldString = String((input as any)?.old_string ?? '');
        const newString = String((input as any)?.new_string ?? '');
        const contents = await sandbox.readFile(path);
        const first = contents.indexOf(oldString);
        if (first === -1) throw new Error('old_string was not found');
        if (contents.indexOf(oldString, first + oldString.length) !== -1) {
          throw new Error('old_string must be unique in the file');
        }
        await sandbox.writeFiles({
          [path]: contents.replace(oldString, newString),
        });
        return { ok: true };
      },
    }),
  };
}

export function buildLocalStackScoringContext(
  sandbox: DockerSandbox,
  hosted?: HostedLink
): LocalStackScoringContext {
  let stackConfig: LocalStackStatus | undefined;
  let dbUrl: string | undefined;
  let environmentMarker: LocalStackEnvironmentMarker | undefined;
  let environmentMarkerRead = false;

  // Read as root, in exec form (docker-sandbox.ts's readRootFile), so
  // neither `resolveSandboxPath` nor the agent's `PATH` is in the path of a
  // scorer reading the environment it's being graded in.
  const discoverEnvironmentMarker = async () => {
    if (environmentMarkerRead) return environmentMarker;
    environmentMarkerRead = true;
    try {
      const raw = await sandbox.readRootFile(LOCAL_STACK_MARKER_PATH);
      const parsed = JSON.parse(raw);
      environmentMarker = isLocalStackEnvironmentMarker(parsed)
        ? parsed
        : undefined;
    } catch {
      environmentMarker = undefined;
    }
    return environmentMarker;
  };

  // Read the DB connection string from the running stack rather than assuming
  // the default 127.0.0.1:54322 — same derive-from-`supabase status` approach as
  // discoverStackConfig/getClient. An agent owns supabase/config.toml and may
  // remap ports (e.g. to dodge a conflict), so `query()` must target whatever
  // port the stack actually bound. Unlike the API keys, `DB_URL` is reported as
  // soon as the database is up (it does not wait on gotrue), so no DB-only eval
  // is coupled to auth readiness.
  const discoverDbUrl = async () => {
    if (dbUrl) return dbUrl;
    let lastStatus = '';
    for (let attempt = 0; attempt < STACK_CONFIG_RETRIES; attempt += 1) {
      const status = await sandbox.runShell('supabase status -o json');
      const url = extractJson(status.stdout)?.DB_URL;
      if (status.ok && typeof url === 'string') {
        dbUrl = url;
        return dbUrl;
      }
      lastStatus = status.stdout || status.stderr;
      if (attempt < STACK_CONFIG_RETRIES - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, STACK_CONFIG_RETRY_MS)
        );
      }
    }
    throw new Error(
      'could not read DB_URL from `supabase status -o json` after ' +
        `${STACK_CONFIG_RETRIES} attempts — the local stack must be running. ` +
        `Last status: ${lastStatus.slice(0, 300)}`
    );
  };

  const discoverStackConfig = async () => {
    if (stackConfig) return stackConfig;
    // `supabase status` only reports the API keys once gotrue is fully up, which
    // can lag a moment after `supabase start` returns. Retry briefly so a scorer
    // that calls getClient() right away doesn't false-fail on a transient miss.
    let lastStatus = '';
    for (let attempt = 0; attempt < STACK_CONFIG_RETRIES; attempt += 1) {
      const status = await sandbox.runShell('supabase status -o json');
      const config = extractJson(status.stdout);
      const apiUrl = readString(config, 'API_URL');
      const publishableKey = readString(config, 'PUBLISHABLE_KEY');
      const secretKey = readString(config, 'SECRET_KEY');
      if (status.ok && apiUrl && publishableKey && secretKey) {
        stackConfig = {
          apiUrl,
          publishableKey,
          secretKey,
          anonKey: readString(config, 'ANON_KEY') ?? '',
        };
        return stackConfig;
      }
      lastStatus = status.stdout || status.stderr;
      if (attempt < STACK_CONFIG_RETRIES - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, STACK_CONFIG_RETRY_MS)
        );
      }
    }
    throw new Error(
      'could not read API_URL/PUBLISHABLE_KEY/SECRET_KEY from `supabase status -o json` after ' +
        `${STACK_CONFIG_RETRIES} attempts — the local stack must be running and include the auth ` +
        "service (status only reports API keys while gotrue is up; add `gotrue` to the eval's " +
        `services). Last status: ${lastStatus.slice(0, 300)}`
    );
  };

  return {
    workspace: sandbox.workdir,
    exec: (command, options) => sandbox.runShell(command, options),
    readFile: (path) => sandbox.readFile(resolveSandboxPath(path)),
    fileExists: (path) => sandbox.fileExists(resolveSandboxPath(path)),
    folderExists: (path) => sandbox.folderExists(resolveSandboxPath(path)),
    query: async (sql) => {
      const url = await discoverDbUrl();
      // base64 transport sidesteps shell quoting entirely.
      const encoded = Buffer.from(wrapSelectAsJson(sql), 'utf-8').toString(
        'base64'
      );
      const result = await sandbox.runShell(
        `echo ${encoded} | base64 -d | psql "${url}" -v ON_ERROR_STOP=1 -tA`
      );
      if (!result.ok) {
        throw new Error(`query failed: ${result.stderr || result.stdout}`);
      }
      const text = result.stdout.trim();
      return { rows: text ? JSON.parse(text) : [] };
    },
    stackStatus: () => discoverStackConfig(),
    environmentMarker: () => discoverEnvironmentMarker(),
    getClient: async () => {
      const { apiUrl, publishableKey } = await discoverStackConfig();
      return createClient(apiUrl, publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    },
    hostedRef: hosted?.ref,
    hostedMgmt: hosted?.mgmt,
    hostedQuery: hosted?.query,
    invokeHostedFunction: hosted?.invokeFunction,
  };
}

function isLocalStackEnvironmentMarker(
  value: unknown
): value is LocalStackEnvironmentMarker {
  return (
    isRecord(value) &&
    value.runtime === 'local-stack' &&
    typeof value.cliVersion === 'string' &&
    (value.docker === 'available' ||
      value.docker === 'no-daemon' ||
      value.docker === 'absent') &&
    typeof value.sessionStartedMs === 'number' &&
    (value.channel === undefined ||
      value.channel === 'stable' ||
      value.channel === 'beta')
  );
}

function readString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function extractJson(stdout: string): Record<string, unknown> | undefined {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wrap a SELECT so psql returns structured rows as one JSON document instead
 * of table-formatted text.
 */
export function wrapSelectAsJson(sql: string): string {
  return `select coalesce(json_agg(t), '[]'::json) from (${sql.replace(/;\s*$/, '')}) t;`;
}

export function resolveSandboxPath(userPath: string): string {
  if (!userPath || userPath.startsWith('/') || userPath.includes('\0')) {
    throw new Error('path must be relative to the workspace');
  }
  const normalized = posix.normalize(userPath);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('path escapes workspace');
  }
  return normalized;
}

export function truncateOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;
  const head = output.slice(0, MAX_TOOL_OUTPUT_CHARS - 4000);
  const tail = output.slice(-3000);
  return `${head}\n...[truncated ${output.length - head.length - tail.length} chars]...\n${tail}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
