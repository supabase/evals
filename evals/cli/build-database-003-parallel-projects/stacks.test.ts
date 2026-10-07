// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-003-parallel-projects
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { checkMarkerIsolation } from '../lib/markers.js';
import type { StackProbe } from '../lib/stack.js';
import type { ProjectDirs } from './projects.js';
import {
  checkBothStacksReady,
  checkDistinctPorts,
  checkSingleClientRow,
  readClientRowCounts,
  readClientRows,
  resolveClientStacks,
  type ClientStacks,
} from './stacks.js';

const DB_A = 'postgresql://postgres:secret@127.0.0.1:54322/postgres';
const DB_B = 'postgresql://postgres:secret@127.0.0.1:54332/postgres';
const ENV_A = { DB_URL: DB_A, API_URL: 'http://127.0.0.1:54321' };
const ENV_B = { DB_URL: DB_B, API_URL: 'http://127.0.0.1:54331' };

const DIRS: ProjectDirs = {
  found: { 'client-a': './client-a', 'client-b': './client-b' },
  problems: {},
  all: ['./client-a', './client-b'],
};

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

type ProjectState = {
  managed?: Record<string, string>;
  legacy?: Record<string, string>;
  named?: Record<string, Record<string, string>>;
};

// Routes `exec` by the `cd '<dir>' &&` prefix the stack cascade adds, and
// psql calls by connection string, so tests read as sandbox state.
function fakeCtx(options: {
  projects?: Record<string, ProjectState>;
  rows?: Record<string, Array<Record<string, unknown>>>;
  down?: string[];
}): Pick<LocalStackEvalContext, 'exec'> & { commands: string[] } {
  const { projects = {}, rows = {}, down = [] } = options;
  const commands: string[] = [];
  const exec = async (command: string): Promise<CommandResult> => {
    commands.push(command);
    const cd = command.match(/^cd '([^']+)' && ([\s\S]*)$/);
    if (cd) {
      const state = projects[cd[1]] ?? {};
      if (cd[2].includes('stack list')) {
        const stacks = Object.entries(projects).flatMap(([dir, project]) =>
          Object.keys(project.named ?? {}).map((name) => ({
            name,
            project_root: `/ws/${dir}`,
            owner: 'reachable',
          }))
        );
        return commandResult(`/ws/${cd[1]}\n${JSON.stringify({ stacks })}`);
      }
      const stackName = /--stack '([^']+)'/.exec(cd[2])?.[1];
      if (stackName !== undefined) {
        const env = state.named?.[stackName];
        if (!env) return commandResult('', false);
        return cd[2].includes('--env')
          ? commandResult(JSON.stringify(env))
          : commandResult(JSON.stringify({ runtime: 'native' }));
      }
      if (cd[2].includes('stack status --env')) {
        return state.managed
          ? commandResult(JSON.stringify(state.managed))
          : commandResult('', false);
      }
      if (cd[2].includes('stack status')) {
        return commandResult(JSON.stringify({ runtime: { kind: 'native' } }));
      }
      return state.legacy
        ? commandResult(JSON.stringify(state.legacy))
        : commandResult('', false);
    }
    const psql = command.match(/^psql '([^']+)' -tAc ([\s\S]*)$/);
    if (psql) {
      const [, dbUrl, query] = psql;
      if (down.includes(dbUrl)) return commandResult('', false);
      if (query.includes('select 1')) return commandResult('1\n');
      if (query.includes('public.clients')) {
        const tableRows = rows[dbUrl];
        if (!tableRows) return commandResult('', false);
        return query.includes('count(*)')
          ? commandResult(`${tableRows.length}\n`)
          : commandResult(JSON.stringify(tableRows));
      }
    }
    return commandResult('', false);
  };
  return { exec, commands };
}

function resolved(dbUrl: string, apiUrl?: string): StackProbe {
  return { ok: true, backend: 'managed', dbUrl, apiUrl, runtime: 'native' };
}

