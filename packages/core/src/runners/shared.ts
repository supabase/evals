/**
 * Helpers shared across CLI runners: sandbox scratch paths, file staging,
 * global npm install, newest-file lookup, loopback rewriting, and the default
 * process-exit-based stop reason.
 */

import type { CommandResult, McpServerConfig } from "../index.js";
import type { AgentSandbox } from "./types.js";

/** Scratch dir + staged files, outside the workspace so they're never scored. */
export const SCRATCH = '"$HOME/.eval"';
export const SYSTEM_PROMPT_PATH = '"$HOME/.eval/system-prompt.txt"';
export const USER_PROMPT_PATH = '"$HOME/.eval/user-prompt.txt"';
/** npm prefix for the per-run global CLI install (outside the workspace). */
export const NPM_PREFIX = '"$HOME/.npm-global"';

const INSTALL_TIMEOUT_MS = 300_000;

/** POSIX single-quote escaping for embedding a value in a shell command. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Write a file into the sandbox via base64 (sidesteps all shell quoting). */
export async function writeSandboxFile(
  sandbox: AgentSandbox,
  shellPath: string,
  contents: string,
): Promise<void> {
  const encoded = Buffer.from(contents, "utf8").toString("base64");
  const result = await sandbox.exec(`printf %s '${encoded}' | base64 -d > ${shellPath}`);
  if (!result.ok) {
    throw new Error(`failed to write sandbox file ${shellPath}: ${result.stderr}`);
  }
}

/** `npm install -g` a pinned package into the per-run prefix (outside the workspace). */
export async function npmInstallGlobal(
  sandbox: AgentSandbox,
  pkgAtVersion: string,
  displayName: string,
): Promise<void> {
  const result = await sandbox.exec(
    `mkdir -p ${NPM_PREFIX} && npm install -g --prefix ${NPM_PREFIX} ${pkgAtVersion}`,
    { timeoutMs: INSTALL_TIMEOUT_MS },
  );
  if (!result.ok) {
    throw new Error(`${displayName} install failed: ${result.stderr || result.stdout}`);
  }
}

/** Absolute path to a CLI binary installed by `npmInstallGlobal`. */
export function npmGlobalBin(binName: string): string {
  return `${NPM_PREFIX}/bin/${binName}`;
}

/**
 * Newest file matching a shell glob, by mtime (robust to id/timestamp naming).
 * Returns the path, or undefined if none match. For CLIs that write a session
 * file rather than streaming the transcript to stdout.
 */
export async function findNewestFile(
  sandbox: AgentSandbox,
  globExpr: string,
): Promise<string | undefined> {
  const result = await sandbox.exec(
    `find ${globExpr} -type f -printf '%T@ %p\\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-`,
  );
  const path = result.stdout.trim();
  return result.ok && path ? path : undefined;
}

/**
 * Rewrite loopback hosts to `host.docker.internal` in MCP server configs — but
 * only the host of a URL authority (after `://`), so a loopback-looking
 * substring inside a token/ref/password is left alone. The harness builds these
 * for host-side use (platform-lite on 127.0.0.1); a CLI agent spawns them inside
 * the container, where the host is reachable only via `host.docker.internal`.
 */
export function rewriteLoopback(
  servers: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const swap = (value: string) =>
    value.replace(
      /(:\/\/)(127\.0\.0\.1|0\.0\.0\.0|localhost)/g,
      "$1host.docker.internal",
    );
  const out: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    out[name] = {
      command: server.command,
      args: server.args?.map(swap),
      env: server.env
        ? Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, swap(v)]))
        : undefined,
    };
  }
  return out;
}

/** Default stop reason from the process result alone (timeout / stop / error). */
export function processStopReason(command: CommandResult): string {
  if (
    command.exitCode === 124 ||
    command.exitCode === 137 ||
    /timed out/i.test(command.stderr)
  ) {
    return "timeout";
  }
  if (command.ok) return "stop";
  return `error_exit_${command.exitCode ?? "unknown"}`;
}
