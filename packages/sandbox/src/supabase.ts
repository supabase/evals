/**
 * Supabase CLI sandbox setup, adapted from supabase/agent-eval.
 *
 * Static setup (system packages, the pinned CLI) is described declaratively in
 * a Dockerfile and baked into a cached image — one build per CLI version,
 * instant sandbox creation afterwards. Only steps that depend on runtime
 * state run inside the container: the docker socket's gid varies by host, and
 * service restriction / workspace seeding vary per eval.
 *
 * Networking: the sandbox runs with host networking (see local-stack-runtime)
 * and the host Docker socket mounted, so `supabase start` spawns sibling
 * containers whose published ports land on the shared host loopback — exactly
 * the 127.0.0.1:<port> the CLI health-checks. No loopback redirection is
 * needed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SANDBOX_CONTAINER_LABEL,
  dockerCli,
  type DockerSandbox,
} from "./docker-sandbox.js";
import { SKILLS_CLI_VERSION } from "./skills.js";
import { ALL_SUPABASE_SERVICES, type SupabaseService } from "./types.js";

export const SUPABASE_CLI_VERSION = "2.67.1";

const SANDBOX_IMAGE_REPOSITORY = "supabase-evals-sandbox";

/** The sandbox image definition lives in an actual Dockerfile for editability. */
export const SANDBOX_DOCKERFILE_PATH = fileURLToPath(
  new URL("../Dockerfile", import.meta.url),
);

/**
 * Build (or reuse) the sandbox image for a CLI version and return its tag.
 * The Dockerfile is piped to `docker build -` (stdin, no build context), and
 * the layer cache makes repeat calls effectively free.
 */
export async function ensureSupabaseSandboxImage(): Promise<string> {
  // The base image carries only common tooling; its sole version input is the
  // skills CLI. The Supabase CLI is installed per local-stack session
  // (installSupabaseCli), so the image is shared across modes and CLI versions.
  const tag = `${SANDBOX_IMAGE_REPOSITORY}:base-skills-${SKILLS_CLI_VERSION}`;
  const existing = await dockerCli(["image", "inspect", tag]);
  if (existing.ok) return tag;

  const build = await dockerCli(
    [
      "build",
      "--build-arg",
      `SKILLS_CLI_VERSION=${SKILLS_CLI_VERSION}`,
      "--tag",
      tag,
      "-",
    ],
    { input: readFileSync(SANDBOX_DOCKERFILE_PATH, "utf8") },
  );
  if (!build.ok) {
    throw new Error(`failed to build sandbox image ${tag}: ${build.stderr}`);
  }
  return tag;
}

/**
 * Install the pinned Supabase CLI into the sandbox — a local-stack component,
 * run at setup time so tools-mode sandboxes (which never call this) genuinely
 * lack the CLI. Installed from the official release `.deb` (pinned for
 * benchmark comparability; Homebrew's tap only carries the latest version).
 */
export async function installSupabaseCli(
  sandbox: DockerSandbox,
  cliVersion: string = SUPABASE_CLI_VERSION,
): Promise<void> {
  await runOrThrow(
    sandbox,
    `ARCH="$(dpkg --print-architecture)" && ` +
      `curl -fsSL "https://github.com/supabase/cli/releases/download/v${cliVersion}/supabase_${cliVersion}_linux_$ARCH.deb" -o /tmp/supabase.deb && ` +
      `dpkg -i /tmp/supabase.deb && rm /tmp/supabase.deb`,
    "install the Supabase CLI",
    { asRoot: true },
  );
}

export interface SetupSupabaseSandboxOptions {
  /** Supabase CLI version to install into the sandbox (pinned default). */
  cliVersion?: string;
  /**
   * Local-stack services this session needs; every other service is excluded
   * from `supabase start` to keep boots fast. Omitted means the full stack.
   */
  includeServices?: readonly string[];
  /** Host directory whose contents seed the sandbox workspace. */
  localDir?: string;
  /**
   * Whether the local stack should already be running when the agent starts
   * (default true): the workspace must then contain supabase/config.toml and
   * `supabase start` runs with the exclude flag appended directly. When
   * false, starting the project is the agent's job, so the exclusion is
   * installed as a CLI wrapper instead — the only seam into commands the
   * agent types.
   */
  projectRunning?: boolean;
  /**
   * Link the CLI to a mocked hosted project (platform-lite) reachable on the
   * host at this port via host.docker.internal. When set, a CLI profile,
   * access token, and project ref are seeded so `supabase functions deploy` /
   * `secrets set` reach platform-lite.
   */
  hosted?: { port: number; pgPort?: number; ref: string; accessToken: string };
}

