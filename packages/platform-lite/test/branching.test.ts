import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSupabaseApiPlatform } from '@supabase/mcp-server-supabase/platform/api';
import { createTestApp, request } from './helpers.js';
import { loadMigrationSeeds, type OrganizationSeed } from '../src/index.js';

const REF = 'branch-parent';
const PAYMENT_REQUIRED = 'Branching is supported only on the Pro plan or above';

type Branch = {
  name: string;
  project_ref: string;
  parent_project_ref: string;
  status: string;
};

function appWithOrg(organization?: OrganizationSeed) {
  return createTestApp(
    [{ ref: REF, sql: 'CREATE TABLE orders (id int PRIMARY KEY);' }],
    { organization }
  );
}

describe('organization', () => {
  it('defaults to a free plan, exposed by get but not by list', async () => {
    const app = await appWithOrg();

    const { data: orgs } = await request<Array<Record<string, unknown>>>(
      app,
      'GET',
      '/v1/organizations'
    );
    expect(orgs).toEqual([
      { id: 'default-org', slug: 'default-org', name: 'Default Organization' },
    ]);

    const { data: org } = await request<{ plan: string }>(
      app,
      'GET',
      '/v1/organizations/default-org'
    );
    expect(org.plan).toBe('free');
  });

  it('takes its name and plan from the seed', async () => {
    const app = await appWithOrg({ name: 'Acme', plan: 'pro' });
    const { data: org } = await request<{ name: string; plan: string }>(
      app,
      'GET',
      '/v1/organizations/default-org'
    );
    expect(org).toMatchObject({ name: 'Acme', plan: 'pro' });
  });

  it.each([
    ['free', false],
    ['pro', true],
  ] as const)(
    'reports branching availability on a %s plan',
    async (plan, available) => {
      const app = await appWithOrg({ plan });
      const { status, data } = await request<{ available: boolean }>(
        app,
        'GET',
        `/v1/projects/${REF}/branching`
      );
      expect(status).toBe(200);
      expect(data).toEqual({ available });
    }
  );

  it('404s branching availability for an unknown project', async () => {
    const app = await appWithOrg();
    const { status } = await request(app, 'GET', '/v1/projects/nope/branching');
    expect(status).toBe(404);
  });
});

describe('branches', () => {
  it('rejects branch creation on a free plan with a 402', async () => {
    const app = await appWithOrg({ plan: 'free' });
    const { status, data } = await request<{ message: string }>(
      app,
      'POST',
      `/v1/projects/${REF}/branches`,
      { branch_name: 'develop' }
    );
    expect(status).toBe(402);
    expect(data.message).toBe(PAYMENT_REQUIRED);

    const { data: branches } = await request<Branch[]>(
      app,
      'GET',
      `/v1/projects/${REF}/branches`
    );
    expect(branches).toEqual([]);
  });

  it('creates a queryable branch with the parent migrations replayed', async () => {
    const app = await appWithOrg({ plan: 'pro' });
    await request(app, 'POST', `/v1/projects/${REF}/database/migrations`, {
      name: 'create_invoices',
      query: 'CREATE TABLE invoices (id int PRIMARY KEY);',
    });

    const { status, data: branch } = await request<Branch>(
      app,
      'POST',
      `/v1/projects/${REF}/branches`,
      { branch_name: 'develop' }
    );
    expect(status).toBe(201);
    expect(branch).toMatchObject({
      name: 'develop',
      parent_project_ref: REF,
      status: 'FUNCTIONS_DEPLOYED',
    });
    expect(branch.project_ref).not.toBe(REF);

    const { data: branches } = await request<Branch[]>(
      app,
      'GET',
      `/v1/projects/${REF}/branches`
    );
    expect(branches.map((b) => b.name)).toEqual(['develop']);

    // Migrated schema carries over; seeded (unmigrated) schema and data don't.
    const { data: tables } = await request<Array<{ table_name: string }>>(
      app,
      'POST',
      `/v1/projects/${branch.project_ref}/database/query`,
      {
        query:
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      }
    );
    expect(tables.map((t) => t.table_name)).toEqual(['invoices']);

    const { data: migrations } = await request<Array<{ name: string }>>(
      app,
      'GET',
      `/v1/projects/${branch.project_ref}/database/migrations`
    );
    expect(migrations.map((m) => m.name)).toEqual(['create_invoices']);

    const { data: projects } = await request<Array<{ ref: string }>>(
      app,
      'GET',
      '/v1/projects'
    );
    expect(projects.map((p) => p.ref)).toEqual([REF]);
  });

  it('marks a branch MIGRATIONS_FAILED when a migration does not replay', async () => {
    const app = await appWithOrg({ plan: 'pro' });
    // Depends on `orders`, which was seeded, not migrated.
    await request(app, 'POST', `/v1/projects/${REF}/database/migrations`, {
      name: 'add_total',
      query: 'ALTER TABLE orders ADD COLUMN total int;',
    });

    const { status, data } = await request<Branch>(
      app,
      'POST',
      `/v1/projects/${REF}/branches`,
      { branch_name: 'develop' }
    );
    expect(status).toBe(201);
    expect(data.status).toBe('MIGRATIONS_FAILED');
  });

  it('rejects a body without a branch name', async () => {
    const app = await appWithOrg({ plan: 'pro' });
    const { status } = await request(
      app,
      'POST',
      `/v1/projects/${REF}/branches`,
      {}
    );
    expect(status).toBe(400);
  });

  it('404s for an unknown project', async () => {
    const app = await appWithOrg({ plan: 'pro' });
    const { status } = await request(
      app,
      'POST',
      '/v1/projects/nope/branches',
      {
        branch_name: 'develop',
      }
    );
    expect(status).toBe(404);
  });
});

