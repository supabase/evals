import { describe, expect, it } from 'vitest';
import { sanitizeResult } from './redact-spark-result.js';

// Dummy JWT signature is base64url for the word "signature".
const fakeAccessToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
const fakeRefreshToken = 'opaque-refresh+/token=';

describe('Spark result sanitization', () => {
  it('redacts configured values, encoded copies and object keys', () => {
    const secret = 'https://private.example/a?token=secret';
    const value = { [secret]: [secret, encodeURIComponent(secret), 4] };
    expect(JSON.parse(sanitizeResult(value, [secret]))).toEqual({
      '[REDACTED]': ['[REDACTED]', '[REDACTED]', 4],
    });
  });

  it.each(['structured', 'stdout', 'escaped'])(
    'discovers session tokens in %s responses and redacts every copy',
    (format) => {
      const session = {
        access_token: fakeAccessToken,
        refresh_token: fakeRefreshToken,
        token_type: 'bearer',
      };
      const response =
        format === 'structured'
          ? session
          : format === 'stdout'
            ? `signup response: ${JSON.stringify(session)}`
            : JSON.stringify(JSON.stringify(session));
      const checks = [{ passed: false, notes: 'found: JWT-shaped token' }];
      const value = {
        copies: [
          fakeAccessToken,
          fakeRefreshToken,
          encodeURIComponent(fakeRefreshToken),
        ],
        response,
        checks,
      };
      const payload = sanitizeResult(value, []);
      for (const token of [fakeAccessToken, fakeRefreshToken]) {
        expect(payload).not.toContain(token);
        expect(payload).not.toContain(encodeURIComponent(token));
      }
      expect(JSON.parse(payload)).toMatchObject({
        copies: ['[REDACTED]', '[REDACTED]', '[REDACTED]'],
        checks,
      });
      expect(payload).toContain('bearer');
    }
  );

  it('redacts JWTs printed without a session field', () => {
    expect(
      JSON.parse(sanitizeResult({ report: `Bearer ${fakeAccessToken}` }, []))
    ).toEqual({
      report: 'Bearer [REDACTED]',
    });
  });
});
