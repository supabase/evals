/**
 * Muse Code runner. Headless via `muse exec --json --prompt-file <path>`.
 *
 * Four things are Muse-specific:
 *   - Install. Muse Code is not on npm, and Meta's launcher only follows a
 *     moving channel. The runner downloads one pinned Linux build from Meta's
 *     versioned download URL and checks it against the sha256 recorded here,
 *     so a version change is always a reviewed diff.
 *   - State. Muse keeps config and sessions under the XDG directories. They are
 *     set in the shell command, not the sandbox `env`: `docker exec --env`
 *     passes `$HOME` unexpanded, which would put Muse's state in a directory
 *     literally named `$HOME` inside the scored workspace (see the Grok runner).
 *   - Transcript. Stdout carries only run lifecycle and output text. Tool calls
 *     and results, per-request usage, and the error class of a failed run are
 *     written to the session log on disk, so `raw` is the session logs, not
 *     stdout. See ./parser.ts.
 *   - Trust. Muse loads a workspace's skills and rules only when the workspace
 *     is trusted. `--yolo` trusts it and turns off Muse's approval prompts and
 *     OS sandbox; the eval sandbox is the isolation boundary, as for every
 *     other CLI harness.
 */

import { randomUUID } from 'node:crypto';
import type { McpServerConfig } from '../../index.js';
import type { AgentRunner } from '../types.js';
import {
  fatalErrors,
  lastTerminal,
  modelRequestCount,
  sessionOpened,
  sessionPromptAt,
  sessionUsage,
} from './parser.js';
import { processStopReason, shellQuote, writeSandboxFile } from '../shared.js';

/**
 * Muse model id (`--model`). A string, not a union: Meta adds models faster
 * than this repo bumps versions. `muse-spark-1.3-contributor` is a different
 * service tier that lets Meta train on prompts, so never use it for evals.
 */
export type MuseModel = string;

/** Model used when the caller doesn't pick one. The CLI's own default is 1.2. */
export const DEFAULT_MUSE_MODEL: MuseModel = 'muse-spark-1.3';

/** A pinned Linux build: the download file name and its sha256, per CPU arch. */
interface MuseLinuxBuild {
  x86_64: { file: string; sha256: string };
  aarch64: { file: string; sha256: string };
}

/**
 * Builds the runner may install, keyed by full build id. Values come from
 * Meta's manifest for that build:
 * `https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=<id>&file=manifest.json`.
 * The checksums are recorded here rather than read from the manifest at run
 * time so a changed artifact fails the install instead of being trusted.
 */
export const MUSE_RELEASES: Record<string, MuseLinuxBuild> = {
  '1.4.3-R5018.1': {
    x86_64: {
      file: 'muse-x86-linux',
      sha256:
        'e671790882bc88d65edb4ae0f713becf378ebf91011034ab75abebe3592dde4f',
    },
    aarch64: {
      file: 'muse-aarch64-linux',
      sha256:
        '6426c76a0081f20d60f6cad03308a147d79ce45758f1a89fd2713253cf475497',
    },
  },
};

const MUSE_ROOT = '"$HOME/.eval/muse"';
const MUSE_BIN = '"$HOME/.eval/muse/bin/muse"';
const MUSE_CONFIG_DIR = '"$HOME/.eval/muse/config/muse"';
const MUSE_SETTINGS_PATH = '"$HOME/.eval/muse/config/muse/settings.json"';

/**
 * Prefix for every `muse` invocation. `MUSE_NO_AUTO_UPDATE` only matters to
 * Meta's launcher, which this runner doesn't use; it is set in case the
 * binary honours it too.
 */
export const MUSE_ENV = [
  'XDG_CONFIG_HOME="$HOME/.eval/muse/config"',
  'XDG_DATA_HOME="$HOME/.eval/muse/data"',
  'XDG_CACHE_HOME="$HOME/.eval/muse/cache"',
  'MUSE_NO_AUTO_UPDATE=1',
].join(' ');

