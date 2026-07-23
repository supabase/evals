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
