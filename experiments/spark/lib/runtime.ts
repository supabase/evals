import { readFile, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { createManagementApiClient } from '@supabase-evals/platform-lite';
import { z } from 'zod';
import type { EvalRuntime, ToolScoringContext } from '@supabase-evals/core';

const projectSchema = z.object({
  ref: z.string().min(1),
  url: z.url(),
  api_keys: z.array(z.object({ type: z.string(), api_key: z.string().min(1) })),
});
const rowsSchema = z.array(z.record(z.string(), z.unknown()));

export const SPARK_PROXY_BYPASS =
  'localhost,127.0.0.1,.openai.com,.anthropic.com,api.x.ai,ai-gateway.vercel.sh,.npmjs.org,.github.com,.githubusercontent.com';

/** The Spark project's URL and API keys, like `LocalStackStatus` for the local stack. */
export type SparkProjectStatus = {
  projectUrl: string;
  publishableKey: string;
  secretKey: string;
};

/** Scoring context plus the project's URL and keys. */
export type SparkScoringContext = ToolScoringContext & {
  project: SparkProjectStatus;
};

export function sparkRuntime(
  apiUrl: string,
  proxyUrl?: string,
  redactionPath?: string
): EvalRuntime {
  return {
    id: 'spark',
    async startSession(args) {
      if (!apiUrl.trim())
        throw new Error('Set SPARK_API_URL to the Spark control API URL');

      if (args.logsSeedJsonl || args.functionsSeedDir || args.pgvector)
        throw new Error(
          'Spark REST runtime only supports project.sql fixtures'
        );

      const seedSql = args.projectSeedSql
        ? await readFile(args.projectSeedSql, 'utf8')
        : undefined;
      const createResponse = await fetch(new URL('/v1/projects', apiUrl), {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
      });
      if (!createResponse.ok)
        throw new Error(
          `Spark project creation failed (${createResponse.status})`
        );
      const project = projectSchema.parse(await createResponse.json());
      if (redactionPath) {
        await writeFile(
          redactionPath,
          JSON.stringify([
            project.ref,
            project.url,
            new URL(project.url).hostname,
            ...project.api_keys.map((key) => key.api_key),
          ]),
          { mode: 0o600 }
        );
      }

      const secret = project.api_keys.find(
        (key) => key.type === 'secret'
      )?.api_key;
      const publishable = project.api_keys.find(
        (key) => key.type === 'publishable'
      )?.api_key;
      if (!secret || !publishable)
        throw new Error(`Spark project ${project.ref} is missing API keys`);

      // shortcut: projects remain allocated, add teardown once a deletion endpoint is confirmed.
      process.stderr.write('Spark project created\n');

      const headers = { apikey: secret, 'content-type': 'application/json' };
      if (seedSql) {
        const seedResponse = await fetch(
          new URL('/system/v1/migrations', project.url),
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              version: '1',
              name: 'eval_fixture',
              sql: seedSql,
            }),
            signal: AbortSignal.timeout(30_000),
          }
        );
        if (!seedResponse.ok)
          throw new Error(
            `Spark fixture failed (${seedResponse.status}): ${await seedResponse.text()}`
          );
      }

      const getClient = () =>
        createClient(project.url, secret, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
      return {
        mcpServers: {},
        env: {
          ...(proxyUrl
            ? {
                HTTPS_PROXY: proxyUrl,
                NO_PROXY: SPARK_PROXY_BYPASS,
                NODE_USE_ENV_PROXY: '1',
              }
            : {}),
          SPARK_PROJECT_URL: project.url,
          SPARK_SECRET_KEY: secret,
          SPARK_PUBLISHABLE_KEY: publishable,
        },
        scoringContext: {
          project: {
            projectUrl: project.url,
            publishableKey: publishable,
            secretKey: secret,
          },
          ref: project.ref,
          // Required by ToolScoringContext, but Spark's Management API is incomplete.
          mgmt: createManagementApiClient(apiUrl, secret),
          client: getClient(),
          getClient,
          async query(sql) {
            const response = await fetch(
              new URL('/database/query', project.url),
              {
                method: 'POST',
                headers,
                body: JSON.stringify({ query: sql }),
                signal: AbortSignal.timeout(30_000),
              }
            );
            if (!response.ok)
              throw new Error(
                `Spark scoring query failed (${response.status}): ${await response.text()}`
              );
            return { rows: rowsSchema.parse(await response.json()) };
          },
          async invokeFunction() {
            throw new Error(
              'Spark REST runtime does not support function invocation'
            );
          },
        } satisfies SparkScoringContext,
        async close() {},
      };
    },
  };
}
