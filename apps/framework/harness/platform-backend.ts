import vm from "node:vm";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ts from "typescript";
import { createPlatform, createManagementApiClient } from "platform-lite";
import type { ProjectInstance, ManagementApiClient, LogRow } from "platform-lite";
import type {
  EdgeFunctionsInvokeInput,
  EdgeFunctionsInvokeResult,
} from "./types.js";

export const ACCESS_TOKEN = "eval-token";

// Synthetic URL lite-supa's App.fetch recognises for in-process supabase-js calls.
const RUNTIME_URL = "http://supabase-evals.local";

export interface PlatformBackend {
  url: string;
  ref: string;
  accessToken: string;
  mgmt: ManagementApiClient;
  client: SupabaseClient;
  getClient: () => SupabaseClient;
  query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
  invokeFunction: (input: EdgeFunctionsInvokeInput) => Promise<EdgeFunctionsInvokeResult>;
  close: () => Promise<void>;
}

export async function bootPlatformBackend(opts: {
  projectSeedSql?: string;
  logsSeedJsonl?: string;
}): Promise<PlatformBackend> {
  const sql =
    opts.projectSeedSql && existsSync(opts.projectSeedSql)
      ? readFileSync(opts.projectSeedSql, "utf8")
      : undefined;

  const logs =
    opts.logsSeedJsonl && existsSync(opts.logsSeedJsonl)
      ? parseJsonl(opts.logsSeedJsonl)
      : undefined;

  const platform = await createPlatform({
    accessToken: ACCESS_TOKEN,
    projects: [{ sql, logs }],
  });

  const server = await platform.listen();

  const refs = platform.refs();
  if (refs.length === 0) throw new Error("platform backend: no projects");
  const ref = refs[0];
  const instance = platform.getProject(ref)!;

  return {
    url: server.url,
    ref,
    accessToken: ACCESS_TOKEN,
    mgmt: createManagementApiClient(server.url, ACCESS_TOKEN),
    client: instance.app.getClient(),
    getClient: () => instance.app.getClient(),
    query: async (sql) => {
      const results = await instance.pglite.exec(sql);
      // Find the last result set that has named fields — multi-statement queries
      // (e.g. BEGIN/SET/query/ROLLBACK) return multiple result sets; ROLLBACK
      // produces an empty one so we skip it.
      const lastRowSet = [...results].reverse().find(
        (r) => Array.isArray((r as any).fields) && (r as any).fields.length > 0
      ) as any;
      return { rows: (lastRowSet?.rows ?? []) as Record<string, unknown>[] };
    },
    invokeFunction: (input) => invokeEdgeFunction(instance, input),
    close: () => server.dispose(),
  };
}


function parseJsonl(path: string): LogRow[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      const obj = JSON.parse(line) as {
        id?: string;
        ts?: string;
        source?: string;
        level?: string;
        message?: string;
        metadata?: Record<string, unknown>;
      };
      return {
        id: obj.id,
        ts: obj.ts ? new Date(obj.ts) : new Date(),
        source: obj.source ?? "unknown",
        level: obj.level ?? "info",
        message: obj.message ?? "",
        metadata: obj.metadata,
      };
    });
}

// ---------------------------------------------------------------------------
// Edge function invocation via Node.js VM (TypeScript compiled in-process)
// ---------------------------------------------------------------------------

function generateAnonKey(ref: string, jwtSecret: string): string {
  const b64url = (s: string) => Buffer.from(s).toString("base64url");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(
    JSON.stringify({
      role: "anon",
      iss: "supabase-lite",
      ref,
      iat: Math.floor(Date.now() / 1000),
      exp: 9999999999,
    })
  );
  const sig = createHmac("sha256", jwtSecret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

async function invokeEdgeFunction(
  instance: ProjectInstance,
  input: EdgeFunctionsInvokeInput
): Promise<EdgeFunctionsInvokeResult> {
  const fn = instance.functions.get(input.name);
  if (!fn) throw new Error(`edge function not found: ${input.name}`);
  const source = fn.files[0]?.content;
  if (!source) throw new Error(`edge function ${input.name} has no source`);

  const anonKey = generateAnonKey(instance.ref, instance.jwtSecret);
  const projectFetch = (req: Request) => instance.app.fetch(req);
  const runtimeFetch = createRuntimeFetch(RUNTIME_URL, projectFetch);
  const handler = compileEdgeFunction(source, RUNTIME_URL, anonKey, runtimeFetch);

  const method = (input.method ?? "POST").toUpperCase();
  const headers = new Headers(input.headers ?? {});
  const hasBody =
    method !== "GET" && method !== "HEAD" && input.body !== undefined;
  const bodyStr =
    typeof input.body === "string"
      ? input.body
      : input.body === undefined
        ? undefined
        : JSON.stringify(input.body);

  if (bodyStr !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const request = new Request(
    `https://project-ref.functions.supabase.co/${input.name}${input.path ?? ""}`,
    { method, headers, body: hasBody ? bodyStr : undefined }
  );

  const response = await Promise.resolve(handler(request));
  if (!(response instanceof Response)) {
    throw new Error(`edge function ${input.name} did not return a Response`);
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
}

type EdgeHandler = (req: Request) => Response | Promise<Response>;

function createRuntimeFetch(
  runtimeUrl: string,
  projectFetch: (req: Request) => Promise<Response>
): typeof fetch {
  const origin = new URL(runtimeUrl).origin;
  return async (input, init) => {
    const req = new Request(input, init);
    const reqOrigin = new URL(req.url).origin;
    if (reqOrigin === origin || reqOrigin === "http://localhost") {
      return projectFetch(req);
    }
    return fetch(req);
  };
}

function compileEdgeFunction(
  source: string,
  url: string,
  anonKey: string,
  runtimeFetch: typeof fetch
): EdgeHandler {
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;

  let denoServeHandler: EdgeHandler | undefined;
  const exports: Record<string, unknown> = {};
  const module = { exports };

  const requireFromSandbox = (specifier: string) => {
    if (specifier === "@supabase/supabase-js") {
      return {
        createClient: (
          u: string,
          k: string,
          opts: Parameters<typeof createClient>[2] = {}
        ) =>
          createClient(u, k, {
            ...opts,
            global: { ...opts?.global, fetch: runtimeFetch },
          }),
      };
    }
    throw new Error(`edge function import not supported: ${specifier}`);
  };

  const sandbox = {
    Deno: {
      serve: (optOrHandler: unknown, maybeHandler?: unknown) => {
        const h =
          typeof optOrHandler === "function" ? optOrHandler : maybeHandler;
        if (typeof h !== "function")
          throw new Error("Deno.serve requires a handler");
        denoServeHandler = h as EdgeHandler;
      },
      env: {
        get: (key: string) =>
          key === "SUPABASE_URL"
            ? url
            : key === "SUPABASE_ANON_KEY"
              ? anonKey
              : undefined,
      },
    },
    fetch: runtimeFetch,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    Blob,
    FormData,
    TextDecoder,
    TextEncoder,
    atob,
    btoa,
    crypto,
    console: { log: () => undefined, warn: () => undefined, error: () => undefined },
    exports,
    module,
    require: requireFromSandbox,
  };

  vm.runInNewContext(js, sandbox, { timeout: 100, displayErrors: true });

  const exported = module.exports as Record<string, unknown>;
  const handler =
    denoServeHandler ??
    (typeof exported.default === "function" ? exported.default : undefined) ??
    (typeof exports.default === "function" ? exports.default : undefined);

  if (!handler)
    throw new Error(
      "edge function must call Deno.serve(handler) or export a default handler"
    );

  return handler as EdgeHandler;
}
