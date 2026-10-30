import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { format } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createManagementApiClient } from '@supabase-evals/platform-lite';
import { z } from 'zod';
import type {
  EvalRuntime,
  EvalSessionArgs,
  McpServerDefinition,
  PlatformBackend,
} from './index.js';

const projectSchema = z.object({
  ref: z.string(),
  url: z.string().url(),
  api_keys: z.array(z.object({ type: z.string(), api_key: z.string() })),
});
const migrationSchema = z.object({ name: z.string(), query: z.string() });

export async function bootSparkBackend(
  apiUrl: string,
  args: EvalSessionArgs = {}
): Promise<PlatformBackend> {
  if (!apiUrl.trim())
    throw new Error('Set SPARK_API_URL to the Spark control API URL');
  const created = await fetch(new URL('/v1/projects', apiUrl), {
    method: 'POST',
  });
  if (!created.ok)
    throw new Error(`Spark project creation failed: ${created.status}`);
  const project = projectSchema.parse(await created.json());
  const secret = project.api_keys.find((key) => key.type === 'secret')?.api_key;
  const publishable = project.api_keys.find(
    (key) => key.type === 'publishable'
  )?.api_key;
  if (!secret || !publishable)
    throw new Error(`Spark project ${project.ref} is missing API keys`);
  process.stderr.write(
    `Spark project created: ${project.ref} (cleanup endpoint not yet confirmed)\n`
  );
  let version = BigInt(
    new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  );
  const token = `sbp_${randomBytes(20).toString('hex')}`;
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.headers.authorization !== `Bearer ${token}`) {
        send(401, { message: 'Unauthorized' });
        return;
      }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/v1/projects') {
        send(200, [
          {
            id: project.ref,
            ref: project.ref,
            name: project.ref,
            status: 'ACTIVE_HEALTHY',
            region: 'us-east-2',
            organization_id: 'default-org',
          },
        ]);
      } else if (
        path === `/v1/projects/${project.ref}/database/migrations` &&
        req.method === 'POST'
      ) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const input = migrationSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString())
        );
        const response = await fetch(`${project.url}/system/v1/migrations`, {
          method: 'POST',
          headers: { apikey: secret, 'content-type': 'application/json' },
          body: JSON.stringify({
            version: String(version++),
            name: input.name,
            sql: input.query,
          }),
        });
        res.writeHead(response.status, {
          'content-type':
            response.headers.get('content-type') ?? 'application/json',
        });
        res.end(await response.text());
      } else if (
        path === `/v1/projects/${project.ref}/database/migrations` &&
        req.method === 'GET'
      ) {
        const response = await fetch(`${project.url}/system/v1/migrations`, {
          headers: { apikey: secret },
        });
        res.writeHead(response.status, {
          'content-type':
            response.headers.get('content-type') ?? 'application/json',
        });
        res.end(await response.text());
      } else {
        send(501, {
          message: `Spark POC does not implement ${req.method} ${path}`,
        });
      }
    } catch (error) {
      send(
        error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500,
        {
          message:
            error instanceof Error ? error.message : 'Spark adapter failed',
        }
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, args.hostname ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Spark adapter failed to listen');
  const hostname =
    address.address === '0.0.0.0' || address.address === '::'
      ? '127.0.0.1'
      : address.address;
  const url = format({ protocol: 'http', hostname, port: address.port });
  return {
    url,
    ref: project.ref,
    accessToken: token,
    mgmt: createManagementApiClient(url, token),
    client: createClient(project.url, secret),
    getClient: () => createClient(project.url, publishable),
    query: async () => {
      throw new Error('Spark SQL query endpoint is not available yet');
    },
    invokeFunction: async () => {
      throw new Error('Spark function invocation is not implemented');
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

export function sparkRuntime(options: {
  apiUrl: string;
  mcpServers: McpServerDefinition[];
}): EvalRuntime {
  return {
    id: 'spark',
    async startSession(args) {
      const backend = await bootSparkBackend(options.apiUrl, args);
      const mcpServers: Record<
        string,
        Awaited<ReturnType<McpServerDefinition['createConfig']>>['config']
      > = {};
      const cleanup: Array<() => Promise<void>> = [];
      try {
        for (const mcp of options.mcpServers) {
          if (mcp.name in mcpServers)
            throw new Error(`duplicate MCP server name: ${mcp.name}`);
          const resolved = await mcp.createConfig({
            apiUrl: backend.url,
            accessToken: backend.accessToken,
          });
          mcpServers[mcp.name] = resolved.config;
          if (resolved.cleanup) cleanup.push(resolved.cleanup);
        }
        return {
          mcpServers,
          promptAddendum:
            options.mcpServers
              .map((mcp) => mcp.promptAddendum)
              .filter(Boolean)
              .join('\n\n') || undefined,
          scoringContext: {
            mgmt: backend.mgmt,
            ref: backend.ref,
            client: backend.client,
            getClient: backend.getClient,
            query: backend.query,
            invokeFunction: backend.invokeFunction,
          },
          close: async () => {
            try {
              await Promise.all(cleanup.map((fn) => fn()));
            } finally {
              await backend.close();
            }
          },
        };
      } catch (error) {
        await Promise.allSettled(cleanup.map((fn) => fn()));
        await backend.close();
        throw error;
      }
    },
  };
}