describe('resolveClientStacks', () => {
  it('resolves each project from inside its own directory', async () => {
    const ctx = fakeCtx({
      projects: {
        './client-a': { managed: ENV_A },
        './client-b': { legacy: ENV_B },
      },
    });
    const stacks = await resolveClientStacks(ctx, DIRS);
    expect(stacks['client-a']).toEqual({
      ok: true,
      backend: 'managed',
      dbUrl: DB_A,
      apiUrl: ENV_A.API_URL,
      runtime: 'native',
    });
    expect(stacks['client-b']).toEqual({
      ok: true,
      backend: 'legacy',
      dbUrl: DB_B,
      apiUrl: ENV_B.API_URL,
      runtime: 'docker',
    });
  });

  it('resolves two named native stacks on distinct ports', async () => {
    const ctx = fakeCtx({
      projects: {
        './client-a': { named: { native: ENV_A } },
        './client-b': { named: { demo: ENV_B } },
      },
    });
    const stacks = await resolveClientStacks(ctx, DIRS);
    expect(stacks['client-a']).toEqual({
      ok: true,
      backend: 'managed-named',
      dbUrl: DB_A,
      apiUrl: ENV_A.API_URL,
      runtime: 'native',
    });
    expect(stacks['client-b']).toMatchObject({
      ok: true,
      backend: 'managed-named',
      dbUrl: DB_B,
    });
    expect((await checkBothStacksReady(ctx, stacks)).passed).toBe(true);
    expect(checkDistinctPorts(stacks).passed).toBe(true);
  });

  it('reports a missing project directory without probing it', async () => {
    const ctx = fakeCtx({ projects: { './client-a': { managed: ENV_A } } });
    const stacks = await resolveClientStacks(ctx, {
      found: { 'client-a': './client-a' },
      problems: { 'client-b': 'no matching project directory' },
      all: ['./client-a'],
    });
    expect(stacks['client-b']).toEqual({
      ok: false,
      notes: 'no project directory (no matching project directory)',
    });
    expect(ctx.commands.some((command) => command.includes('client-b'))).toBe(
      false
    );
  });
});

describe('checkDistinctPorts', () => {
  it('passes when the stacks are on different db ports', () => {
    const result = checkDistinctPorts({
      'client-a': resolved(DB_A),
      'client-b': resolved(DB_B),
    });
    expect(result).toEqual({
      name: 'stacks are on distinct ports',
      passed: true,
      notes: 'client-a db port 54322, client-b db port 54332',
    });
  });

  it("fails when client-b's lookup resolves to client-a's stack", async () => {
    const ctx = fakeCtx({
      projects: {
        './client-a': { managed: ENV_A },
        './client-b': { managed: ENV_A },
      },
    });
    const stacks = await resolveClientStacks(ctx, DIRS);
    const result = checkDistinctPorts(stacks);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('both resolved to db port 54322');
  });

  it('fails without leaking credentials when a DB URL has no port', () => {
    const result = checkDistinctPorts({
      'client-a': resolved('postgresql://postgres:secret@127.0.0.1/postgres'),
      'client-b': resolved(DB_B),
    });
    expect(result.passed).toBe(false);
    expect(result.notes).not.toContain('secret');
  });

  it('fails when a stack never resolved', () => {
    const result = checkDistinctPorts({
      'client-a': resolved(DB_A),
      'client-b': { ok: false, notes: 'no stack' },
    });
    expect(result).toEqual({
      name: 'stacks are on distinct ports',
      passed: false,
      notes: 'client-a: resolved; client-b: no stack',
    });
  });
});

