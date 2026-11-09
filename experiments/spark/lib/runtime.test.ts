import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sparkRuntime } from './runtime.js';

afterEach(() => vi.unstubAllGlobals());

it('creates fresh projects, seeds before execution and reads scoring state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spark-runtime-'));
  const fixture = join(dir, 'project.sql');
  await writeFile(fixture, 'create table tasks (id integer);');
  let projectCount = 0;
  const fetchMock = vi.fn(async (url: URL, options?: RequestInit) => {
    if (url.pathname === '/v1/projects') {
      projectCount++;
      return Response.json({
        ref: `project${projectCount}`,
        url: `https://project${projectCount}.example`,
        api_keys: [
          { type: 'secret', api_key: 'secret' },
          { type: 'publishable', api_key: 'publishable' },
        ],
      });
    }
    expect(options?.headers).toEqual({
      apikey: 'secret',
      'content-type': 'application/json',
    });
    if (url.pathname === '/system/v1/migrations') {
      expect(JSON.parse(String(options?.body))).toEqual({
        version: '1',
        name: 'eval_fixture',
        sql: 'create table tasks (id integer);',
      });
      return Response.json({});
    }
    expect(url.pathname).toBe('/database/query');
    expect(JSON.parse(String(options?.body))).toEqual({
      query: 'select 1',
    });
    return Response.json([{ value: 1 }]);
  });
  vi.stubGlobal('fetch', fetchMock);
  try {
    const runtime = sparkRuntime('https://control.example');
    const session = await runtime.startSession({ projectSeedSql: fixture });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(session.env?.SPARK_PROJECT_URL).toBe('https://project1.example');
    expect(session.mcpServers).toEqual({});
    expect(await session.scoringContext.query('select 1')).toEqual({
      rows: [{ value: 1 }],
    });
    const next = await runtime.startSession({});
    expect(next.scoringContext.ref).not.toBe(session.scoringContext.ref);
    await session.close();
    await next.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects configuration and unsupported fixtures before provisioning', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await expect(sparkRuntime('').startSession({})).rejects.toThrow(
    'SPARK_API_URL'
  );
  await expect(
    sparkRuntime('https://control.example').startSession({
      logsSeedJsonl: 'logs.jsonl',
    })
  ).rejects.toThrow('project.sql');
  await expect(
    sparkRuntime('https://control.example').startSession({
      projectSeedSql: '/missing-fixture.sql',
    })
  ).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('rejects failed provisioning and missing project keys', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(
      Response.json({ ref: 'p', url: 'https://p.example', api_keys: [] })
    );
  vi.stubGlobal('fetch', fetchMock);
  const runtime = sparkRuntime('https://control.example');
  await expect(runtime.startSession({})).rejects.toThrow('503');
  await expect(runtime.startSession({})).rejects.toThrow('missing API keys');
});

it('stops setup when Spark rejects the fixture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spark-fixture-'));
  const fixture = join(dir, 'project.sql');
  await writeFile(fixture, 'invalid SQL');
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        ref: 'project',
        url: 'https://project.example',
        api_keys: [
          { type: 'secret', api_key: 'secret' },
          { type: 'publishable', api_key: 'publishable' },
        ],
      })
    )
    .mockResolvedValueOnce(new Response('fixture rejected', { status: 400 }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    await expect(
      sparkRuntime('https://control.example').startSession({
        projectSeedSql: fixture,
      })
    ).rejects.toThrow('Spark fixture failed (400): fixture rejected');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