/** Where Muse writes session logs under `XDG_DATA_HOME`. */
const MUSE_SESSIONS_DIR = '"$HOME/.eval/muse/data/muse/sessions"';

/**
 * Muse prints this to stderr for a `settings.json` key it doesn't recognize,
 * then ignores the key. After a version bump that would silently drop part of
 * the config, so the run fails instead.
 */
const UNKNOWN_SETTING = 'ignoring unknown top-level member in settings file';

const INSTALL_TIMEOUT_MS = 300_000;

/**
 * Error classes Muse gives a failed run that mean the run never got a fair
 * attempt: the key, quota, model id, or request was wrong, not the agent.
 * These throw, so the run is recorded as errored and rerun rather than scored.
 * `provider_error` is the parser's name for a model request Muse gave up on
 * without classifying it (a nonexistent model, in a real run). The classes
 * not here (`context_length`, `content_policy`, `step_limit`) follow from what
 * the agent and model did, so they are scored like any other stop.
 */
export const INFRASTRUCTURE_ERROR_CLASSES: ReadonlySet<string> = new Set([
  'auth_error',
  'config_error',
  'invalid_request',
  'model_not_found',
  'provider_error',
  'rate_limited',
]);

/** The versioned download URL for one file of a Muse Code build. */
export function museDownloadUrl(version: string, file: string): string {
  return `https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=${encodeURIComponent(version)}&file=${encodeURIComponent(file)}`;
}

/**
 * The shell script that downloads, verifies, and installs one build for the
 * sandbox's CPU arch. Exported so its shape is unit-testable without a
 * container.
 */
export function buildInstallScript(version: string): string {
  const build = MUSE_RELEASES[version];
  if (!build) {
    throw new Error(
      `Muse Code ${version} has no pinned build. Add its files and sha256 to MUSE_RELEASES. ` +
        `Known: ${Object.keys(MUSE_RELEASES).join(', ')}.`
    );
  }
  const download = `${MUSE_ROOT}/bin/muse.download`;
  const archCase = (
    [
      ['x86_64|amd64', build.x86_64],
      ['aarch64|arm64', build.aarch64],
    ] as const
  )
    .map(
      ([pattern, { file, sha256 }]) =>
        `  ${pattern}) url=${shellQuote(museDownloadUrl(version, file))}; sha=${sha256} ;;`
    )
    .join('\n');
  return [
    'set -eu',
    'arch="$(uname -m)"',
    'case "$arch" in',
    archCase,
    '  *) echo "Muse Code has no Linux build for $arch" >&2; exit 1 ;;',
    'esac',
    `mkdir -p ${MUSE_ROOT}/bin`,
    `curl -fsSL --retry 2 -o ${download} "$url"`,
    `printf '%s  %s\\n' "$sha" ${download} | sha256sum -c --quiet -`,
    `chmod 0755 ${download}`,
    `mv ${download} ${MUSE_BIN}`,
  ].join('\n');
}

