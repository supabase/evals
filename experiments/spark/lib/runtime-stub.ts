import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  AgentSandbox,
  ToolEvalContext,
  ToolScorer,
} from '@supabase-evals/core';
import { onTestFinished, vi } from 'vitest';
import { sparkRuntime } from './runtime.js';

export const SPARK_TEST_KEYS = {
  secret: 'sb_secret_test_key_0123456789',
  publishable: 'sb_publishable_test_key_0123456789',
};

/** Answers a request the scorer makes to the project: the Data API, auth or the SQL endpoint. */
export type SparkStubHandler = (
  url: URL,
  init: RequestInit | undefined,
  request: Request | undefined
) => Response | Promise<Response>;

/**
 * Runs a Spark scorer against a stubbed Spark: project creation succeeds and
 * every other request goes to `handler`. Fills in an empty transcript, no
 * report and a judge that passes; override any of them through `context`.
 * Removes the stub when done.
 */
export async function sparkScorer(
  scorer: ToolScorer,
  handler: SparkStubHandler,
  context: Partial<ToolEvalContext> = {}
) {
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : undefined;
      const url = new URL(request ? request.url : String(input));
      if (url.pathname === '/v1/projects')
        return Response.json({
          ref: 'project',
          url: 'https://project.example',
          api_keys: [
            { type: 'secret', api_key: SPARK_TEST_KEYS.secret },
            { type: 'publishable', api_key: SPARK_TEST_KEYS.publishable },
          ],
        });
      return handler(url, init, request);
    }
  );
  try {
    const session = await sparkRuntime('https://control.example').startSession(
      {}
    );
    try {
      return await scorer({
        ...session.scoringContext,
        toolCalls: [],
        transcript: [],
        agentReport: '',
        judge: vi.fn(async () => ({ passed: true })),
        ...Object.fromEntries(
          Object.entries(context).filter(([, value]) => value !== undefined)
        ),
      });
    } finally {
      await session.close();
    }
  } finally {
    vi.unstubAllGlobals();
  }
}

/** Transcript parts for bash commands the agent ran. */
export const bashCalls = (commands: string[]) =>
  commands.map((command) => ({
    type: 'tool_call' as const,
    name: 'bash',
    input: { command },
  }));

/** Names of the checks that failed. */
export const failedChecks = (result: Awaited<ReturnType<ToolScorer>>) =>
  (result.checks ?? []).filter((check) => !check.passed).map((c) => c.name);

/**
 * A sandbox over a real temp workspace holding `files` (paths relative to the
 * workspace), run with the real shell and node. `npm install` is a no-op and
 * `@supabase/supabase-js` resolves to a stub package, so no network is needed.
 * Call it inside a test: the workspace is removed when that test finishes.
 */
export function stubSandbox(files: Record<string, string>): AgentSandbox {
  const workspace = mkdtempSync(join(tmpdir(), 'spark-stub-'));
  onTestFinished(() => rmSync(workspace, { recursive: true, force: true }));
  const sdk = 'app/node_modules/@supabase/supabase-js';
  for (const [path, content] of Object.entries({
    'app/package.json': '{"type":"module"}',
    [`${sdk}/package.json`]:
      '{"name":"@supabase/supabase-js","main":"index.js"}',
    [`${sdk}/index.js`]: 'exports.createClient = () => ({});',
    ...files,
  })) {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), content);
  }
  return {
    workspace,
    exec: (command, options) =>
      new Promise((resolve) =>
        execFile(
          'bash',
          ['-c', command.replace('npm install', 'true')],
          {
            cwd: workspace,
            env: { ...process.env, ...options?.env },
            timeout: options?.timeoutMs,
          },
          (error, stdout, stderr) =>
            resolve({
              ok: !error,
              exitCode: error ? Number(error.code ?? 1) : 0,
              stdout,
              stderr,
            })
        )
      ),
    readFile: async () => '',
    copyToHost: async () => {},
  };
}