describe('checkBothStacksReady', () => {
  const stacks: ClientStacks = {
    'client-a': resolved(DB_A),
    'client-b': resolved(DB_B),
  };

  it('passes when both stacks answer select 1', async () => {
    const result = await checkBothStacksReady(fakeCtx({}), stacks);
    expect(result).toEqual({
      name: 'both stacks reach ready',
      passed: true,
      notes:
        'client-a: managed (native), select 1 ok; client-b: managed (native), select 1 ok',
    });
  });

  it('fails when one stack does not answer', async () => {
    const result = await checkBothStacksReady(
      fakeCtx({ down: [DB_B] }),
      stacks
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('client-b: exit 1: error');
  });
});

describe('marker isolation over readClientRows', () => {
  const stacks: ClientStacks = {
    'client-a': resolved(DB_A),
    'client-b': resolved(DB_B),
  };

  async function isolation(
    rows: Record<string, Array<Record<string, unknown>>>
  ) {
    const clientRows = await readClientRows(fakeCtx({ rows }), stacks);
    return checkMarkerIsolation('each project holds only its own marker row', [
      { label: 'client-a', rows: clientRows['client-a'] },
      { label: 'client-b', rows: clientRows['client-b'] },
    ]);
  }

  it('passes when each database holds its own marker, in any case', async () => {
    const result = await isolation({
      [DB_A]: [{ id: 1, name: 'Client-A' }],
      [DB_B]: [{ id: 1, label: 'client-b' }],
    });
    expect(result.passed).toBe(true);
  });

  it('fails when the rows are swapped between the databases', async () => {
    const result = await isolation({
      [DB_A]: [{ name: 'client-b' }],
      [DB_B]: [{ name: 'client-a' }],
    });
    expect(result.passed).toBe(false);
  });

  it('fails when one database holds both rows', async () => {
    const result = await isolation({
      [DB_A]: [{ name: 'client-a' }, { name: 'client-b' }],
      [DB_B]: [],
    });
    expect(result.passed).toBe(false);
  });

  it('fails when a clients table is missing', async () => {
    const result = await isolation({ [DB_A]: [{ name: 'client-a' }] });
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('client-b db rows: exit 1: error');
  });

  it("carries an unresolved stack's notes instead of querying", async () => {
    const rows = await readClientRows(fakeCtx({}), {
      'client-a': resolved(DB_A),
      'client-b': { ok: false, notes: 'no stack' },
    });
    expect(rows['client-b']).toEqual({ ok: false, notes: 'no stack' });
  });
});

describe('checkSingleClientRow over readClientRowCounts', () => {
  const stacks: ClientStacks = {
    'client-a': resolved(DB_A),
    'client-b': resolved(DB_B),
  };

  async function singleRow(
    rows: Record<string, Array<Record<string, unknown>>>
  ) {
    return checkSingleClientRow(
      await readClientRowCounts(fakeCtx({ rows }), stacks)
    );
  }

  it('passes when each table holds one row', async () => {
    const result = await singleRow({
      [DB_A]: [{ name: 'client-a' }],
      [DB_B]: [{ name: 'client-b' }],
    });
    expect(result).toEqual({
      name: 'each clients table holds exactly one row',
      passed: true,
      notes: 'client-a: 1 row; client-b: 1 row',
    });
  });

  it('fails when a table holds duplicate marker rows', async () => {
    const result = await singleRow({
      [DB_A]: [{ name: 'client-a' }, { name: 'client-a' }, { name: 'acme' }],
      [DB_B]: [{ name: 'client-b' }],
    });
    expect(result.passed).toBe(false);
    expect(result.notes).toBe('client-a: 3 rows; client-b: 1 row');
  });

  it('fails when a table is empty', async () => {
    const result = await singleRow({
      [DB_A]: [{ name: 'client-a' }],
      [DB_B]: [],
    });
    expect(result.passed).toBe(false);
    expect(result.notes).toBe('client-a: 1 row; client-b: 0 rows');
  });

  it('fails with the probe notes when a table is missing or a stack is down', async () => {
    const counts = await readClientRowCounts(
      fakeCtx({ rows: { [DB_A]: [{ name: 'client-a' }] } }),
      {
        'client-a': resolved(DB_A),
        'client-b': { ok: false, notes: 'no stack' },
      }
    );
    expect(checkSingleClientRow(counts)).toEqual({
      name: 'each clients table holds exactly one row',
      passed: false,
      notes: 'client-a: 1 row; client-b: no stack',
    });
  });
});
