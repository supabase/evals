import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { CommandResult, VitestResult } from "./types.js";

export type { CommandResult, VitestResult };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

export async function viteBuild(workspace: string): Promise<CommandResult> {
  return runNodeBin(
    join(ROOT, "node_modules", "vite", "bin", "vite.js"),
    ["build"],
    workspace
  );
}

export async function vitestRun(workspace: string): Promise<VitestResult> {
  const reportPath = join(workspace, "vitest-report.json");
  const configPath = join(workspace, "vitest.evals.config.ts");
  const setupDir = join(workspace, ".evals");
  const setupFile = join(setupDir, "vitest-supalite-setup.ts");
  mkdirSync(setupDir, { recursive: true });
  writeFileSync(setupFile, setupSource());
  writeFileSync(
    configPath,
    [
      'import { defineConfig } from "vitest/config";',
      "",
      "export default defineConfig({",
      "  test: {",
      '    environment: "happy-dom",',
      `    setupFiles: [${JSON.stringify("./.evals/vitest-supalite-setup.ts")}],`,
      '    include: ["tests/**/*.test.{ts,tsx}"],',
      "  },",
      "});",
      "",
    ].join("\n")
  );
  const result = await runNodeBin(
    join(ROOT, "node_modules", "vitest", "vitest.mjs"),
    ["run", "--config", configPath, "--reporter=json", `--outputFile=${reportPath}`],
    workspace,
    { SUPABASE_EVALS_WORKSPACE: workspace }
  );
  const parsed = existsSync(reportPath) ? parseVitestReport(reportPath) : undefined;
  return { ...result, ...parsed, ok: parsed?.ok ?? result.ok };
}

function setupSource() {
  return `
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";
import { App, getAuthSchemaSql } from "lite-supa";
import { createPgliteConnection } from "lite-supa/pglite";

const PROJECT_DB_URL = "http://supabase-evals.local";
const PROJECT_DB_ANON_KEY = "supabase-evals-anon-key";
const PROJECT_DB_JWT_SECRET = "supabase-evals-dev-secret";
const AUTH_SQL = \`
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
DO $$
BEGIN
  EXECUTE format('GRANT anon, authenticated, service_role TO %I', current_user);
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.role', true), '');
$$;
\`;

const workspace = process.env.SUPABASE_EVALS_WORKSPACE;
if (!workspace) throw new Error("SUPABASE_EVALS_WORKSPACE is required");

const connection = await createPgliteConnection();
const app = new App({
  connection,
  auth: {
    enabled: true,
    jwt_secret: PROJECT_DB_JWT_SECRET,
    enable_signup: true,
    email: { enable_confirmations: false },
  },
});

await app.init();
await connection.driver.exec(AUTH_SQL);
await connection.driver.exec(getAuthSchemaSql());

const schemaDir = join(workspace, "supabase", "schemas");
if (existsSync(schemaDir)) {
  for (const file of readdirSync(schemaDir).filter((f) => f.endsWith(".sql")).sort()) {
    await connection.driver.exec(readFileSync(join(schemaDir, file), "utf8"));
  }
}

const seed = join(workspace, "supabase", "seed.sql");
if (existsSync(seed)) {
  await connection.driver.exec(readFileSync(seed, "utf8"));
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).origin === PROJECT_DB_URL) {
    return app.fetch(request);
  }
  return originalFetch(input, init);
};

Object.assign(globalThis, {
  __SUPABASE_EVALS_APP__: app,
  __SUPABASE_EVALS_CLIENT__: app.getClient(),
  __SUPABASE_EVALS_URL__: PROJECT_DB_URL,
  __SUPABASE_EVALS_ANON_KEY__: PROJECT_DB_ANON_KEY,
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await connection.close();
});
`;
}

async function runNodeBin(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (exitCode) => {
      resolve({ ok: exitCode === 0, exitCode, stdout, stderr });
    });
  });
}

function parseVitestReport(path: string):
  | Pick<VitestResult, "ok" | "passed" | "failed" | "failures">
  | undefined {
  try {
    const report = JSON.parse(readFileSync(path, "utf8")) as any;
    const results = Array.isArray(report.testResults) ? report.testResults : [];
    const assertions = results.flatMap((file: any) =>
      Array.isArray(file.assertionResults) ? file.assertionResults : []
    );
    const passed = assertions.filter((a: any) => a.status === "passed").length;
    const failed = assertions.filter((a: any) => a.status === "failed").length;
    const failures = assertions
      .filter((a: any) => a.status === "failed")
      .flatMap((a: any) => a.failureMessages ?? [`${a.fullName ?? a.title} failed`]);
    return { ok: report.success === true, passed, failed, failures };
  } catch {
    return undefined;
  }
}
