// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
import { describe, expect, it, vi } from 'vitest';
import { readProjectKeys, redactSecrets } from './redact.js';

const REF = 'abcdefghijklmnopqrst';
const BRANCH_REF = 'zyxwvutsrqponmlkjihg';
const API_KEYS_PATH = '/v1/projects/{ref}/api-keys';
const FUNCTION_URL = `https://${REF}.supabase.co/functions/v1/shipping-quote`;
const REDACTED = '[redacted]';
const PASSWORD = 'not-a-real-password-123';
const OTHER_PASSWORD = 'also-not-a-real-password-456';
const HOST = 'aws-0-eu-west-1.pooler.supabase.com';

const b64url = (text: string) => Buffer.from(text).toString('base64url');

const JWT = [
  b64url('{"alg":"HS256","typ":"JWT"}'),
  b64url(`{"iss":"supabase","ref":"${REF}","role":"anon"}`),
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

const filler = (length: number) => 'lorem ipsum '.repeat(length / 12 + 1);

function expectRedacted(output: string, secret: string, ...kept: string[]) {
  expect(output).not.toContain(secret);
  expect(output).toContain(REDACTED);
  for (const text of kept) expect(output).toContain(text);
}

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

describe('redactSecrets known values together with patterns', () => {
  it('redacts a known value with no recognisable shape alongside a URL password', () => {
    expect(
      redactSecrets(
        `leaked opaque-value-1 and postgresql://app:${PASSWORD}@${HOST}:5432/postgres`,
        ['opaque-value-1']
      )
    ).toBe(
      `leaked ${REDACTED} and postgresql://app:${REDACTED}@${HOST}:5432/postgres`
    );
  });
});

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
  it('redacts a JWT', () => {
    expect(redactSecrets(JWT)).toBe(REDACTED);
  });

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

  it('redacts an sb_secret_ key assigned to an environment variable', () => {
    expect(redactSecrets(`SUPABASE_SECRET_KEY=${SB_SECRET}`)).toBe(
      `SUPABASE_SECRET_KEY=${REDACTED}`
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

  it('redacts all four shapes in one text', () => {
    expect(
      redactSecrets([JWT, SB_SECRET, SB_PUBLISHABLE, SBP].join(' | '))
    ).toBe([REDACTED, REDACTED, REDACTED, REDACTED].join(' | '));
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

describe('redactSecrets libpq keyword strings', () => {
  it('redacts the password value and keeps host, user and dbname readable', () => {
    expect(
      redactSecrets(
        `psql "host=${HOST} user=postgres password=hunter2 dbname=postgres"`
      )
    ).toBe(
      `psql "host=${HOST} user=postgres password=${REDACTED} dbname=postgres"`
    );
  });

  it.each(['PASSWORD', 'Password', 'password'])(
    'redacts %s whatever its case',
    (name) => {
      expect(redactSecrets(`host=h ${name}=hunter2 dbname=d`)).toBe(
        `host=h ${name}=${REDACTED} dbname=d`
      );
    }
  );

  it('redacts a password that ends the string', () => {
    expect(redactSecrets(`psql "host=h user=u password=hunter2"`)).toBe(
      `psql "host=h user=u password=${REDACTED}"`
    );
  });

  it('redacts a single-quoted password with a space', () => {
    expect(redactSecrets(`psql "host=h password='hunter 2' dbname=d"`)).toBe(
      `psql "host=h password=${REDACTED} dbname=d"`
    );
  });
});

describe('redactSecrets lowercase and mixed-case assignments', () => {
  it.each([
    'pgpassword',
    'PGPassword',
    'db_password',
    'jwt_secret',
    'Supabase_Jwt_Secret',
    'anon_key',
    'ServiceRoleKey',
  ])('redacts %s=', (name) => {
    expect(redactSecrets(`${name}=hunter2 supabase db push`)).toBe(
      `${name}=${REDACTED} supabase db push`
    );
  });

  it('leaves a lowercase name that does not end in password, secret or key alone', () => {
    const text = 'project_ref=abcdefghijklmnopqrst region=eu-west-1';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('redactSecrets Supabase CLI password flags', () => {
  it.each([
    ['--password X', 'supabase db push --password hunter2 --include-all'],
    ['--password=X', 'supabase db push --password=hunter2 --include-all'],
    ['-p X', 'supabase db push -p hunter2 --include-all'],
    ['-p=X', 'supabase db push -p=hunter2 --include-all'],
    ['--db-password X', 'supabase db push --db-password hunter2 --include-all'],
  ])(
    'redacts the value of %s and keeps the rest of the command',
    (_label, text) => {
      const output = redactSecrets(text);
      expect(output).not.toContain('hunter2');
      expect(output).toMatch(
        /^supabase db push --?[\w-]+[ =]\[redacted\] --include-all$/
      );
    }
  );

  it('redacts a quoted password value with a space', () => {
    expect(
      redactSecrets(`supabase db push --password "hunter 2" --dry-run`)
    ).toBe(`supabase db push --password ${REDACTED} --dry-run`);
  });

  it('keeps psql -p, a port, readable', () => {
    const text = `psql -h ${HOST} -p 5432 -U postgres -c 'select 1'`;
    expect(redactSecrets(text)).toBe(text);
  });

  it('keeps a port readable in a segment that only mentions a supabase host', () => {
    const text = `psql -h db.${REF}.supabase.co -p 5432 -U postgres`;
    expect(redactSecrets(text)).toBe(text);
  });

  it.each([
    'supabase branches list; psql -p 5432',
    'supabase branches list && psql -p 5432',
    'supabase branches list || psql -p 5432',
    'supabase branches list | psql -p 5432',
    'supabase branches list\npsql -p 5432',
  ])('redacts -p only in the supabase segment of `%s`', (text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it.each([
    ['semicolon', ';'],
    ['and', ' &&'],
    ['or', ' ||'],
    ['pipe', ' |'],
    ['newline', '\n'],
  ])(
    'redacts -p after a %s that leads into a supabase segment',
    (_label, separator) => {
      expect(
        redactSecrets(`psql -p 5432${separator} supabase db push -p hunter2`)
      ).toBe(`psql -p 5432${separator} supabase db push -p ${REDACTED}`);
    }
  );

  it.each([
    ['a numbered command', '1. supabase link -p hunter2'],
    ['a JSON command field', '"command": "supabase link -p hunter2"'],
    ['an env prefix', 'SUPABASE_WORKDIR=app supabase link -p hunter2'],
    ['npx', 'npx supabase link -p hunter2'],
    ['a shell wrapper', "bash -lc 'supabase link -p hunter2'"],
  ])('redacts -p in %s', (_label, text) => {
    const output = redactSecrets(text);
    expect(output).not.toContain('hunter2');
    expect(output).toContain(REDACTED);
  });

  it('keeps --project-ref readable next to a redacted -p', () => {
    expect(redactSecrets(`supabase link --project-ref ${REF} -p hunter2`)).toBe(
      `supabase link --project-ref ${REF} -p ${REDACTED}`
    );
  });
});

describe('redactSecrets JSON keys', () => {
  it('redacts db_pass and keeps the key and the structure', () => {
    expect(redactSecrets('{"db_pass": "hunter2", "name": "x"}')).toBe(
      `{"db_pass": "${REDACTED}", "name": "x"}`
    );
  });

  it('redacts jwt_secret', () => {
    expect(redactSecrets('{"jwt_secret":"hunter2"}')).toBe(
      `{"jwt_secret":"${REDACTED}"}`
    );
  });

  it.each([
    'password',
    'db_pass',
    'passphrase',
    'client_secret',
    'access_token',
    'TOKEN',
    'api_key',
    'SERVICE_ROLE_KEY',
    'key',
  ])('redacts the value of the key %s', (key) => {
    expect(redactSecrets(`{"${key}": "hunter2"}`)).toBe(
      `{"${key}": "${REDACTED}"}`
    );
  });

  it.each([
    '{"project_ref": "abcdefghijklmnopqrst"}',
    '{"name": "preview-shipments"}',
    '{"status": "RUNNING_MIGRATIONS"}',
    '{"keyword": "hunter2"}',
    '{"token": 12345}',
    '{"secret": null}',
    '{"db_pass": {"nested": "value"}}',
  ])('leaves %s alone', (text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it('redacts a key inside a string that was JSON-encoded once more', () => {
    const output = redactSecrets(
      JSON.stringify({ output: '{"db_pass": "hunter2", "name": "x"}' })
    );
    expect(output).not.toContain('hunter2');
    expect(output).toContain('db_pass');
    expect(output).toContain('name');
  });

  it('redacts every matching key in a pretty-printed object', () => {
    const output = redactSecrets(
      JSON.stringify(
        { host: HOST, db_pass: 'hunter2', jwt_secret: 'hunter3', ref: REF },
        null,
        2
      )
    );
    expect(output).not.toContain('hunter');
    expect(output).toContain(HOST);
    expect(output).toContain(REF);
  });
});

describe('redactSecrets line-anchored YAML', () => {
  it('redacts an indented db_pass line', () => {
    expect(redactSecrets('  db_pass: hunter2')).toBe(`  db_pass: ${REDACTED}`);
  });

  it('redacts SUPABASE_JWT_SECRET at the start of a line', () => {
    expect(redactSecrets('SUPABASE_JWT_SECRET: hunter2')).toBe(
      `SUPABASE_JWT_SECRET: ${REDACTED}`
    );
  });

  it('redacts matching lines and keeps the others readable', () => {
    expect(
      redactSecrets(
        [
          'host: db.example.com',
          'db_pass: hunter2',
          `ref: ${REF}`,
          'anon_key: hunter3',
        ].join('\n')
      )
    ).toBe(
      [
        'host: db.example.com',
        `db_pass: ${REDACTED}`,
        `ref: ${REF}`,
        `anon_key: ${REDACTED}`,
      ].join('\n')
    );
  });

  it('redacts a quoted value', () => {
    expect(redactSecrets('  api_token: "hunter 2"')).toBe(
      `  api_token: ${REDACTED}`
    );
  });

  it('redacts matching lines inside a string whose newlines were escaped', () => {
    const output = redactSecrets(
      JSON.stringify('db_pass: hunter2\nSUPABASE_JWT_SECRET: hunter3\nhost: h')
    );
    expect(output).not.toContain('hunter');
    expect(output).toContain('host: h');
  });

  it('does not redact prose that mentions a secret mid-sentence', () => {
    const text = "the secret: it's fine";
    expect(redactSecrets(text)).toBe(text);
  });

  it.each([
    'Error: the token: was rejected',
    `project_ref: ${REF}`,
    'API_URL: http://127.0.0.1:54321',
    'keyword: hunter2 is not a key name',
  ])('leaves `%s` alone', (text) => {
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('redactSecrets URL passwords with a raw @ or /', () => {
  it.each([
    [
      'a raw @',
      'postgresql://u:p@ss@host:5432/postgres',
      'postgresql://u:[redacted]@host:5432/postgres',
    ],
    [
      'a raw /',
      'postgresql://u:ab/cd==@host/db',
      'postgresql://u:[redacted]@host/db',
    ],
    [
      'both',
      'postgres://u:a/b@c@host:5432/db?sslmode=require',
      'postgres://u:[redacted]@host:5432/db?sslmode=require',
    ],
  ])(
    'redacts a password with %s up to the last @',
    (_label, text, expected) => {
      expect(redactSecrets(text)).toBe(expected);
    }
  );

  it('stops at the quote that closes the URL', () => {
    expect(
      redactSecrets(`--db-url "postgresql://u:p@ss@host/db" --dry-run`)
    ).toBe(`--db-url "postgresql://u:${REDACTED}@host/db" --dry-run`);
  });

  it('stops at whitespace, so a later e-mail address stays readable', () => {
    expect(
      redactSecrets('postgresql://u:p@ss@host/db then mail dev@example.com')
    ).toBe(`postgresql://u:${REDACTED}@host/db then mail dev@example.com`);
  });

  it('keeps the next URL in an escaped env listing readable', () => {
    const output = redactSecrets(
      JSON.stringify(
        `POSTGRES_URL=postgresql://u:p@ss@host1/db\nDIRECT_URL=postgresql://u2:pw@host2/db`
      )
    );
    expect(output).not.toContain('p@ss');
    expect(output).toContain('host1');
    expect(output).toContain('host2');
  });
});

describe('redactSecrets assignment values stop at command separators', () => {
  it.each([
    [
      '&&',
      'DB_PASSWORD=x&&psql -h h -c "select 1"',
      `DB_PASSWORD=${REDACTED}&&psql -h h -c "select 1"`,
    ],
    ['&', 'DB_PASSWORD=x&psql -h h', `DB_PASSWORD=${REDACTED}&psql -h h`],
    [
      ';',
      'ANON_KEY=x;supabase branches delete p',
      `ANON_KEY=${REDACTED};supabase branches delete p`,
    ],
    ['|', 'PGPASSWORD=x|psql -h h', `PGPASSWORD=${REDACTED}|psql -h h`],
    ['||', 'API_SECRET=x||echo failed', `API_SECRET=${REDACTED}||echo failed`],
  ])('leaves the command after %s visible', (_label, text, expected) => {
    expect(redactSecrets(text)).toBe(expected);
  });

  it('still redacts a quoted value that holds separators', () => {
    expect(redactSecrets(`DB_PASSWORD="a;b&c|d" psql`)).toBe(
      `DB_PASSWORD=${REDACTED} psql`
    );
  });

  it('stops each unquoted value at an escaped newline', () => {
    const output = redactSecrets(
      JSON.stringify('DB_PASSWORD=hunter2\nAPI_URL=http://x\nANON_KEY=hunter3')
    );
    expect(output).not.toContain('hunter');
    expect(output).toContain('API_URL=http://x');
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
    ['the function path', '/functions/v1/shipping-quote'],
    ['a function URL with the project ref', FUNCTION_URL],
    ['a deploy command', 'supabase functions deploy shipping-quote --use-api'],
    ['a source path', 'supabase/functions/shipping-quote/index.ts'],
    ['a quote body', '{"quoteCents":810,"currency":"EUR"}'],
    ['a CLI notice', 'Access token not provided. Run `supabase login`.'],
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

  it('is idempotent over the newer shapes too', () => {
    const text = [
      'psql "host=h password=hunter2"',
      'supabase db push -p hunter3 --password=hunter4',
      '{"db_pass": "hunter5"}',
      'SUPABASE_JWT_SECRET: hunter6',
      'postgresql://u:p@ss@host/db',
    ].join('\n');
    const once = redactSecrets(text);
    expect(redactSecrets(once)).toBe(once);
  });

  it('is idempotent', () => {
    const text = `postgresql://u:${PASSWORD}@h:5432/db ${SBP} PGPASSWORD=${OTHER_PASSWORD} ${JWT}`;
    const once = redactSecrets(text);
    expect(redactSecrets(once)).toBe(once);
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