/** Workspace-relative path of the seeded CLI profile. */
const EVAL_PROFILE_PATH = ".supabase-eval-profile.yaml";

/** Workspace-relative path `supabase link` writes the project ref to. */
const PROJECT_REF_PATH = "supabase/.temp/project-ref";

/**
 * Workspace-relative `.temp` files `supabase link` caches and the linked DB
 * commands read. `pooler-url` is the connection string `db push`/`db pull`/
 * `migration repair` dial; the version files satisfy the CLI's compat probes.
 */
const POOLER_URL_PATH = "supabase/.temp/pooler-url";
const REMOTE_VERSION_FILES: Record<string, string> = {
  "supabase/.temp/postgres-version": "15.8.1.040",
  "supabase/.temp/gotrue-version": "v2.177.0",
  "supabase/.temp/rest-version": "v12.2.12",
  "supabase/.temp/storage-version": "v1.25.7",
};

/**
 * Run the per-session setup inside a sandbox created from the image:
 * docker socket access, leftover cleanup, optional service restriction, and
 * optional workspace seeding.
 */
export async function setupSupabaseSandbox(
  sandbox: DockerSandbox,
  options: SetupSupabaseSandboxOptions = {},
): Promise<void> {
  // The Supabase CLI is a local-stack component: install it here (not in the
  // base image) so tools-mode sandboxes don't have it. Everything below needs
  // the CLI, so it goes first.
  await installSupabaseCli(sandbox, options.cliVersion);

  // Let the non-root sandbox user talk to the mounted Docker socket by
  // joining the socket's group. chmod would also work but mutates the host
  // inode through the bind mount, leaving the host socket world-writable.
  await runOrThrow(
    sandbox,
    `SOCK_GID=$(stat -c '%g' /var/run/docker.sock) && ` +
      `GRP=$(getent group "$SOCK_GID" | cut -d: -f1) && ` +
      `[ -n "$GRP" ] || { groupadd -g "$SOCK_GID" docker-host && GRP=docker-host; } && ` +
      `usermod -aG "$GRP" node`,
    "grant docker socket access",
    { asRoot: true },
  );

  // Remove leftovers from previous eval runs that died before teardown.
  await cleanupEvalSupabaseResources(sandbox);

  if (options.hosted) {
    await linkSandboxToHostedPlatform(sandbox, options.hosted);
  }

  if (options.localDir) {
    await sandbox.copyToContainer(options.localDir, sandbox.workdir);
  }

  if (options.projectRunning ?? true) {
    // Fail with a clear authoring error before `supabase start` does with a
    // confusing one: a prestarted project needs a config in the workspace.
    if (!(await sandbox.fileExists("supabase/config.toml"))) {
      throw new Error(
        "projectRunning is enabled (the default) but the workspace has no supabase/config.toml — " +
          "ship one in the eval's local/ directory or set `projectRunning: false` in the eval frontmatter",
      );
    }
    await startSupabaseProject(sandbox, options.includeServices);
  } else {
    await restrictSupabaseServices(sandbox, options.includeServices);
  }
}

/**
 * Link the sandbox CLI to the mocked hosted platform (platform-lite) without
 * running `supabase link`: that command only writes the project ref to
 * supabase/.temp/project-ref and caches remote config, all of which we supply
 * directly. We write that same .temp/project-ref file so the linked ref
 * resolves exactly as it would after a real link, point the CLI at platform-lite
 * via a profile (api_url), and pass the token through $SUPABASE_ACCESS_TOKEN.
 * $SUPABASE_PROJECT_ID is kept as a redundant fallback for commands invoked
 * before a workspace project (config.toml) exists.
 *
 * platform-lite listens on the host (0.0.0.0); the sandbox reaches it at
 * host.docker.internal (mapped to the host gateway at container creation).
 */
