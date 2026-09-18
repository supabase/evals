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

  it('returns the overridden create project error response', async () => {
    const app = await createTestApp([], {
      createProject: {
        status: 503,
        body: { message: '{requested_region} is unavailable', statusCode: 503 },
      },
    });

    const { status, data } = await request<{ message: string }>(
      app,
      'POST',
      '/v1/projects',
      { name: 'london', region: 'eu-west-2' }
    );
    expect(status).toBe(503);
    expect(data.message).toBe('eu-west-2 is unavailable');

    const { data: projects } = await request<unknown[]>(
      app,
      'GET',
      '/v1/projects'
    );
    expect(projects).toHaveLength(0);
  });

  it('merges the create project override into the created project', async () => {
    const app = await createTestApp([], {
      createProject: {
        region: 'us-east-1',
        body: { message: 'Re-routed from {requested_region} to {region}' },
      },
    });

    const { status, data } = await request<{
      ref: string;
      region: string;
      message: string;
    }>(app, 'POST', '/v1/projects', { name: 'london', region: 'eu-west-2' });
    expect(status).toBe(201);
    expect(data.region).toBe('us-east-1');
    expect(data.message).toBe('Re-routed from eu-west-2 to us-east-1');

    const { data: fetched } = await request<{ region: string }>(
      app,
      'GET',
      `/v1/projects/${data.ref}`
    );
    expect(fetched.region).toBe('us-east-1');
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
