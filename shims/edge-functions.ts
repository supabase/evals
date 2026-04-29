import vm from "node:vm";
import { createClient } from "@supabase/supabase-js";
import ts from "typescript";

export interface EdgeFunctionRuntime {
  url: string;
  anonKey: string;
  fetch: (request: Request) => Promise<Response>;
}

export interface EdgeFunctionsHandle {
  deploy: (input: DeployFunctionInput) => Promise<EdgeFunctionMetadata>;
  list: () => EdgeFunctionMetadata[];
  invoke: (input: InvokeFunctionInput) => Promise<InvokeFunctionResult>;
}

export interface DeployFunctionInput {
  slug?: string;
  bundleOnly?: boolean;
  file?: string[];
  metadata: {
    slug?: string;
    name?: string;
    verify_jwt?: boolean;
    import_map?: boolean;
    entrypoint_path?: string;
    import_map_path?: string;
  };
}

export interface InvokeFunctionInput {
  name: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface InvokeFunctionResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface EdgeFunctionMetadata {
  id: string;
  slug: string;
  name: string;
  status: "ACTIVE";
  version: number;
  created_at: number;
  updated_at: number;
  verify_jwt: boolean;
  import_map: boolean;
  entrypoint_path: string;
  import_map_path: string;
  ezbr_sha256: string;
}

type EdgeHandler = (request: Request) => Response | Promise<Response>;
type RuntimeProvider = () => EdgeFunctionRuntime | undefined;

interface StoredFunction {
  metadata: EdgeFunctionMetadata;
  code: string;
  handler: EdgeHandler;
}

export function bootEdgeFunctions(getRuntime: RuntimeProvider = () => undefined): EdgeFunctionsHandle {
  const functions = new Map<string, StoredFunction>();

  return {
    deploy: async ({ slug: querySlug, bundleOnly = false, file, metadata }) => {
      const slug = querySlug ?? metadata.slug ?? metadata.name;
      if (!slug) throw new Error("functions.deploy requires a slug");
      validateFunctionSlug(slug);
      const code = extractEntrypointSource(file);
      const handler = bundleOnly ? stubHandler : compileEdgeFunction(code, getRuntime);
      const existing = functions.get(slug);
      const now = Date.now();
      const nextMetadata: EdgeFunctionMetadata = {
        id: existing?.metadata.id ?? `fn_${slug}`,
        slug,
        name: metadata.name ?? slug,
        status: "ACTIVE",
        version: (existing?.metadata.version ?? 0) + 1,
        created_at: existing?.metadata.created_at ?? now,
        updated_at: now,
        verify_jwt: metadata.verify_jwt ?? existing?.metadata.verify_jwt ?? true,
        import_map: metadata.import_map ?? existing?.metadata.import_map ?? false,
        entrypoint_path: metadata.entrypoint_path ?? existing?.metadata.entrypoint_path ?? "index.ts",
        import_map_path: metadata.import_map_path ?? existing?.metadata.import_map_path ?? "",
        ezbr_sha256: `mock-${hashSource(code)}`,
      };
      functions.set(slug, {
        metadata: nextMetadata,
        code,
        handler,
      });
      return nextMetadata;
    },
    list: () =>
      Array.from(functions.values()).map(({ metadata }) => ({ ...metadata })),
    invoke: async (input) => {
      const fn = functions.get(input.name);
      if (!fn) throw new Error(`function not found: ${input.name}`);

      const method = (input.method ?? "POST").toUpperCase();
      const headers = new Headers(input.headers ?? {});
      const hasBody = method !== "GET" && method !== "HEAD" && input.body !== undefined;
      const body =
        typeof input.body === "string"
          ? input.body
          : input.body === undefined
            ? undefined
            : JSON.stringify(input.body);

      if (body !== undefined && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }

      const request = new Request(
        `https://project-ref.functions.supabase.co/${input.name}${input.path ?? ""}`,
        {
          method,
          headers,
          body: hasBody ? body : undefined,
        }
      );

      const response = await Promise.resolve(fn.handler(request));
      if (!(response instanceof Response)) {
        throw new Error(`function ${input.name} did not return a Response`);
      }

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      };
    },
  };
}

function validateFunctionSlug(slug: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    throw new Error(
      "function slug must be 1-63 chars of lowercase letters, numbers, or hyphens"
    );
  }
}

function extractEntrypointSource(file: string[] | undefined): string {
  if (!file?.length) throw new Error("functions.deploy requires at least one file");
  if (file.length > 1) {
    throw new Error("mock functions.deploy currently supports exactly one source file");
  }
  return file[0];
}

function hashSource(code: string): string {
  let hash = 0;
  for (let i = 0; i < code.length; i += 1) {
    hash = (hash * 31 + code.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function stubHandler(): Response {
  return new Response("bundle only", { status: 501 });
}

function compileEdgeFunction(code: string, getRuntime: RuntimeProvider): EdgeHandler {
  if (!code.trim()) throw new Error("function code is required");

  const js = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;

  let denoServeHandler: EdgeHandler | undefined;
  const exports: Record<string, unknown> = {};
  const module = { exports };
  const runtimeFetch = createRuntimeFetch(getRuntime);
  const requireFromSandbox = (specifier: string) => {
    if (specifier === "@supabase/supabase-js") {
      return {
        createClient: (
          url: string,
          key: string,
          options: Parameters<typeof createClient>[2] = {}
        ) =>
          createClient(url, key, {
            ...options,
            global: {
              ...options.global,
              fetch: runtimeFetch,
            },
          }),
      };
    }
    throw new Error(`edge function import is not supported: ${specifier}`);
  };
  const sandbox = {
    Deno: {
      serve: (optionsOrHandler: unknown, maybeHandler?: unknown) => {
        const handler =
          typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler;
        if (typeof handler !== "function") {
          throw new Error("Deno.serve requires a request handler");
        }
        denoServeHandler = handler as EdgeHandler;
      },
      env: {
        get: (key: string) => {
          const runtime = getRuntime();
          if (!runtime) return undefined;
          if (key === "SUPABASE_URL") return runtime.url;
          if (key === "SUPABASE_ANON_KEY") return runtime.anonKey;
          return undefined;
        },
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
    console: {
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    crypto,
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

  if (!handler) {
    throw new Error(
      "function code must call Deno.serve(handler) or export a default handler"
    );
  }

  return handler as EdgeHandler;
}

function createRuntimeFetch(getRuntime: RuntimeProvider): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const runtime = getRuntime();
    if (!runtime) {
      return fetch(request);
    }

    const requestUrl = new URL(request.url);
    const runtimeUrl = new URL(runtime.url);
    if (requestUrl.origin === runtimeUrl.origin || requestUrl.origin === "http://localhost") {
      return runtime.fetch(request);
    }

    return fetch(request);
  };
}
