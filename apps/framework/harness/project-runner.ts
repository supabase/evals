import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { CommandResult, VitestResult } from '@supabase-evals/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PROJECT_DB_URL = 'http://supabase-evals.local';
const PROJECT_DB_ANON_KEY = 'supabase-evals-anon-key';
const PROJECT_DB_JWT_SECRET = 'supabase-evals-dev-secret';
const PROJECT_ENV = {
  VITE_SUPABASE_URL: PROJECT_DB_URL,
  VITE_SUPABASE_ANON_KEY: PROJECT_DB_ANON_KEY,
};

// Vite/vitest resolve their own package (and the workspace's deps, e.g. react)
// by walking up from the workspace looking for a node_modules dir. Workspaces
// live under results/, outside ROOT, so link ROOT's node_modules in directly.
// The link replaces anything already there, since an agent that ran npm install
// in the sandbox exports its own node_modules.
function linkNodeModules(workspace: string) {
  const link = join(workspace, 'node_modules');
  rmSync(link, { recursive: true, force: true });
  symlinkSync(join(ROOT, 'node_modules'), link, 'dir');
}

export async function viteBuild(workspace: string): Promise<CommandResult> {
  linkNodeModules(workspace);
  return runNodeBin(
    join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    ['build'],
    workspace,
    PROJECT_ENV
  );
}

export async function vitestRun(workspace: string): Promise<VitestResult> {
  linkNodeModules(workspace);
  const reportPath = join(workspace, 'vitest-report.json');
  const configPath = join(workspace, 'vitest.evals.config.ts');
  const setupDir = join(workspace, '.evals');
  const setupFile = join(setupDir, 'vitest-supalite-setup.ts');
  mkdirSync(setupDir, { recursive: true });
  writeFileSync(setupFile, setupSource());
  writeFileSync(
    configPath,
    [
      'import { defineConfig } from "vitest/config";',
      '',
      'export default defineConfig({',
      '  test: {',
      '    environment: "happy-dom",',
      `    setupFiles: [${JSON.stringify('./.evals/vitest-supalite-setup.ts')}],`,
      '    include: ["tests/**/*.test.{ts,tsx}"],',
      '  },',
      '});',
      '',
    ].join('\n')
  );
  const result = await runNodeBin(
    join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
    [
      'run',
      '--config',
      configPath,
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ],
    workspace,
    { ...PROJECT_ENV, SUPABASE_EVALS_WORKSPACE: workspace }
  );
  const parsed = existsSync(reportPath)
    ? parseVitestReport(reportPath)
    : undefined;
  return { ...result, ...parsed, ok: parsed?.ok ?? result.ok };
}

function setupSource() {
  return `
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";
import { App, getAuthSchemaSql, SUPABASE_AUTH_HELPERS_SQL } from "@supabase/lite";
import { createPgliteConnection } from "@supabase/lite/pglite";

const PROJECT_DB_URL = ${JSON.stringify(PROJECT_DB_URL)};
const PROJECT_DB_ANON_KEY = ${JSON.stringify(PROJECT_DB_ANON_KEY)};
const PROJECT_DB_JWT_SECRET = ${JSON.stringify(PROJECT_DB_JWT_SECRET)};
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
await connection.driver.exec(SUPABASE_AUTH_HELPERS_SQL);
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
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (exitCode) => {
      resolve({ ok: exitCode === 0, exitCode, stdout, stderr });
    });
  });
}

function parseVitestReport(
  path: string
): Pick<VitestResult, 'ok' | 'passed' | 'failed' | 'failures'> | undefined {
  try {
    const report = JSON.parse(readFileSync(path, 'utf8')) as any;
    const results = Array.isArray(report.testResults) ? report.testResults : [];
    const assertions = results.flatMap((file: any) =>
      Array.isArray(file.assertionResults) ? file.assertionResults : []
    );
    const passed = assertions.filter((a: any) => a.status === 'passed').length;
    const failed = assertions.filter((a: any) => a.status === 'failed').length;
    const failures = assertions
      .filter((a: any) => a.status === 'failed')
      .flatMap(
        (a: any) => a.failureMessages ?? [`${a.fullName ?? a.title} failed`]
      );
    return { ok: report.success === true, passed, failed, failures };
  } catch {
    return undefined;
  }
}
