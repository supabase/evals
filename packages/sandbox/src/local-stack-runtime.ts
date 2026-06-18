import { posix } from "node:path";
import { jsonSchema, tool, type ToolSet } from "ai";
import { createClient } from "@supabase/supabase-js";
import {
  supabaseMcpServer,
  type HostedLink,
  type LocalStackRuntime,
  type LocalStackScoringContext,
  type McpServerConfig,
} from "@supabase-evals/core";
import { DockerSandbox } from "./docker-sandbox.js";
import {
  ensureSupabaseSandboxImage,
  setupSupabaseSandbox,
  teardownSupabaseProject,
} from "./supabase.js";

/** Local-stack Postgres as published by `supabase start` (DNAT'd in-sandbox). */
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const DEFAULT_BASH_TIMEOUT_SEC = 240;
const MAX_BASH_TIMEOUT_SEC = 600;
const MAX_TOOL_OUTPUT_CHARS = 16_000;

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
  /** Supabase CLI version baked into the sandbox image (pinned default). */
  cliVersion?: string;
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
}

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
const DEFAULT_MCP_FEATURES = ["docs"];

export function localStackRuntime(
  options: LocalStackRuntimeOptions = {},
): LocalStackRuntime {
  return {
    id: "local-stack",
    async startSession({ localDir, includeServices, projectRunning, hosted }) {
      const image = await ensureSupabaseSandboxImage(options.cliVersion);
      const sandbox = await DockerSandbox.create({
        image,
        // The loopback DNAT below (redirecting Supabase ports to sibling
        // containers) needs NET_ADMIN to install the iptables rules and
        // route_localnet so the kernel doesn't drop 127.0.0.1-destined packets
        // rerouted out eth0. route_localnet is only writable at container
        // creation, so it must be set here rather than during setup.
        capAdd: ["NET_ADMIN"],
        sysctls: { "net.ipv4.conf.all.route_localnet": "1" },
      });
      try {
        await setupSupabaseSandbox(sandbox, {
          includeServices,
          localDir,
          projectRunning,
          hosted: hosted
            ? { port: hosted.port, ref: hosted.ref, accessToken: hosted.accessToken }
            : undefined,
        });
      } catch (err) {
        await sandbox.stop();
        throw err;
      }

      const mcpServers = await resolveMcpServers(options, hosted);

      return {
        tools: buildLocalStackTools(sandbox),
        mcpServers,
        promptAddendum:
          "The Supabase CLI (`supabase`), docker, psql, git, and curl are installed in the workspace. " +
          "Use the bash tool to run commands (the working directory is always the workspace root) " +
          "and the files tools to inspect and modify files. " +
          "Services started with `supabase start` are reachable on their default 127.0.0.1 ports.",
        scoringContext: buildLocalStackScoringContext(sandbox, hosted),
        exportWorkspace: (hostDir: string) => sandbox.copyToHost(hostDir),
        close: async () => {
          await teardownSupabaseProject(sandbox);
          await sandbox.stop();
        },
      };
    },
  };
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
async function resolveMcpServers(
  options: LocalStackRuntimeOptions,
  hosted?: HostedLink,
): Promise<Record<string, McpServerConfig>> {
  if (options.mcpServers) return options.mcpServers;

  const features = options.mcpFeatures ?? DEFAULT_MCP_FEATURES;
  // Anything beyond `docs` talks to a project, so it needs a platform to point
  // at — the mocked hosted one (platform-lite), reached host-side on the
  // loopback port it's published on. `docs` alone runs standalone, with no
  // context (supabaseMcpServer omits --api-url and supplies a throwaway token).
  const platformDependent = features.some((feature) => feature !== "docs");
  const { config } = await supabaseMcpServer({ features }).createConfig(
    platformDependent && hosted
      ? { apiUrl: `http://127.0.0.1:${hosted.port}`, accessToken: hosted.accessToken }
      : undefined,
  );
  return { supabase: config };
}

export function buildLocalStackTools(sandbox: DockerSandbox): ToolSet {
  return {
    bash: tool({
      description:
        "Run a bash command in the eval workspace (Linux). The working directory " +
        "is always the workspace root; `cd` does not persist between calls. The " +
        "Supabase CLI (`supabase`), docker, psql, git, and curl are installed.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command to run." },
          timeout_sec: {
            type: "number",
            description: `Optional timeout in seconds (default ${DEFAULT_BASH_TIMEOUT_SEC}, max ${MAX_BASH_TIMEOUT_SEC}). Increase for slow commands like \`supabase start\`.`,
          },
        },
        required: ["command"],
      }),
      execute: async (input) => {
        const command = String((input as any)?.command ?? "");
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
        "List files in the workspace. Paths are relative to the workspace root.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "Optional relative directory path." },
        },
      }),
      execute: async (input) => {
        const path = resolveSandboxPath(String((input as any)?.path ?? "."));
        const result = await sandbox.runShell(
          `[ -d ${shellQuote(path)} ] || exit 0; find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -printf '%y\\t%p\\n' | sort -k2`,
        );
        if (!result.ok) throw new Error(result.stderr || "files_list failed");
        const entries = result.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [kind, ...rest] = line.split("\t");
            const entryPath = rest.join("\t").replace(/^\.\//, "");
            return { path: entryPath, type: kind === "d" ? "dir" : "file" };
          });
        return { entries };
      },
    }),
    files_read: tool({
      description: "Read a UTF-8 text file from the workspace.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to read." },
        },
        required: ["path"],
      }),
      execute: async (input) => {
        const path = resolveSandboxPath(String((input as any)?.path ?? ""));
        return { contents: await sandbox.readFile(path) };
      },
    }),
    files_write: tool({
      description:
        "Write a UTF-8 text file in the workspace, creating parent directories if needed.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to write." },
          contents: { type: "string", description: "Full file contents." },
        },
        required: ["path", "contents"],
      }),
      execute: async (input) => {
        const path = resolveSandboxPath(String((input as any)?.path ?? ""));
        await sandbox.writeFiles({
          [path]: String((input as any)?.contents ?? ""),
        });
        return { ok: true };
      },
    }),
    files_edit: tool({
      description:
        "Replace exactly one string occurrence in a UTF-8 text file in the workspace.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to edit." },
          old_string: { type: "string", description: "Exact text to replace." },
          new_string: { type: "string", description: "Replacement text." },
        },
        required: ["path", "old_string", "new_string"],
      }),
      execute: async (input) => {
        const path = resolveSandboxPath(String((input as any)?.path ?? ""));
        const oldString = String((input as any)?.old_string ?? "");
        const newString = String((input as any)?.new_string ?? "");
        const contents = await sandbox.readFile(path);
        const first = contents.indexOf(oldString);
        if (first === -1) throw new Error("old_string was not found");
        if (contents.indexOf(oldString, first + oldString.length) !== -1) {
          throw new Error("old_string must be unique in the file");
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
  hosted?: HostedLink,
): LocalStackScoringContext {
  let stackConfig: { apiUrl: string; publishableKey: string } | undefined;

  const discoverStackConfig = async () => {
    if (stackConfig) return stackConfig;
    const status = await sandbox.runShell("supabase status -o json");
    const config = extractJson(status.stdout);
    const apiUrl =
      typeof config?.API_URL === "string" ? config.API_URL : undefined;
    const publishableKey =
      typeof config?.PUBLISHABLE_KEY === "string"
        ? config.PUBLISHABLE_KEY
        : undefined;
    if (!status.ok || !apiUrl || !publishableKey) {
      throw new Error(
        "could not read API_URL/PUBLISHABLE_KEY from `supabase status -o json` — " +
          "the local stack must be running and include the auth service " +
          "(status only reports API keys while gotrue is up; add `gotrue` to the eval's services)",
      );
    }
    stackConfig = { apiUrl, publishableKey };
    return stackConfig;
  };

  return {
    workspace: sandbox.workdir,
    exec: (command, options) => sandbox.runShell(command, options),
    readFile: (path) => sandbox.readFile(resolveSandboxPath(path)),
    fileExists: (path) => sandbox.fileExists(resolveSandboxPath(path)),
    query: async (sql) => {
      // base64 transport sidesteps shell quoting entirely.
      const encoded = Buffer.from(wrapSelectAsJson(sql), "utf-8").toString(
        "base64",
      );
      const result = await sandbox.runShell(
        `echo ${encoded} | base64 -d | psql "${LOCAL_DB_URL}" -v ON_ERROR_STOP=1 -tA`,
      );
      if (!result.ok) {
        throw new Error(`query failed: ${result.stderr || result.stdout}`);
      }
      const text = result.stdout.trim();
      return { rows: text ? JSON.parse(text) : [] };
    },
    getClient: async () => {
      const { apiUrl, publishableKey } = await discoverStackConfig();
      return createClient(apiUrl, publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    },
    hostedRef: hosted?.ref,
    hostedMgmt: hosted?.mgmt,
    invokeHostedFunction: hosted?.invokeFunction,
  };
}

function extractJson(stdout: string): Record<string, unknown> | undefined {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null
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
  return `select coalesce(json_agg(t), '[]'::json) from (${sql.replace(/;\s*$/, "")}) t;`;
}

export function resolveSandboxPath(userPath: string): string {
  if (!userPath || userPath.startsWith("/") || userPath.includes("\0")) {
    throw new Error("path must be relative to the workspace");
  }
  const normalized = posix.normalize(userPath);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("path escapes workspace");
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
