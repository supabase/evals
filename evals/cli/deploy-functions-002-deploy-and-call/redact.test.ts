// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-002-deploy-and-call
import { describe, expect, it, vi } from 'vitest';
import { readProjectKeys, redactSecrets } from './redact.js';

const REF = 'abcdefghijklmnopqrst';
const API_KEYS_PATH = '/v1/projects/{ref}/api-keys';
const FUNCTION_URL = `https://${REF}.supabase.co/functions/v1/shipping-quote`;
const REDACTED = '[redacted]';

const b64url = (text: string) => Buffer.from(text).toString('base64url');

const JWT = [
  b64url('{"alg":"HS256","typ":"JWT"}'),
  b64url('{"iss":"supabase","ref":"abcdefghijklmnopqrst","role":"anon"}'),
  'c2lnbmF0dXJl',
].join('.');

const JWT_URLSAFE = [
  b64url('{"alg":"HS256","typ":"JWT"}'),
  b64url('{"note":"~~~???>>>","role":"service_role"}'),
  'c2ln_bmF0-dXJl',
].join('.');

const SB_SECRET = `sb_secret_${'N7UND0UgjKTVK-Uodkm0Hg'}_${'xYvsjUkD'}`;
const SB_PUBLISHABLE = `sb_publishable_${'ACJWlzQHlZjBrEguHvfOxg'}_${'3BJgxAaH'}`;
const SBP = `sbp_${'0123456789abcdef'.repeat(2)}01234567`;

describe('redactSecrets with known secret values', () => {
  const SECRET = 'project-anon-key-value';
  const OTHER = 'project-service-key-value';

  it('replaces every occurrence of a known secret', () => {
    expect(redactSecrets(`key=${SECRET}; again ${SECRET}`, [SECRET])).toBe(
      `key=${REDACTED}; again ${REDACTED}`
    );
  });

  it('replaces each of several secrets', () => {
    expect(redactSecrets(`${SECRET} and ${OTHER}`, [SECRET, OTHER])).toBe(
      `${REDACTED} and ${REDACTED}`
    );
  });

  it('replaces a secret that sits inside a longer token', () => {
    expect(redactSecrets(`prefix${SECRET}suffix`, [SECRET])).toBe(
      `prefix${REDACTED}suffix`
    );
  });

  it('matches a secret containing regex metacharacters literally', () => {
    const secret = 'a.b+c*d(e)[f]$g^h|i?{j}\\k';
    expect(redactSecrets(`token ${secret} end`, [secret])).toBe(
      `token ${REDACTED} end`
    );
  });

  it('does not treat a dot in a secret as a wildcard', () => {
    expect(redactSecrets('abcdXefgh', ['abcd.efgh'])).toBe('abcdXefgh');
  });

  it.each([
    ['shorter first', ['abcdefgh', 'abcdefghijkl']],
    ['longer first', ['abcdefghijkl', 'abcdefgh']],
  ])(
    'redacts the whole longer secret when a shorter one is its prefix (%s)',
    (_label, secrets) => {
      expect(redactSecrets('key abcdefghijkl end', secrets)).toBe(
        `key ${REDACTED} end`
      );
    }
  );

  it('ignores empty secrets instead of collapsing the text', () => {
    expect(redactSecrets('plain text', [''])).toBe('plain text');
  });

  it('ignores secrets shorter than 8 characters', () => {
    expect(redactSecrets('short 1234567 here', ['short', '1234567'])).toBe(
      'short 1234567 here'
    );
  });

  it('redacts a secret of exactly 8 characters', () => {
    expect(redactSecrets('value 12345678 here', ['12345678'])).toBe(
      `value ${REDACTED} here`
    );
  });

  it('leaves the text alone when there are no secrets and nothing key-shaped', () => {
    expect(redactSecrets('nothing to hide', [])).toBe('nothing to hide');
  });

  it('returns an empty string for empty text', () => {
    expect(redactSecrets('', [SECRET])).toBe('');
  });

  it('redacts known secrets and key-shaped strings in the same text', () => {
    expect(redactSecrets(`${SECRET} then ${JWT}`, [SECRET])).toBe(
      `${REDACTED} then ${REDACTED}`
    );
  });
});

