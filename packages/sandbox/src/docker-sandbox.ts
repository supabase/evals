/**
 * Docker-based sandbox for local-stack evals.
 *
 * Shells out to the `docker` CLI rather than using a Docker API client
 * library: the daemon is a hard requirement of this feature anyway (and the
 * Supabase CLI inside the sandbox shells out to docker itself), child_process
 * gives stdout/stderr separation and timeouts natively, and there are no
 * native-module dependencies to build. The sandbox container mounts the host
 * Docker socket (Docker-out-of-Docker) so the Supabase CLI inside it can
 * spawn the local stack as sibling containers.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { SandboxCommandResult } from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_IMAGE = "node:22-slim";

/** Default timeout for container commands (10 minutes). */
const DEFAULT_TIMEOUT_MS = 600_000;

/** Generous output cap; tool-level truncation happens upstream. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Base path for sandbox workspaces. Must live under /tmp so Docker
 * Desktop/OrbStack share it with the host VM: the workspace is bind-mounted at
 * the same path inside the sandbox, on the host, and therefore resolvable when
 * the Supabase CLI asks the host daemon to bind-mount project files into
 * sibling containers.
 */
const WORKSPACE_BASE = "/tmp/sandbox";

/**
 * Non-root user. node:*-slim images ship a `node` user with UID/GID 1000;
 * agent commands run as this user, setup commands run as root.
 */
const SANDBOX_UID = 1000;
const SANDBOX_GID = 1000;

/**
 * Sandbox containers carry this label so crashed runs' leftovers can be
 * identified and removed by later runs.
 */
export const SANDBOX_CONTAINER_LABEL = "supabase-evals-sandbox";

/**
 * Headroom added to the in-container `timeout` before the docker CLI client
 * itself is killed, so the normal timeout path terminates the command inside
 * the container instead of orphaning it.
 */
const CLIENT_TIMEOUT_HEADROOM_MS = 20_000;

const SANDBOX_PATH = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
].join(":");

export interface DockerSandboxOptions {
  /** Image to run; defaults to node:22-slim. */
  image?: string;
  /** Default timeout for commands, in milliseconds. */
  timeoutMs?: number;
  /** Linux capabilities to add (e.g. ["NET_ADMIN"] for iptables DNAT). */
  capAdd?: string[];
  /**
   * Kernel sysctls to set at container creation (e.g.
   * { "net.ipv4.conf.all.route_localnet": "1" }). Some sysctls — route_localnet
   * among them — are only writable at creation, not at runtime, so they cannot
   * be set from inside the container even with NET_ADMIN.
   */
  sysctls?: Record<string, string>;
}

export interface RunCommandOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
}

export class DockerSandbox {
  private containerId: string | null = null;
  private defaultTimeoutMs: number;
  private capAdd: string[];
  private sysctls: Record<string, string>;
  private image: string;
  readonly workdir: string;
  /**
   * Env vars injected into every `runShell` (non-root) command — both the
   * agent's bash tool and scorer `exec`. Used to link the CLI to a mocked
   * hosted project (SUPABASE_ACCESS_TOKEN / SUPABASE_PROFILE / SUPABASE_PROJECT_ID).
   */
  extraEnv: Record<string, string> = {};

  private constructor(options: DockerSandboxOptions) {
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.capAdd = options.capAdd ?? [];
    this.sysctls = options.sysctls ?? {};
    this.image = options.image ?? DEFAULT_IMAGE;
    this.workdir = `${WORKSPACE_BASE}-${randomUUID().slice(0, 8)}`;
  }

  static async create(
    options: DockerSandboxOptions = {},
  ): Promise<DockerSandbox> {
    const sandbox = new DockerSandbox(options);
    try {
      await sandbox.initialize();
    } catch (err) {
      await sandbox.stop();
      throw err;
    }
    return sandbox;
  }

