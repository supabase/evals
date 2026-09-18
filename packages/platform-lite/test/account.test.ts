import { describe, it, expect } from 'vitest';
import { createTestApp, request } from './helpers.js';

describe('account', () => {
  it('creates a project and retrieves it', async () => {
    const app = await createTestApp();

    const { status: createStatus, data: created } = await request<{
      ref: string;
      name: string;
      status: string;
    }>(app, 'POST', '/v1/projects', {
      name: 'test-project',
      organization_slug: 'default-org',
      region: 'us-east-1',
      db_pass: 'secret',
    });
    expect(createStatus).toBe(201);
    expect(created.name).toBe('test-project');
    expect(created.ref).toBeTruthy();

    const { status: getStatus, data: fetched } = await request<{
      ref: string;
      name: string;
    }>(app, 'GET', `/v1/projects/${created.ref}`);
    expect(getStatus).toBe(200);
    expect(fetched.ref).toBe(created.ref);
    expect(fetched.name).toBe('test-project');
  });

  it('creates the project in the requested region', async () => {
    const app = await createTestApp();

    const { data: created } = await request<{ region: string }>(
      app,
      'POST',
      '/v1/projects',
      { name: 'london', organization_slug: 'default-org', region: 'eu-west-2' }
    );
    expect(created.region).toBe('eu-west-2');
  });

  it('refuses to create a project in an unavailable region', async () => {
    const app = await createTestApp([], { unavailableRegions: ['eu-west-2'] });

    const { status, data } = await request<{ message: string }>(
      app,
      'POST',
      '/v1/projects',
      { name: 'london', region: 'eu-west-2' }
    );
    expect(status).toBe(503);
    expect(data).toEqual({
      message:
        'The eu-west-2 region is unavailable at the moment. Visit https://status.supabase.com for further updates.',
    });

    const { data: projects } = await request<unknown[]>(
      app,
      'GET',
      '/v1/projects'
    );
    expect(projects).toHaveLength(0);
  });

  it('still creates projects in regions that are not unavailable', async () => {
    const app = await createTestApp([], { unavailableRegions: ['eu-west-2'] });

    const { status, data } = await request<{ region: string }>(
      app,
      'POST',
      '/v1/projects',
      { name: 'frankfurt', region: 'eu-central-1' }
    );
    expect(status).toBe(201);
    expect(data.region).toBe('eu-central-1');
  });

  it('transitions status on pause and restore', async () => {
    const app = await createTestApp([{ ref: 'my-proj', name: 'My Project' }]);

    const { data: paused } = await request<{ message: string }>(
      app,
      'POST',
      '/v1/projects/my-proj/pause'
    );
    expect(paused.message).toContain('paused');

    const { data: after } = await request<{ status: string }>(
      app,
      'GET',
      '/v1/projects/my-proj'
    );
    expect(after.status).toBe('INACTIVE');

    await request(app, 'POST', '/v1/projects/my-proj/restore');
    const { data: restored } = await request<{ status: string }>(
      app,
      'GET',
      '/v1/projects/my-proj'
    );
    expect(restored.status).toBe('ACTIVE_HEALTHY');
  });
});
