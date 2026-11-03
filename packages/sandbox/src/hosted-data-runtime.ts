import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import {
  supabaseMcpServer,
  type LocalStackRuntime,
} from '@supabase-evals/core';
import { createAgentEnvironment } from './agent-environment.js';
import {
  buildLocalStackScoringContext,
  buildLocalStackTools,
  localStackRuntime,
  toAgentSandbox,
} from './local-stack-runtime.js';

/** Runs backend app scenarios against a hosted Data API without a local stack. */
export function hostedDataRuntime(): LocalStackRuntime {
  return {
    id: 'hosted-data-api',
    async startSession(args) {
      const hosted = args.hosted;
      const dataApi = hosted?.dataApi;
      if (!hosted || !dataApi)
        throw new Error(
          'Hosted Data API runtime requires a hosted project with connection settings'
        );
      const appEnvPath = args.localDir
        ? join(args.localDir, 'app', '.env')
        : undefined;
      const appEnv =
        appEnvPath && existsSync(appEnvPath)
          ? readFileSync(appEnvPath, 'utf8')
          : undefined;
      const connection = {
        SUPABASE_URL: dataApi.apiUrl,
        SUPABASE_SECRET_KEY: dataApi.secretKey,
        SUPABASE_PUBLISHABLE_KEY: dataApi.publishableKey,
      };
      const env = await createAgentEnvironment({
        localDir: args.localDir,
        skills: args.skills,
        mounts: args.mounts,
        env: appEnv === undefined ? connection : undefined,
      });
      try {
        if (appEnv !== undefined) {
          const retained = appEnv
            .split('\n')
            .filter(
              (line) =>
                !Object.keys(connection).some((key) =>
                  line.startsWith(`${key}=`)
                )
            );
          await env.sandbox.writeFiles({
            'app/.env':
              [
                ...retained,
                ...Object.entries(connection).map(
                  ([key, value]) => `${key}=${value}`
                ),
              ].join('\n') + '\n',
          });
        }
        const docs = await supabaseMcpServer({
          features: ['docs'],
        }).createConfig();
        const sandbox = env.sandbox;
        return {
          tools: buildLocalStackTools(sandbox),
          sandbox: toAgentSandbox(sandbox),
          mcpServers: { 'supabase-mcp': docs.config },
          scoringContext: {
            ...buildLocalStackScoringContext(sandbox, hosted),
            query: hosted.query,
            stackStatus: async () => dataApi,
            getClient: async () =>
              createClient(dataApi.apiUrl, dataApi.publishableKey, {
                auth: { persistSession: false, autoRefreshToken: false },
              }),
          },
          exportWorkspace: (hostDir) =>
            sandbox.copyToHost(sandbox.workdir, hostDir),
          close: async () => {
            try {
              await docs.cleanup?.();
            } finally {
              await env.close();
            }
          },
        };
      } catch (error) {
        await env.close();
        throw error;
      }
    },
  };
}

/** Keeps the real CLI while scoring the linked hosted database. */
export function hostedCliRuntime(
  options: { mcpFeatures?: string[] } = {}
): LocalStackRuntime {
  const runtime = localStackRuntime(options);
  return {
    ...runtime,
    id: 'hosted-cli',
    async startSession(args) {
      const hosted = args.hosted;
      const dataApi = hosted?.dataApi;
      if (!hosted || !dataApi)
        throw new Error(
          'Hosted CLI runtime requires hosted connection settings'
        );
      const session = await runtime.startSession({
        ...args,
        projectRunning: false,
      });
      return {
        ...session,
        ensureReady: undefined,
        scoringContext: {
          ...session.scoringContext,
          query: hosted.query,
          stackStatus: async () => dataApi,
          getClient: async () =>
            createClient(dataApi.apiUrl, dataApi.publishableKey, {
              auth: { persistSession: false, autoRefreshToken: false },
            }),
        },
      };
    },
  };
}