async function linkSandboxToHostedPlatform(
  sandbox: DockerSandbox,
  hosted: { port: number; pgPort?: number; ref: string; accessToken: string },
): Promise<void> {
  const apiUrl = `http://host.docker.internal:${hosted.port}`;
  // Minimal valid profile: the CLI validates name/api_url/dashboard_url
  // (http_url) and project_host (hostname). Only api_url is functionally used
  // for `functions deploy` / `secrets set`.
  const profile = [
    "name: evals",
    `api_url: ${apiUrl}`,
    `dashboard_url: ${apiUrl}`,
    "project_host: supabase.co",
    "",
  ].join("\n");
  const files: Record<string, string> = {
    [EVAL_PROFILE_PATH]: profile,
    // Exactly what `supabase link` persists; the CLI reads (trimmed) the linked
    // ref from here when a command doesn't get an explicit --project-ref.
    [PROJECT_REF_PATH]: hosted.ref,
  };

  // When platform-lite exposed a Postgres-wire port, seed the same `.temp`
  // files a real `supabase link` would: the pooler connection string the
  // linked DB commands dial, and the version files their compat probes read.
  // The username carries the tenant (`postgres.<ref>`, Supavisor convention) so
  // platform-lite's pooler routes to the right project — matching the shape
  // PgServerHandle.connectionString() produces, not relying on its single-
  // project fallback. The wire server ignores credentials, so any password
  // connects; we set SUPABASE_DB_PASSWORD too so `db push` never prompts.
  if (hosted.pgPort !== undefined) {
    files[POOLER_URL_PATH] =
      `postgresql://postgres.${hosted.ref}:postgres@host.docker.internal:${hosted.pgPort}/postgres`;
    Object.assign(files, REMOTE_VERSION_FILES);
  }

  await sandbox.writeFiles(files);
  sandbox.extraEnv = {
    ...sandbox.extraEnv,
    SUPABASE_ACCESS_TOKEN: hosted.accessToken,
    SUPABASE_PROFILE: `${sandbox.workdir}/${EVAL_PROFILE_PATH}`,
    SUPABASE_PROJECT_ID: hosted.ref,
    ...(hosted.pgPort !== undefined ? { SUPABASE_DB_PASSWORD: "postgres" } : {}),
  };
}

/**
 * Start the local Supabase stack, excluding the services the session does not
 * need. Requires a workspace with supabase/config.toml.
 */
export async function startSupabaseProject(
  sandbox: DockerSandbox,
  includeServices?: readonly string[],
): Promise<void> {
  await runOrThrow(
    sandbox,
    buildSupabaseStartCommand(includeServices),
    "supabase start",
  );
}

/** `supabase start`, with the exclude flag when an include list is given. */
export function buildSupabaseStartCommand(
  includeServices: readonly string[] | undefined,
): string {
  const excluded = computeExcludedServices(includeServices);
  return excluded.length > 0
    ? `supabase start -x ${excluded.join(",")}`
    : "supabase start";
}

/**
 * Stop this workspace's local stack and remove any eval-created Supabase
 * containers/volumes/networks. Best-effort: never throws, so teardown cannot
 * mask an eval failure or block sandbox cleanup.
 */
export async function teardownSupabaseProject(sandbox: DockerSandbox): Promise<void> {
  try {
    // Scoped stop for this workspace's project (no --all: a developer's own
    // unrelated local stacks must survive eval runs).
    await sandbox.runShell("supabase stop --no-backup", { timeoutMs: 120_000 });
  } catch (err) {
    console.warn(
      "[sandbox] supabase stop failed (continuing with docker cleanup):",
      err instanceof Error ? err.message : err,
    );
  }
  await cleanupEvalSupabaseResources(sandbox);
}

/**
 * Remove Supabase containers/volumes/networks belonging to eval workspaces,
 * plus sandbox containers leaked by crashed runs. Eval project ids start with
 * `sandbox-` (the `supabase init` default is the workspace directory
 * basename, and seeded workspaces follow the same convention), so matching is
 * anchored on that prefix — a substring filter would catch developers' own
 * resources that merely contain "sandbox-".
 */
