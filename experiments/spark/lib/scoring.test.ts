import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubSandbox } from './runtime-stub.js';
import { checkNoRawSql, findLeakedCredentials } from './scoring.js';

const project = {
  projectUrl: 'https://project.example',
  publishableKey: 'sb_publishable_test_key_0123456789',
  secretKey: 'sb_secret_test_key_0123456789',
};
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

const find = (ctx: Parameters<typeof findLeakedCredentials>[1]) =>
  findLeakedCredentials(project, ctx);

describe('findLeakedCredentials', () => {
  it('finds keys and tokens in the report, messages, command output and errors', () => {
    expect(
      find({ agentReport: `used ${project.secretKey}`, transcript: [] })
    ).toEqual(['secret key']);
    expect(
      find({ agentReport: `apikey: ${project.publishableKey}`, transcript: [] })
    ).toEqual(['publishable key']);
    expect(find({ agentReport: `Bearer ${JWT}`, transcript: [] })).toEqual([
      'JWT-shaped token',
    ]);
    expect(
      find({
        transcript: [
          { type: 'message', role: 'assistant', content: project.secretKey },
          { type: 'tool_call', name: 'shell', input: {}, output: JWT },
          {
            type: 'tool_call',
            name: 'shell',
            input: {},
            output: { access_token: JWT },
          },
          { type: 'tool_call', name: 'shell', input: {}, error: JWT },
        ],
      })
    ).toEqual(['secret key', 'JWT-shaped token']);
  });

  it('ignores keys in the commands the agent wrote and in user messages', () => {
    expect(
      find({
        transcript: [
          { type: 'message', role: 'user', content: project.secretKey },
          {
            type: 'tool_call',
            name: 'shell',
            input: { command: `curl -H "apikey: ${project.secretKey}"` },
            output: 'ok',
          },
        ],
      })
    ).toEqual([]);
  });
});

describe('checkNoRawSql', () => {
  const scan = (source: string) =>
    checkNoRawSql(stubSandbox({ 'app/report.mjs': source }), 'app');

  it('passes a Data API app and flags psql, raw drivers and the SQL endpoint', async () => {
    expect(
      await scan(`import { createClient } from '@supabase/supabase-js';`)
    ).toMatchObject({
      name: 'report queries via the Data API, not raw SQL',
      passed: true,
      notes: 'no psql / raw Postgres driver / SQL endpoint usage found',
    });
    for (const source of [
      `const driver = 'pg';`,
      `const driver = "postgres";`,
      `const driver = 'pg-promise';`,
      `const command = 'psql -c "select 1"';`,
      `const path = '/database/query';`,
    ])
      expect(await scan(source)).toMatchObject({
        passed: false,
        notes: 'app/report.mjs',
      });
  });
});