export const museRunner: AgentRunner<MuseModel> = {
  id: 'muse',
  displayName: 'Muse Code',
  apiKeyEnvVar: 'META_API_KEY',
  cliPackage: 'muse-code',
  // Pinned: the session log schema and the CLI's built-in behaviour (system
  // instructions, skills, reminders) change between builds. Bump by adding the
  // new build to MUSE_RELEASES and re-checking the parser against a real run.
  defaultCliVersion: '1.4.3-R5018.1',
  defaultModel: DEFAULT_MUSE_MODEL,
  sessionDir: MUSE_SESSIONS_DIR,

  async install(sandbox, version) {
    const install = await sandbox.exec(buildInstallScript(version), {
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (!install.ok) {
      throw new Error(
        `${this.displayName} install failed: ${install.stderr || install.stdout}`
      );
    }
    // Also confirms the binary starts before the run's clock does.
    const reported = await sandbox.exec(`${MUSE_ENV} ${MUSE_BIN} --version`);
    if (!reported.ok || !reported.stdout.includes(`(${version})`)) {
      throw new Error(
        `${this.displayName} reports "${reported.stdout.trim() || reported.stderr.trim()}", expected build ${version}.`
      );
    }
  },

  async exec({
    sandbox,
    model,
    apiKey,
    userPromptPath,
    mcpServers,
    reasoningEffort,
    timeoutSec,
  }) {
    await sandbox.exec(`mkdir -p ${MUSE_CONFIG_DIR}`);
    await writeSandboxFile(
      sandbox,
      MUSE_SETTINGS_PATH,
      buildMuseSettings(mcpServers)
    );

    // Set up front so the session log can be found without guessing.
    const sessionId = randomUUID();
    const flags = [
      'exec',
      // Lifecycle events on stdout. Not parsed (the session log is), but
      // printed by the engine when a run produces no transcript.
      '--json',
      '--prompt-file',
      userPromptPath,
      // Explicit so a change of default provider can't switch the backend.
      '--provider meta',
      `--model ${shellQuote(model)}`,
      ...(reasoningEffort
        ? [`--reasoning-effort ${shellQuote(reasoningEffort)}`]
        : []),
      `--session-id ${sessionId}`,
      // Approval, Muse's OS sandbox, and workspace trust. See the module comment.
      '--yolo',
      // Ignore Claude Code / Codex user-level rules and skills if any exist in
      // the sandbox's home. Project skills under .agents/skills still load.
      '--no-foreign-personal-context',
    ].join(' ');

    const command = await sandbox.exec(
      `${MUSE_ENV} ${MUSE_BIN} ${flags} < /dev/null`,
      {
        timeoutMs: timeoutSec * 1000,
        env: { [this.apiKeyEnvVar]: apiKey },
      }
    );
    if (command.stderr.includes(UNKNOWN_SETTING)) {
      throw new Error(
        `${this.displayName} ignored part of its settings.json, so the run did not get the configured tools: ${command.stderr}`
      );
    }

    // A run killed at the time limit is a legitimate (scored) timeout, and may
    // have left its logs mid-record. Any other run must have complete logs
    // ending in a terminal event. Only the sandbox's deadline kill counts
    // (coreutils `timeout` exits 124, or 137 after escalating to KILL); Muse
    // itself exits 0, 1, 2, 130, or 143, so a provider error that merely
    // mentions a timeout doesn't qualify.
    const timedOut = command.exitCode === 124 || command.exitCode === 137;
    const raw = await readSessionLogs(sandbox, sessionId, timedOut);
    const failure = (why: string) =>
      new Error(
        `${this.displayName} ${why} (exit ${command.exitCode}).\nstdout:\n${command.stdout}\nstderr:\n${command.stderr}`
      );
    if (!raw || !sessionOpened(raw)) {
      // The agent never got the prompt: a rejected key, an unreachable model
      // catalog, or a crash at startup. Muse explains which on stderr.
      throw failure('never opened a session');
    }
    // Any session, not just the main one: a reminder agent or subagent cut off
    // by the quota changes how the agent ran just as much.
    const infrastructure = fatalErrors(raw).find(({ errorClass }) =>
      INFRASTRUCTURE_ERROR_CLASSES.has(errorClass)
    );
    if (infrastructure) {
      // Throwing skips the engine's session archive, so the message carries
      // Muse's own explanation.
      throw failure(
        `run failed with ${infrastructure.errorClass} in ${infrastructure.isMain ? 'the main session' : `child session ${infrastructure.sessionId}`}, ` +
          `which is not the agent's doing; rerun it. Muse reported: ${infrastructure.reason ?? '(no reason)'}`
      );
    }
    if (!timedOut && !lastTerminal(raw)) {
      throw failure('ended without recording how the run finished');
    }
    return { command, raw };
  },

  deriveStopReason(raw, command) {
    const terminal = lastTerminal(raw);
    if (!terminal) return processStopReason(command);
    switch (terminal.terminal) {
      case 'completed':
        return 'stop';
      case 'cancelled':
        return 'cancelled';
      case 'failed':
        // A failed run is classified just before its terminal event; the class
        // (`context_length`, `content_policy`, ...) is the useful part.
        return terminal.errorClass ?? 'muse_failed';
      default:
        return `muse_${terminal.terminal}`;
    }
  },

  extractUsage(raw, model) {
    return sessionUsage(raw, model);
  },

  extractStepCount(raw) {
    return modelRequestCount(raw);
  },

  async enrichEvents(sandbox) {
    // `promptAt` needs the record time of the run's start, which the events
    // don't carry, so read the main log again.
    const main = await sandbox.exec(
      `find ${MUSE_SESSIONS_DIR} -mindepth 5 -maxdepth 5 -name session.jsonl -exec cat {} +`
    );
    if (!main.ok || !main.stdout) return;
    return { promptAt: sessionPromptAt(completeLines(main.stdout)) };
  },
};

/** Drop a trailing partial line: a record the CLI was still writing when killed. */
function completeLines(text: string): string {
  return text.slice(0, text.lastIndexOf('\n') + 1);
}

/**
 * Node script that prints the main session log, then every child session log
 * under it (reminder agents and subagents write their own). Each record names
 * its session, so concatenation keeps them apart.
 *
 * A log whose last line has no newline and isn't valid JSON was cut off
 * mid-record. That is expected of a run killed at the time limit (pass
 * `partial-ok`): the half-written record was never durable and is dropped.
 * For any other run it means the log is damaged, so the script exits non-zero
 * instead. A complete record that only lacks its newline is kept.
 */
export const READ_SESSION_LOGS_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const [dir, mode] = process.argv.slice(1);
const logs = [];
const walk = (d) => {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name === 'session.jsonl' && d !== dir) logs.push(p);
  }
};
walk(dir);
logs.sort();
for (const log of [path.join(dir, 'session.jsonl'), ...logs]) {
  const text = fs.readFileSync(log, 'utf8');
  const end = text.lastIndexOf('\\n') + 1;
  let tail = text.slice(end);
  if (tail.trim()) {
    try {
      JSON.parse(tail);
      tail += '\\n';
    } catch {
      if (mode !== 'partial-ok') {
        console.error(log + ' ends mid-record');
        process.exit(3);
      }
      tail = '';
    }
  }
  process.stdout.write(text.slice(0, end) + tail);
}
`;

/** The session logs for one run, or undefined when Muse wrote none. */
async function readSessionLogs(
  sandbox: Parameters<AgentRunner['exec']>[0]['sandbox'],
  sessionId: string,
  partialOk: boolean
): Promise<string | undefined> {
  const found = await sandbox.exec(
    `find ${MUSE_SESSIONS_DIR} -mindepth 4 -maxdepth 4 -type d -name ${sessionId}`
  );
  const dir = found.stdout.trim();
  if (!found.ok || !dir) return undefined;
  const logs = await sandbox.exec(
    `node -e ${shellQuote(READ_SESSION_LOGS_SCRIPT)} ${shellQuote(dir)}${partialOk ? ' partial-ok' : ''}`
  );
  if (!logs.ok) {
    throw new Error(`Could not read Muse session logs: ${logs.stderr}`);
  }
  return logs.stdout || undefined;
}

/**
 * Muse's `settings.json`. MCP servers map onto `mcp_servers.<name>` with
 * `transport: "stdio"`. Muse fails the session when a declared server can't
 * start (`mode` defaults to `required`), which is what we want: a run without
 * its declared tools would otherwise score as a model failure.
 *
 * Telemetry is off so eval content isn't sent to Meta's telemetry endpoints,
 * as the Codex runner turns off its analytics.
 */
export function buildMuseSettings(
  servers: Record<string, McpServerConfig>
): string {
  const mcp: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    mcp[name] = {
      transport: 'stdio',
      command: server.command,
      args: server.args ?? [],
      ...(server.env ? { env: server.env } : {}),
    };
  }
  return JSON.stringify(
    {
      schema_version: 1,
      telemetry: { enabled: false },
      mcp_servers: mcp,
    },
    null,
    2
  );
}
