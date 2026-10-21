// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-005-preview-branch-lifecycle
import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact.js';

const REF = 'abcdefghijklmnopqrst';
const BRANCH_REF = 'zyxwvutsrqponmlkjihg';
const REDACTED = '[redacted]';
const PASSWORD = 'not-a-real-password-123';
const OTHER_PASSWORD = 'also-not-a-real-password-456';
const HOST = 'aws-0-eu-west-1.pooler.supabase.com';

const b64url = (text: string) => Buffer.from(text).toString('base64url');

const JWT = [
  b64url('{"alg":"HS256","typ":"JWT"}'),
  b64url(`{"iss":"supabase","ref":"${REF}","role":"anon"}`),
  'bm90LWEtcmVhbC1zaWduYXR1cmU',
].join('.');

const JWT_URLSAFE = [
  b64url('{"alg":"HS256","typ":"JWT"}'),
  b64url('{"note":"~~~???>>>","role":"service_role"}'),
  'bm90_YS1yZWFs-c2ln',
].join('.');

const SB_SECRET = 'sb_secret_not_a_real_key_do_not_use';
const SB_PUBLISHABLE = 'sb_publishable_not_a_real_key_do_not_use';
const SBP = `sbp_${'e'.repeat(40)}`;

const filler = (length: number) => 'lorem ipsum '.repeat(length / 12 + 1);

function expectRedacted(output: string, secret: string, ...kept: string[]) {
  expect(output).not.toContain(secret);
  expect(output).toContain(REDACTED);
  for (const text of kept) expect(output).toContain(text);
}