  private async initialize(): Promise<void> {
    // Pre-create the host side of the workspace bind mount so cleanup can
    // remove it without root (the daemon would create it root-owned).
    mkdirSync(this.workdir, { recursive: true });

    const result = await dockerCli(
      [
        "run",
        "--detach",
        "--rm",
        "--label",
        `${SANDBOX_CONTAINER_LABEL}=1`,
        "--volume",
        "/var/run/docker.sock:/var/run/docker.sock",
        "--volume",
        `${this.workdir}:${this.workdir}`,
        "--workdir",
        this.workdir,
        // Reach host-side servers (e.g. the linked platform-lite) at
        // host.docker.internal on Linux/CI and Docker Desktop alike.
        "--add-host",
        "host.docker.internal:host-gateway",
        ...this.capAdd.flatMap((cap) => ["--cap-add", cap]),
        ...Object.entries(this.sysctls).flatMap(([key, value]) => [
          "--sysctl",
          `${key}=${value}`,
        ]),
        this.image,
        "sleep",
        "infinity",
      ],
      // `docker run` pulls the image when missing; allow time for that.
      { timeoutMs: DEFAULT_TIMEOUT_MS },
    );
    if (!result.ok || !result.stdout.trim()) {
      throw new Error(`failed to start sandbox container: ${result.stderr}`);
    }
    this.containerId = result.stdout.trim();

    const chown = await this.runShellAsRoot(
      `chown -R ${SANDBOX_UID}:${SANDBOX_GID} ${this.workdir}`,
    );
    if (!chown.ok) {
      throw new Error(`failed to chown sandbox workspace: ${chown.stderr}`);
    }
  }

  /** The sandbox container id (empty when not running). */
  get id(): string {
    return this.containerId ?? "";
  }

  /**
   * Run a shell command as the non-root sandbox user, cwd = workspace.
   * Executes as the named user (not uid:gid) so supplementary groups added
   * during setup — e.g. the docker socket's group — apply.
   */
  async runShell(
    command: string,
    options: RunCommandOptions = {},
  ): Promise<SandboxCommandResult> {
    return this.execCommand(command, {
      ...options,
      env: {
        PATH: SANDBOX_PATH,
        HOME: "/home/node",
        ...this.extraEnv,
        ...options.env,
      },
      user: "node",
    });
  }

  /** Run a shell command as root. Intended for sandbox setup only. */
  async runShellAsRoot(
    command: string,
    options: RunCommandOptions = {},
  ): Promise<SandboxCommandResult> {
    return this.execCommand(command, { ...options, user: "root" });
  }

  async readFile(path: string): Promise<string> {
    const result = await this.runShell(`cat ${shellQuote(path)}`);
    if (!result.ok) {
      throw new Error(`failed to read file ${path}: ${result.stderr}`);
    }
    return result.stdout;
  }

  async fileExists(path: string): Promise<boolean> {
    const result = await this.runShell(`test -f ${shellQuote(path)}`);
    return result.ok;
  }

  /**
   * Copy between the host and the container with `docker cp`. Either endpoint
   * may carry the `container:` prefix (`<id>:<path>`); direction is implied by
   * which side does. Binary-safe and streamed straight through the engine — no
   * buffering into memory. The shared primitive behind copyHostDir, copyToHost,
   * and writeFiles.
   */
  private async dockerCopy(source: string, dest: string): Promise<void> {
    const result = await dockerCli(["cp", source, dest]);
    if (!result.ok) {
      throw new Error(`failed to copy ${source} → ${dest}: ${result.stderr}`);
    }
  }

  /** `container:<workdir>` reference for docker cp. */
  private get containerWorkdir(): string {
    return `${this.containerId}:${this.workdir}`;
  }

  /**
   * Copy a host directory's contents into the workspace root, then drop
   * VCS/dependency noise and hand ownership to the sandbox user. Use this to
   * seed a workspace; use writeFiles for the in-memory single-file case (the
   * file tools).
   */
  async copyHostDir(hostDir: string): Promise<void> {
    this.assertRunning();
    await this.dockerCopy(`${hostDir}/.`, `${this.containerWorkdir}/`);
    // Drop VCS/dependency noise that shouldn't seed the workspace; a cheap
    // no-op when none of these are present in the source directory.
    await this.runShellAsRoot(
      `find ${this.workdir} -depth \\( -name .git -o -name node_modules -o -name .DS_Store \\) -exec rm -rf {} + 2>/dev/null || true`,
    );
    // docker cp preserves host ownership; hand the files to the sandbox user.
    const chown = await this.runShellAsRoot(
      `chown -R ${SANDBOX_UID}:${SANDBOX_GID} ${this.workdir}`,
    );
    if (!chown.ok) {
      throw new Error(`failed to chown copied files: ${chown.stderr}`);
    }
  }

  /**
   * Copy the workspace contents out of the container into a host directory
   * (the `docker cp` reverse of copyHostDir). Lets host-side tooling — e.g.
   * vite/vitest from the repo root — score the agent's produced files without
   * that tooling having to exist inside the sandbox.
   */
  async copyToHost(hostDir: string): Promise<void> {
    this.assertRunning();
    mkdirSync(hostDir, { recursive: true });
    await this.dockerCopy(`${this.containerWorkdir}/.`, `${hostDir}/`);
  }