describe('migration seeds', () => {
  it('loads <version>_<name>.sql files in version order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'migration-seeds-'));
    try {
      writeFileSync(join(dir, '20240201000000_add_total.sql'), 'B');
      writeFileSync(join(dir, '20240101000000_create_orders.sql'), 'A');
      expect(await loadMigrationSeeds(dir)).toEqual([
        { version: '20240101000000', name: 'create_orders', query: 'A' },
        { version: '20240201000000', name: 'add_total', query: 'B' },
      ]);

      writeFileSync(join(dir, 'notes.sql'), '');
      await expect(loadMigrationSeeds(dir)).rejects.toThrow(
        /<version>_<name>\.sql/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns no migrations for a missing directory', async () => {
    expect(await loadMigrationSeeds(join(tmpdir(), 'no-such-dir-xyz'))).toEqual(
      []
    );
  });

  it('seeds migration history that branches replay', async () => {
    const app = await createTestApp(
      [
        {
          ref: REF,
          migrations: [
            {
              version: '20240101000000',
              name: 'create_orders',
              query: 'CREATE TABLE orders (id int PRIMARY KEY);',
            },
          ],
        },
      ],
      { organization: { plan: 'pro' } }
    );
    const { data: history } = await request<Array<{ version: string }>>(
      app,
      'GET',
      `/v1/projects/${REF}/database/migrations`
    );
    expect(history).toEqual([
      { version: '20240101000000', name: 'create_orders' },
    ]);

    const { data: branch } = await request<Branch>(
      app,
      'POST',
      `/v1/projects/${REF}/branches`,
      { branch_name: 'develop' }
    );
    expect(branch.status).toBe('FUNCTIONS_DEPLOYED');
    const { data: rows } = await request<unknown[]>(
      app,
      'POST',
      `/v1/projects/${branch.project_ref}/database/query`,
      { query: 'SELECT * FROM orders' }
    );
    expect(rows).toEqual([]);
  });
});

describe('MCP platform branching', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function mcpPlatform(organization: OrganizationSeed) {
    const app = await appWithOrg(organization);
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      app.request(input as string, init)
    );
    return createSupabaseApiPlatform({
      accessToken: 'test-token',
      apiUrl: 'http://localhost',
    });
  }

  it('surfaces the plan and the 402 message to the MCP server', async () => {
    const platform = await mcpPlatform({ plan: 'free' });
    const org = await platform.account!.getOrganization('default-org');
    expect(org.plan).toBe('free');
    await expect(
      platform.branching!.createBranch(REF, { name: 'develop' })
    ).rejects.toThrow(PAYMENT_REQUIRED);
  });

  it('creates and lists branches through the MCP server on a paid plan', async () => {
    const platform = await mcpPlatform({ plan: 'pro' });
    await platform.branching!.createBranch(REF, { name: 'develop' });
    const branches = await platform.branching!.listBranches(REF);
    expect(branches.map((b) => b.name)).toEqual(['develop']);
  });
});