describe('redactSecrets Postgres URLs', () => {
  it('replaces only the password and keeps the user, host, port and database readable', () => {
    expect(
      redactSecrets(
        `postgresql://postgres.${BRANCH_REF}:${PASSWORD}@${HOST}:5432/postgres`
      )
    ).toBe(
      `postgresql://postgres.${BRANCH_REF}:${REDACTED}@${HOST}:5432/postgres`
    );
  });

  it('handles the postgres:// scheme and keeps the query string', () => {
    expect(
      redactSecrets(
        `postgres://postgres:${PASSWORD}@db.${REF}.supabase.co:5432/postgres?sslmode=require`
      )
    ).toBe(
      `postgres://postgres:${REDACTED}@db.${REF}.supabase.co:5432/postgres?sslmode=require`
    );
  });

  it('keeps the branch ref and the production ref distinguishable in the user name', () => {
    const output = redactSecrets(
      `prod postgresql://postgres.${REF}:${PASSWORD}@${HOST}:5432/postgres branch postgresql://postgres.${BRANCH_REF}:${OTHER_PASSWORD}@${HOST}:5432/postgres`
    );
    expect(output).toBe(
      `prod postgresql://postgres.${REF}:${REDACTED}@${HOST}:5432/postgres branch postgresql://postgres.${BRANCH_REF}:${REDACTED}@${HOST}:5432/postgres`
    );
  });

  it('redacts a percent-encoded password with punctuation', () => {
    const password = 'not-a-real-p%40ss.word_1!';
    expect(
      redactSecrets(`postgres://app:${password}@db.example.com:5432/app`)
    ).toBe(`postgres://app:${REDACTED}@db.example.com:5432/app`);
  });

  it.each([
    ['single quotes', `--db-url '`, `'`],
    ['double quotes', `--db-url "`, `"`],
    ['an env assignment', 'DATABASE_URL=', ''],
    ['a JSON string', '{"url":"', '"}'],
    ['a sentence', 'connect with ', '.'],
  ])(
    'redacts a password inside %s and keeps what surrounds it',
    (_label, before, after) => {
      const url = (password: string) =>
        `postgresql://postgres.${BRANCH_REF}:${password}@${HOST}:5432/postgres`;
      expect(redactSecrets(`${before}${url(PASSWORD)}${after}`)).toBe(
        `${before}${url(REDACTED)}${after}`
      );
    }
  );

  it('leaves a URL with a user but no password alone', () => {
    const text = `postgresql://postgres@${HOST}:5432/postgres`;
    expect(redactSecrets(text)).toBe(text);
  });

  it('leaves a URL with no user info alone, and does not mistake the port for a password', () => {
    const text = `postgresql://db.${REF}.supabase.co:5432/postgres`;
    expect(redactSecrets(text)).toBe(text);
  });

  it('does not run on from a URL without a password to a later @ in the text', () => {
    const text = `connect to postgresql://db.example.com:5432/postgres then email dev@example.com`;
    expect(redactSecrets(text)).toBe(text);
  });

  it('does not run on from one URL password into the text between two URLs', () => {
    expect(
      redactSecrets(
        `first postgres://u1:${PASSWORD}@h1:5432/db and then postgres://u2:${OTHER_PASSWORD}@h2:5432/db`
      )
    ).toBe(
      `first postgres://u1:${REDACTED}@h1:5432/db and then postgres://u2:${REDACTED}@h2:5432/db`
    );
  });

  it('leaves non-Postgres URLs with a port alone', () => {
    const text = `https://${REF}.supabase.co:443/rest/v1/orders and http://127.0.0.1:54321/functions/v1/x`;
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('redactSecrets key shapes', () => {
  it('redacts a JWT and keeps the bearer header', () => {
    expect(redactSecrets(`Authorization: Bearer ${JWT}`)).toBe(
      `Authorization: Bearer ${REDACTED}`
    );
  });

  it('redacts a JWT whose segments use base64url characters', () => {
    expect(redactSecrets(`apikey: ${JWT_URLSAFE}`)).toBe(`apikey: ${REDACTED}`);
  });

  it('redacts a JWT in a JSON string and keeps the quotes', () => {
    expect(redactSecrets(`{"anon_key":"${JWT}"}`)).toBe(
      `{"anon_key":"${REDACTED}"}`
    );
  });

  it('keeps the sentence punctuation after a JWT', () => {
    expect(redactSecrets(`The key is ${JWT}.`)).toBe(`The key is ${REDACTED}.`);
  });

  it('redacts an sb_secret_ key', () => {
    expect(redactSecrets(`using ${SB_SECRET} now`)).toBe(
      `using ${REDACTED} now`
    );
  });

  it('redacts an sb_publishable_ key', () => {
    expect(redactSecrets(`apikey: ${SB_PUBLISHABLE}`)).toBe(
      `apikey: ${REDACTED}`
    );
  });

  it('redacts an sbp_ access token passed to login', () => {
    expect(redactSecrets(`supabase login --token ${SBP}`)).toBe(
      `supabase login --token ${REDACTED}`
    );
  });

  it('redacts an sbp_ access token in an environment variable', () => {
    expect(redactSecrets(`SUPABASE_ACCESS_TOKEN=${SBP}`)).toBe(
      `SUPABASE_ACCESS_TOKEN=${REDACTED}`
    );
  });

  it('redacts every occurrence, not just the first', () => {
    expect(redactSecrets(`${SBP} ${SBP}\n${JWT}\n${JWT_URLSAFE}`)).toBe(
      `${REDACTED} ${REDACTED}\n${REDACTED}\n${REDACTED}`
    );
  });
});

describe('redactSecrets environment-style assignments', () => {
  it('redacts the value of an unquoted password and keeps the name and what follows', () => {
    expect(
      redactSecrets(`POSTGRES_PASSWORD=${PASSWORD} supabase db push`)
    ).toBe(`POSTGRES_PASSWORD=${REDACTED} supabase db push`);
  });

  it('redacts PGPASSWORD in front of a command', () => {
    expect(
      redactSecrets(`PGPASSWORD=${PASSWORD} psql -h ${HOST} -c 'select 1'`)
    ).toBe(`PGPASSWORD=${REDACTED} psql -h ${HOST} -c 'select 1'`);
  });

  it('redacts a double-quoted secret and keeps the name', () => {
    const output = redactSecrets(`SUPABASE_JWT_SECRET="${PASSWORD}"`);
    expectRedacted(output, PASSWORD, 'SUPABASE_JWT_SECRET=');
  });

  it('redacts a single-quoted key after export and keeps export and the name', () => {
    const output = redactSecrets(
      `export SUPABASE_SERVICE_ROLE_KEY='${PASSWORD}'`
    );
    expectRedacted(output, PASSWORD, 'export SUPABASE_SERVICE_ROLE_KEY=');
  });

  it.each([
    ['PASSWORD', 'DB_PASSWORD'],
    ['SECRET', 'SUPABASE_JWT_SECRET'],
    ['KEY', 'SUPABASE_ANON_KEY'],
    ['KEY', 'API_KEY'],
  ])('redacts a name ending in %s (%s)', (_suffix, name) => {
    expect(redactSecrets(`${name}=${PASSWORD}`)).toBe(`${name}=${REDACTED}`);
  });

  it('redacts each line of a pasted env file and leaves the other variables alone', () => {
    expect(
      redactSecrets(
        [
          `POSTGRES_PASSWORD=${PASSWORD}`,
          `SUPABASE_JWT_SECRET=${OTHER_PASSWORD}`,
          'API_URL=http://127.0.0.1:54321',
          `SUPABASE_PROJECT_REF=${REF}`,
        ].join('\n')
      )
    ).toBe(
      [
        `POSTGRES_PASSWORD=${REDACTED}`,
        `SUPABASE_JWT_SECRET=${REDACTED}`,
        'API_URL=http://127.0.0.1:54321',
        `SUPABASE_PROJECT_REF=${REF}`,
      ].join('\n')
    );
  });
});

describe('redactSecrets deep into long text', () => {
  it.each([
    [
      'a Postgres URL password',
      `postgresql://postgres:${PASSWORD}@${HOST}:5432/postgres`,
      PASSWORD,
    ],
    ['an sbp_ token', SBP, SBP],
    ['a JWT', JWT, JWT],
    ['an sb_secret_ key', SB_SECRET, SB_SECRET],
    ['an sb_publishable_ key', SB_PUBLISHABLE, SB_PUBLISHABLE],
    ['an env-style password', `PGPASSWORD=${PASSWORD} psql`, PASSWORD],
  ])(
    'redacts %s that starts after 2,000 and after 5,000 characters',
    (_label, text, secret) => {
      for (const length of [2_100, 6_000]) {
        const output = redactSecrets(`${filler(length)}${text}`);
        expect(output).not.toContain(secret);
        expect(output).toContain(REDACTED);
      }
    }
  );

  it('keeps all the surrounding text when it redacts', () => {
    const text = `${filler(3_000)}PGPASSWORD=${PASSWORD} psql${filler(3_000)}`;
    expect(redactSecrets(text)).toBe(text.replace(PASSWORD, REDACTED));
  });
});

describe('redactSecrets leaves evidence readable', () => {
  it.each([
    ['a 20-letter project ref', `--project-ref ${REF}`],
    ['a project ref in a user name', `postgres.${REF}`],
    ['a project host', `db.${REF}.supabase.co`],
    ['a pooler host', HOST],
    [
      'a Management API path',
      `https://api.supabase.com/v1/projects/${REF}/branches`,
    ],
    ['a branch name', 'supabase branches create preview-shipments'],
    [
      'a migration version',
      'Applying migration 20261020120000_add_order_shipments.sql...',
    ],
    [
      'a migration list row',
      '20261020120000 | 20261020120000 | 2026-10-20 12:00:00',
    ],
    [
      'a create table statement',
      'create table public.shipments (id bigint generated always as identity primary key, order_id bigint not null references public.orders (id));',
    ],
    ['a unique constraint', 'unique (carrier, tracking_number)'],
    [
      'the probe query',
      "select count(*)::int as n from supabase_migrations.schema_migrations where version = '20261020120000'",
    ],
    ['a primary key clause', 'alter table public.orders add primary key (id);'],
    ['a shell variable reference', 'supabase db push --db-url "$BRANCH_URL"'],
    ['a token variable reference', 'echo $SUPABASE_ACCESS_TOKEN'],
    ['a bearer header with an env var', 'Authorization: Bearer $ANON_KEY'],
    ['a CLI version', 'supabase 2.117.0'],
    [
      'an error message',
      'Cannot find project ref. Have you run supabase link?',
    ],
  ])('leaves %s untouched', (_label, text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it('leaves a whole branch session transcript untouched when it holds no secrets', () => {
    const text = [
      `supabase link --project-ref ${REF}`,
      'supabase branches create preview-shipments',
      `Created preview branch preview-shipments (${BRANCH_REF})`,
      `postgresql://postgres.${BRANCH_REF}@${HOST}:5432/postgres`,
      'Applying migration 20261020120000_add_order_shipments.sql...',
      'supabase branches delete preview-shipments --yes',
    ].join('\n');
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('redactSecrets in general', () => {
  it('returns an empty string for empty text', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('redacts every shape in one text', () => {
    const output = redactSecrets(
      [
        `postgresql://postgres.${BRANCH_REF}:${PASSWORD}@${HOST}:5432/postgres`,
        JWT,
        SB_SECRET,
        SB_PUBLISHABLE,
        SBP,
        `POSTGRES_PASSWORD=${OTHER_PASSWORD}`,
      ].join(' | ')
    );
    for (const secret of [
      PASSWORD,
      JWT,
      SB_SECRET,
      SB_PUBLISHABLE,
      SBP,
      OTHER_PASSWORD,
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output.split(REDACTED)).toHaveLength(7);
  });

  it('is idempotent', () => {
    const text = `postgresql://u:${PASSWORD}@h:5432/db ${SBP} PGPASSWORD=${OTHER_PASSWORD} ${JWT}`;
    const once = redactSecrets(text);
    expect(redactSecrets(once)).toBe(once);
  });
});