describe('redactSecrets backstop patterns', () => {
  it('redacts a JWT', () => {
    expect(redactSecrets(JWT, [])).toBe(REDACTED);
  });

  it('redacts a JWT whose segments use base64url characters', () => {
    expect(redactSecrets(`apikey: ${JWT_URLSAFE}`, [])).toBe(
      `apikey: ${REDACTED}`
    );
  });

  it('redacts a JWT in a bearer header and keeps the header name', () => {
    expect(redactSecrets(`Authorization: Bearer ${JWT}`, [])).toBe(
      `Authorization: Bearer ${REDACTED}`
    );
  });

  it('redacts a JWT in a JSON string and keeps the quotes', () => {
    expect(redactSecrets(`{"anon_key":"${JWT}"}`, [])).toBe(
      `{"anon_key":"${REDACTED}"}`
    );
  });

  it('keeps the sentence punctuation after a JWT', () => {
    expect(redactSecrets(`The key is ${JWT}.`, [])).toBe(
      `The key is ${REDACTED}.`
    );
  });

  it('redacts every JWT in the text', () => {
    expect(redactSecrets(`${JWT}\n${JWT_URLSAFE}`, [])).toBe(
      `${REDACTED}\n${REDACTED}`
    );
  });

  it('redacts an sb_secret_ key', () => {
    expect(redactSecrets(`SUPABASE_SECRET_KEY=${SB_SECRET}`, [])).toBe(
      `SUPABASE_SECRET_KEY=${REDACTED}`
    );
  });

  it('redacts an sb_publishable_ key', () => {
    expect(redactSecrets(`apikey: ${SB_PUBLISHABLE}`, [])).toBe(
      `apikey: ${REDACTED}`
    );
  });

  it('redacts an sbp_ personal access token', () => {
    expect(redactSecrets(`SUPABASE_ACCESS_TOKEN=${SBP}`, [])).toBe(
      `SUPABASE_ACCESS_TOKEN=${REDACTED}`
    );
  });

  it('redacts all four shapes in one text', () => {
    expect(
      redactSecrets([JWT, SB_SECRET, SB_PUBLISHABLE, SBP].join(' | '), [])
    ).toBe([REDACTED, REDACTED, REDACTED, REDACTED].join(' | '));
  });

  it.each([
    ['the function path', '/functions/v1/shipping-quote'],
    ['a function URL with the project ref', FUNCTION_URL],
    ['a project ref', `--project-ref ${REF}`],
    ['a deploy command', 'supabase functions deploy shipping-quote --use-api'],
    ['a source path', 'supabase/functions/shipping-quote/index.ts'],
    ['a version', 'supabase 2.0.0'],
    ['a quote body', '{"quoteCents":810,"currency":"EUR"}'],
    ['a bearer header with an env var', 'Authorization: Bearer $ANON_KEY'],
    ['the token variable name', 'echo $SUPABASE_ACCESS_TOKEN'],
    ['a CLI notice', 'Access token not provided. Run `supabase login`.'],
  ])('leaves %s untouched', (_label, text) => {
    expect(redactSecrets(text, [])).toBe(text);
  });
});

describe('readProjectKeys', () => {
  const rows = [
    { name: 'anon', api_key: 'anon-key-value', type: 'legacy' },
    { name: 'service_role', api_key: 'service-role-key-value', type: 'legacy' },
    { name: 'default', api_key: 'publishable-key-value', type: 'publishable' },
    { name: 'default', api_key: 'secret-key-value-xyz', type: 'secret' },
  ];

  const fakeGet = (response: {
    data?: unknown;
    error?: unknown;
    status?: number;
  }) =>
    vi.fn(async (_path: string, _opts?: unknown) => ({
      data: response.data,
      error: response.error,
      response: { status: response.status ?? 200 },
    }));

  const ctxOf = (GET: ReturnType<typeof fakeGet>) => ({
    hostedRef: REF,
    hostedMgmt: { GET } as never,
  });

  it('returns the value of every key the project lists, whatever its type', async () => {
    const GET = fakeGet({ data: rows });
    expect([...(await readProjectKeys(ctxOf(GET)))].sort()).toEqual(
      rows.map(({ api_key }) => api_key).sort()
    );
  });

  it('reads the keys once from the api-keys endpoint of the hosted project', async () => {
    const GET = fakeGet({ data: rows });
    await readProjectKeys(ctxOf(GET));
    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith(
      API_KEYS_PATH,
      expect.objectContaining({ params: { path: { ref: REF } } })
    );
  });

  it('skips rows that carry no key value', async () => {
    const GET = fakeGet({
      data: [
        { name: 'anon', api_key: 'anon-key-value', type: 'legacy' },
        { name: 'masked', api_key: null, type: 'secret' },
        { name: 'blank', api_key: '', type: 'secret' },
        { name: 'absent', type: 'publishable' },
      ],
    });
    expect(await readProjectKeys(ctxOf(GET))).toEqual(['anon-key-value']);
  });

  it('returns an empty list without calling the API when there is no hosted project', async () => {
    const GET = fakeGet({ data: rows });
    expect(await readProjectKeys({})).toEqual([]);
    expect(await readProjectKeys({ hostedRef: REF })).toEqual([]);
    expect(await readProjectKeys({ hostedMgmt: { GET } as never })).toEqual([]);
    expect(GET).not.toHaveBeenCalled();
  });

  it('returns an empty list when the API answers with an error', async () => {
    const GET = fakeGet({
      error: { message: 'keys unavailable' },
      status: 500,
    });
    expect(await readProjectKeys(ctxOf(GET))).toEqual([]);
  });

  it('returns an empty list instead of rejecting when the lookup throws', async () => {
    const GET = vi.fn(async (_path: string, _opts?: unknown) => {
      throw new Error('connection reset');
    });
    await expect(readProjectKeys(ctxOf(GET as never))).resolves.toEqual([]);
  });
});
