import { expect, test } from 'vitest';
import { redactDeep, redactSecrets } from './redact-review-evidence.mjs';

test('redacts Supabase status credentials in transcript text and structured output', () => {
  const secret = 'sb_secret_0123456789abcdefghijklmnop';
  const transcript = JSON.stringify({
    SECRET_KEY: secret,
    JWT_SECRET: 'local-jwt-signing-secret',
    SERVICE_ROLE_KEY: 'local-service-role-value',
    API_URL: 'http://localhost:54321',
    DB_URL: 'postgresql://postgres:database-password@localhost:54322/postgres',
  });
  const redacted = redactSecrets(transcript, {});
  for (const value of [
    secret,
    'local-jwt-signing-secret',
    'local-service-role-value',
    'database-password',
  ]) {
    expect(redacted).not.toContain(value);
  }
  expect(redacted).toContain('http://localhost:54321');
  expect(
    redactDeep(
      {
        nested: {
          access_token: 'opaque-session-credential',
          output: transcript,
        },
      },
      {}
    )
  ).toEqual({ nested: { access_token: '<<redacted>>', output: redacted } });
});
