import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { bootSparkBackend, sparkRuntime } from './spark-runtime.js';
import type { McpServerDefinition } from './index.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('requires a Spark API URL', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(bootSparkBackend('')).rejects.toThrow('SPARK_API_URL');
  await expect(
    sparkRuntime({ apiUrl: '', mcpServers: [] }).startSession({})
  ).rejects.toThrow('SPARK_API_URL');
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['127.0.0.1', '0.0.0.0', '::1'])(
  'serves the adapter on %s',
  async (hostname) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let migration: unknown;
    let sqlQuery: unknown;
    let rejectMigration = false;
    let adapterUrl = '';
    let token = '';
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === 'https://control.example/v1/projects') {
          return Response.json(
            {
              ref: 'testproject',
              url: 'https://spark.example',
              api_keys: [
                { type: 'secret', api_key: 'secret' },
                { type: 'publishable', api_key: 'publishable' },
              ],
            },
            { status: 201 }
          );
        }
        if (url === 'https://spark.example/system/v1/migrations') {
          if (rejectMigration)
            return new Response('Upstream unavailable', {
              status: 502,
              headers: { 'content-type': 'text/plain' },
            });
          migration = JSON.parse(String(init?.body));
          return Response.json(
            { version: '20261030120000', name: 'tasks', notices: [] },
            { status: 201 }
          );
        }
        if (url === 'https://spark.example/database/query') {
          expect(init?.headers).toMatchObject({ apikey: 'secret' });
          sqlQuery = JSON.parse(String(init?.body));
          if (rejectMigration)
            return new Response('Query unavailable', { status: 502 });
          return Response.json([{ value: 1 }]);
        }
        return realFetch(input, init);
      }
    );
    const mcp: McpServerDefinition = {
      name: 'test',
      promptAddendum: 'Use the Spark tools.',
      async createConfig(context) {
        adapterUrl = context?.apiUrl ?? '';
        token = context?.accessToken ?? '';
        return { config: { command: 'test' } };
      },
    };
    const apiUrl = 'https://control.example/';
    const runtime = sparkRuntime({ apiUrl, mcpServers: [mcp] });
    const fixtureDir = await mkdtemp(join(tmpdir(), 'spark-fixture-'));
    const projectSeedSql = join(fixtureDir, 'project.sql');
    const seedSql =
      'create table seeded (id int); insert into seeded values (1);';
    await writeFile(projectSeedSql, seedSql);
    const session = await runtime.startSession({ hostname, projectSeedSql });
    try {
      expect(migration).toMatchObject({ name: 'eval_fixture', sql: seedSql });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('Spark project created: testproject')
      );
      expect(session.promptAddendum).toBe('Use the Spark tools.');
      expect(session.scoringContext).not.toHaveProperty('accessToken');
      expect(session.scoringContext).not.toHaveProperty('close');
      const headers = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      };
      expect((await realFetch(`${adapterUrl}/v1/projects`, {})).status).toBe(
        401
      );
      expect(
        (await realFetch(`${adapterUrl}/v1/projects/testproject`, { headers }))
          .status
      ).toBe(501);
      const response = await realFetch(
        `${adapterUrl}/v1/projects/testproject/database/migrations`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name: 'tasks',
            query: 'create table tasks (id int)',
          }),
        }
      );
      expect(response.status).toBe(201);
      expect(migration).toMatchObject({
        name: 'tasks',
        sql: 'create table tasks (id int)',
      });
      for (const body of ['{', JSON.stringify({ name: 'tasks' })]) {
        const invalid = await realFetch(
          `${adapterUrl}/v1/projects/testproject/database/migrations`,
          { method: 'POST', headers, body }
        );
        expect(invalid.status).toBe(400);
      }
      rejectMigration = true;
      const failed = await realFetch(
        `${adapterUrl}/v1/projects/testproject/database/migrations`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: 'tasks', query: 'select 1' }),
        }
      );
      expect(failed.status).toBe(502);
      expect(failed.headers.get('content-type')).toBe('text/plain');
      expect(await failed.text()).toBe('Upstream unavailable');
      rejectMigration = false;
      const query = await realFetch(
        `${adapterUrl}/v1/projects/testproject/database/query`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query: 'select $1',
            parameters: [1],
            read_only: true,
          }),
        }
      );
      expect(query.status).toBe(200);
      expect(await query.json()).toEqual([{ value: 1 }]);
      expect(sqlQuery).toEqual({
        query: 'select $1',
        parameters: [1],
        read_only: true,
      });
      expect(await session.scoringContext.query('select 1')).toEqual({
        rows: [{ value: 1 }],
      });
      const invalidQuery = await realFetch(
        `${adapterUrl}/v1/projects/testproject/database/query`,
        { method: 'POST', headers, body: JSON.stringify({ query: 1 }) }
      );
      expect(invalidQuery.status).toBe(400);
      rejectMigration = true;
      const failedQuery = await realFetch(
        `${adapterUrl}/v1/projects/testproject/database/query`,
        { method: 'POST', headers, body: JSON.stringify({ query: 'select 1' }) }
      );
      expect(failedQuery.status).toBe(502);
      expect(await failedQuery.text()).toBe('Query unavailable');
      await expect(session.scoringContext.query('select 1')).rejects.toThrow(
        'Spark query failed (502): Query unavailable'
      );
      await expect(
        runtime.startSession({ hostname, projectSeedSql })
      ).rejects.toThrow('Spark fixture failed (502): Upstream unavailable');
    } finally {
      await session.close();
      await rm(fixtureDir, { recursive: true, force: true });
    }
    await expect(
      sparkRuntime({ apiUrl, mcpServers: [mcp, mcp] }).startSession({
        hostname,
      })
    ).rejects.toThrow('duplicate MCP server name');
  }
);
