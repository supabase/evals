// Mock Supabase Management API.
//
// Endpoint names match the real mgmt-api paths (e.g. `database.query` mirrors
// POST /v1/projects/{ref}/database/query). The agent's tool surface is
// generated from this registry, so anything callable here is callable by the
// agent (subject to per-eval allowlists).
//
// Add a new endpoint by writing a handler and registering it in `register()`.

import { bootProjectDb, type ProjectDbHandle } from "./project-db.js";
import { bootLogsDb, type LogsDbHandle } from "./logs-db.js";
import { bootNotifications, type NotificationsHandle } from "./notifications.js";
import { bootEdgeFunctions, type EdgeFunctionsHandle } from "./edge-functions.js";

export type Endpoint =
  | "database.query"
  | "logs.all"
  | "notifications.send"
  | "functions.deploy"
  | "functions.list";
// Future: secrets.create, storage.buckets.create, ...

export interface MgmtApiHandle {
  /** Invoke a mgmt-api endpoint. Same surface the agent gets via tools. */
  call: (endpoint: Endpoint, body: Record<string, unknown>) => Promise<unknown>;
  /** Backends — direct access for scorers that need it. */
  backends: {
    projectDb: ProjectDbHandle;
    logsDb: LogsDbHandle;
    notifications: NotificationsHandle;
    edgeFunctions: EdgeFunctionsHandle;
  };
  /** All endpoints registered. Used to build the tool surface. */
  endpoints: () => Array<{ name: Endpoint; spec: EndpointSpec }>;
  close: () => Promise<void>;
}

export interface EndpointSpec {
  /** Mirrors the real mgmt-api HTTP verb + path. Documentation only. */
  http: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (body: any, ctx: BackendCtx) => Promise<unknown>;
}

interface BackendCtx {
  projectDb: ProjectDbHandle;
  logsDb: LogsDbHandle;
  notifications: NotificationsHandle;
  edgeFunctions: EdgeFunctionsHandle;
}

export interface BootOptions {
  projectSeedSql?: string;
  logsSeedNdjson?: string;
}

export async function bootMgmtApi(opts: BootOptions = {}): Promise<MgmtApiHandle> {
  const projectDb = await bootProjectDb(opts.projectSeedSql);
  const logsDb = await bootLogsDb(opts.logsSeedNdjson);
  const notifications = bootNotifications();
  const edgeFunctions = bootEdgeFunctions(() => ({
    url: projectDb.url,
    anonKey: projectDb.anonKey,
    fetch: projectDb.fetch,
  }));
  const ctx: BackendCtx = { projectDb, logsDb, notifications, edgeFunctions };
  const registry = register();

  return {
    call: async (endpoint, body) => {
      const spec = registry.get(endpoint);
      if (!spec) throw new Error(`unknown endpoint: ${endpoint}`);
      return spec.handler(body, ctx);
    },
    backends: ctx,
    endpoints: () =>
      Array.from(registry.entries()).map(([name, spec]) => ({ name, spec })),
    close: async () => {
      await projectDb.close();
      await logsDb.close();
    },
  };
}

function register(): Map<Endpoint, EndpointSpec> {
  const m = new Map<Endpoint, EndpointSpec>();

  m.set("database.query", {
    http: "POST /v1/projects/{ref}/database/query",
    description:
      "Run SQL against the project's Postgres database. Multi-statement supported. " +
      "Runs as a privileged role; to test RLS, wrap test queries in BEGIN; " +
      "SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '...'; ... COMMIT;",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "SQL to execute" },
      },
      required: ["query"],
    },
    handler: async ({ query }: { query: string }, { projectDb }) => {
      const { rows } = await projectDb.exec(query);
      return { rows };
    },
  });

  m.set("logs.all", {
    http: "GET /v1/projects/{ref}/analytics/endpoints/logs.all",
    description:
      "Run a SQL query against the project's logs. Logs table schema: " +
      "(id text, ts timestamptz, source text, level text, message text, metadata jsonb).",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL to run against the `logs` table" },
      },
      required: ["sql"],
    },
    handler: async ({ sql }: { sql: string }, { logsDb }) => {
      const { rows } = await logsDb.query(sql);
      return { rows };
    },
  });

  m.set("notifications.send", {
    http: "POST /v1/projects/{ref}/notifications  (mock — placeholder for a future endpoint)",
    description:
      "Dispatch a notification (alert) to a downstream channel. " +
      "Use this when you've confirmed a problem worth paging humans about. " +
      "Spurious calls count against you.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["slack", "pagerduty", "email", "webhook"] },
        severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
        payload: {
          type: "object",
          description: "Free-form payload. Include identifiers the receiver needs (function_id, query_hash, error_rate, summary, ...).",
        },
      },
      required: ["channel", "severity", "payload"],
    },
    handler: async (
      body: { channel: string; severity: string; payload: Record<string, unknown> },
      { notifications }
    ) => {
      notifications.send(body);
      return { ok: true };
    },
  });

  m.set("functions.deploy", {
    http: "POST /v1/projects/{ref}/functions/deploy",
    description:
      "Deploy a Supabase Edge Function. Mirrors the Management API deploy endpoint, " +
      "which creates the function if it does not exist. The request has query-like " +
      "`slug` / `bundleOnly` fields and a body with `metadata` plus `file`. For this " +
      "mock, provide exactly one TypeScript source string in `file`. The runtime " +
      "supports standard Web APIs and Supabase-style `Deno.serve((req) => new Response(...))` handlers. " +
      "Do not import external modules in this eval.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "Optional query parameter. Function slug, e.g. `order-total`.",
        },
        bundleOnly: {
          type: "boolean",
          description: "Optional query parameter. If true, only validates/bundles the function.",
        },
        metadata: {
          type: "object",
          properties: {
            name: { type: "string", description: "Function display name." },
            slug: { type: "string", description: "Function slug." },
            verify_jwt: { type: "boolean" },
            import_map: { type: "boolean" },
            entrypoint_path: { type: "string" },
            import_map_path: { type: "string" },
          },
          required: ["name"],
          description: "Required Management API function metadata object.",
        },
        file: {
          type: "array",
          items: { type: "string" },
          description:
            "Function source files. For this mock, include exactly one complete index.ts source string.",
        },
      },
      required: ["metadata", "file"],
    },
    handler: async (body, { edgeFunctions }) => edgeFunctions.deploy(body),
  });

  m.set("functions.list", {
    http: "GET /v1/projects/{ref}/functions",
    description: "List Supabase Edge Functions deployed in this project.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (_body: Record<string, never>, { edgeFunctions }) => edgeFunctions.list(),
  });

  return m;
}