  /** Write files into the workspace. Paths are relative to the workspace root. */
  async writeFiles(files: Record<string, string>): Promise<void> {
    const entries = Object.entries(files);
    if (entries.length === 0) return;
    this.assertRunning();

    // Stage on the host and `docker cp` in: copying through the engine keeps
    // a single write path that works regardless of how the host shares /tmp.
    const staging = mkdtempSync(join(tmpdir(), "sandbox-upload-"));
    try {
      for (const [path, content] of entries) {
        const target = join(staging, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
      await this.dockerCopy(`${staging}/.`, `${this.containerWorkdir}/`);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }

    // docker cp preserves host ownership; hand the files to the sandbox user.
    const chown = await this.runShellAsRoot(
      `chown -R ${SANDBOX_UID}:${SANDBOX_GID} ${this.workdir}`,
    );
    if (!chown.ok) {
      throw new Error(`failed to chown uploaded files: ${chown.stderr}`);
    }
  }

  private async execCommand(
    command: string,
    options: { env?: Record<string, string>; user: string; timeoutMs?: number },
  ): Promise<SandboxCommandResult> {
    this.assertRunning();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));

    // Enforce the timeout inside the container via coreutils `timeout`:
    // killing only the docker exec client would orphan the command in the
    // container, where it keeps running and holding ports. The outer client
    // timeout is a backstop with headroom so the in-container path wins.
    const result = await dockerCli(
      [
        "exec",
        "--user",
        options.user,
        "--workdir",
        this.workdir,
        ...Object.entries(options.env ?? {}).flatMap(([key, value]) => [
          "--env",
          `${key}=${value}`,
        ]),
        this.containerId!,
        "timeout",
        "--kill-after=10",
        `${timeoutSec}`,
        "bash",
        "-c",
        command,
      ],
      { timeoutMs: timeoutMs + CLIENT_TIMEOUT_HEADROOM_MS },
    );

    // coreutils timeout exits 124 on TERM-after-timeout, 137 on the KILL
    // escalation. Surface both as a failed command the caller can react to.
    if (!result.ok && (result.exitCode === 124 || result.exitCode === 137)) {
      return {
        ...result,
        stderr:
          `${result.stderr}\n[command timed out after ${timeoutSec}s and was terminated]`.trim(),
      };
    }
    return result;
  }

  private assertRunning(): void {
    if (!this.containerId) throw new Error("sandbox not running");
  }

  /** Stop the container (--rm removes it) and the host-side workspace. */
  async stop(): Promise<void> {
    if (this.containerId) {
      const id = this.containerId;
      this.containerId = null;
      // Empty the workspace from inside the container first: its contents are
      // owned by uid 1000, which the host user cannot necessarily delete.
      try {
        await dockerCli([
          "exec",
          "--user",
          "root",
          id,
          "find",
          this.workdir,
          "-mindepth",
          "1",
          "-delete",
        ]);
      } catch {
        // Best-effort cleanup.
      }
      try {
        await dockerCli(["stop", "--timeout", "0", id]);
      } catch {
        // Container may already be stopped or removed.
      }
    }
    try {
      rmSync(this.workdir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    return this.stop();
  }
}

/** Run the host docker CLI. `input` is piped to stdin (e.g. `docker build -`). */
export async function dockerCli(
  args: string[],
  options: { timeoutMs?: number; input?: string } = {},
): Promise<SandboxCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const promise = execFileAsync("docker", args, {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (options.input !== undefined) {
      promise.child.stdin?.write(options.input);
      promise.child.stdin?.end();
    }
    const { stdout, stderr } = await promise;
    return { ok: true, exitCode: 0, stdout, stderr };
  } catch (err) {
    const execErr = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };
    if (execErr.code === "ENOENT") {
      throw new Error(
        "docker CLI not found on PATH — local-stack evals require a local Docker installation",
      );
    }
    if (execErr.killed || execErr.signal === "SIGKILL") {
      throw new Error(`sandbox command timed out after ${timeoutMs}ms`);
    }
    return {
      ok: false,
      exitCode: typeof execErr.code === "number" ? execErr.code : null,
      stdout: execErr.stdout ?? "",
      stderr: execErr.stderr ?? String(execErr.message ?? err),
    };
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