async function cleanupEvalSupabaseResources(sandbox: DockerSandbox): Promise<void> {
  // Stack resources, identified by the Supabase CLI's own project label.
  const projectLabel = "com.supabase.cli.project";
  const selfId = sandbox.id.slice(0, 12);
  const commands = [
    `docker ps -a --filter label=${projectLabel} --format '{{.ID}} {{.Label "${projectLabel}"}}' | awk '$2 ~ /^sandbox-/ {print $1}' | xargs -r docker rm -f`,
    `docker volume ls -q | grep -E '^supabase_[a-z_]+_sandbox-' | xargs -r docker volume rm -f`,
    `docker network ls --format '{{.Name}}' | grep -E '^supabase_network_sandbox-' | xargs -r docker network rm`,
    // Sandbox containers from runs that died before stop() (never this one).
    `docker ps -aq --filter label=${SANDBOX_CONTAINER_LABEL} | grep -v '^${selfId}' | xargs -r docker rm -f`,
  ];
  for (const command of commands) {
    try {
      await sandbox.runShellAsRoot(`{ ${command}; } 2>/dev/null || true`);
    } catch (err) {
      console.warn(
        "[sandbox] docker cleanup error (best-effort):",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * The CLI only has an exclude flag (`supabase start -x`), so invert a list of
 * required services into the services to exclude. Validates service names.
 */
export function computeExcludedServices(
  includeServices: readonly string[] | undefined,
): SupabaseService[] {
  // Omitted → full stack (exclude nothing). An explicit empty list is distinct:
  // it means "only the always-on database", so it falls through and excludes
  // every optional service below.
  if (includeServices === undefined) return [];

  const invalid = includeServices.filter(
    (service) => !ALL_SUPABASE_SERVICES.includes(service as SupabaseService),
  );
  if (invalid.length > 0) {
    throw new Error(
      `invalid Supabase services: ${invalid.join(", ")} (valid: ${ALL_SUPABASE_SERVICES.join(", ")})`,
    );
  }
  const included = new Set(includeServices);
  return ALL_SUPABASE_SERVICES.filter((service) => !included.has(service));
}

/**
 * Wrapper that replaces the CLI binary so every `supabase start` — harness-
 * or agent-initiated — gets the exclude flag appended. There is no other seam
 * to inject the flag into commands the agent types. `-x` is a slice flag, so
 * an agent-passed exclude list merges with ours.
 */
export function buildServiceWrapperScript(
  excluded: readonly SupabaseService[],
): string {
  return [
    "#!/bin/bash",
    `if [ "$1" = "start" ]; then`,
    `  shift`,
    `  exec /usr/local/bin/supabase-cli start "$@" -x ${excluded.join(",")}`,
    `fi`,
    `exec /usr/local/bin/supabase-cli "$@"`,
  ].join("\n");
}

async function restrictSupabaseServices(
  sandbox: DockerSandbox,
  includeServices: readonly string[] | undefined,
): Promise<void> {
  const excluded = computeExcludedServices(includeServices);
  if (excluded.length === 0) return;

  await runOrThrow(
    sandbox,
    // Idempotent: only move the real binary aside once; rewriting the wrapper
    // is safe.
    `[ -e /usr/local/bin/supabase-cli ] || mv "$(command -v supabase)" /usr/local/bin/supabase-cli\n` +
      `cat > /usr/local/bin/supabase <<'WRAPPER'\n${buildServiceWrapperScript(excluded)}\nWRAPPER\n` +
      `chmod +x /usr/local/bin/supabase`,
    "restrict supabase services",
    { asRoot: true },
  );
}

async function runOrThrow(
  sandbox: DockerSandbox,
  command: string,
  label: string,
  options: { asRoot?: boolean } = {},
): Promise<void> {
  const result = options.asRoot
    ? await sandbox.runShellAsRoot(command)
    : await sandbox.runShell(command);
  if (!result.ok) {
    throw new Error(`[${label}] failed: ${result.stderr || result.stdout}`);
  }
}
