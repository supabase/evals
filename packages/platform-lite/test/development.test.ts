import { describe, it, expect } from 'vitest';
import { createTestApp, request } from './helpers.js';

describe('development', () => {
  it('returns anon api key', async () => {
    const app = await createTestApp([{ ref: 'dev-proj' }]);

    const { status, data } = await request<
      Array<{ name: string; api_key: string; type: string }>
    >(app, 'GET', '/v1/projects/dev-proj/api-keys');
    expect(status).toBe(200);
    const anon = data.find((k) => k.name === 'anon');
    expect(anon).toBeDefined();
    expect(anon!.api_key).toBeTruthy();
    const parts = anon!.api_key.split('.');
    expect(parts).toHaveLength(3);
  });
});
