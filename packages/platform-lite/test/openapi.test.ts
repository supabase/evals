import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

describe('OpenAPI surface', () => {
  it('derives the exposed operations from registered management routes', async () => {
    const app = await createTestApp();
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);

    const spec = (await res.json()) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };

    expect(spec.paths['/v1/projects']).toHaveProperty('get');
    expect(spec.paths['/v1/projects']).toHaveProperty('post');
    expect(spec.paths['/v1/projects/{ref}/database/query']).toHaveProperty(
      'post'
    );
    expect(spec.paths['/v1/projects/{ref}/database/migrations']).toHaveProperty(
      'get'
    );
    expect(spec.paths['/v1/projects/{ref}/database/migrations']).toHaveProperty(
      'post'
    );
    expect(
      spec.paths['/v1/projects/{ref}/database/migrations']
    ).not.toHaveProperty('delete');
    // Distinct operations for the legacy and ClickHouse logs endpoints —
    // upstream renamed the legacy one when the no-`.all` route landed.
    expect(
      spec.paths['/v1/projects/{ref}/analytics/endpoints/logs.all']!.get!
        .operationId
    ).toBe('v1-get-project-logs-all');
    expect(
      spec.paths['/v1/projects/{ref}/analytics/endpoints/logs']!.get!
        .operationId
    ).toBe('v1-get-project-logs');
    expect(
      spec.paths['/v1/projects/{ref}/functions/{function_slug}']
    ).toHaveProperty('get');
    expect(
      spec.paths['/v1/projects/{ref}/functions/{function_slug}/body']
    ).toHaveProperty('get');

    // operationIds must be unique across the advertised spec (OpenAPI
    // requirement; a duplicate breaks generated clients).
    const ids = Object.values(spec.paths)
      .flatMap((methods) => Object.values(methods))
      .map((op) => op.operationId)
      .filter((id): id is string => typeof id === 'string');
    expect(new Set(ids).size).toBe(ids.length);
  });
});
