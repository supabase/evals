// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-cli-002-use-project-api-keys
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkClientKey,
  checkUrlPointsAtProject,
  describeKeyValue,
  KEY_CHECK_NAME,
  KEY_VAR,
  URL_CHECK_NAME,
  URL_VAR,
} from './config.js';
import { readAppEnv } from './env-files.js';
import {
  ANON_KEY,
  APP_KEY_VAR,
  APP_URL_VAR,
  appEnv,
  CLI_LOCAL_SECRET_KEY,
  dotenv,
  ENV_FAILED,
  expectNoKeyValues,
  fakeJwt,
  HOSTED_ABSENT,
  HOSTED_OK,
  HOSTED_REF,
  LOCAL_ANON_KEY,
  LOCAL_URL,
  NO_ENV,
  OPAQUE_CLIENT_KEY,
  OPAQUE_SECRET_KEY,
  OTHER_PROJECT_SECRET_KEY,
  OTHER_REF,
  PERSONAL_ACCESS_TOKEN,
  PLACEHOLDER_KEY,
  PROJECT_URL,
  PUBLISHABLE_KEY,
  removeWorkspaces,
  SECRET_KEY,
  SERVICE_ROLE_KEY,
  workspaceExec,
} from './fixtures.js';
import type { HostedFacts } from './hosted.js';

afterAll(removeWorkspaces);

const LEGACY_ONLY: HostedFacts = {
  ok: true,
  ref: HOSTED_REF,
  clientKeys: [ANON_KEY],
  secretKeys: [SERVICE_ROLE_KEY],
};

const LOCAL_SERVICE_ROLE_KEY = fakeJwt({
  role: 'service_role',
  iss: 'evals-local-stack',
});
const OTHER_PROJECT_ANON_KEY = fakeJwt({
  role: 'anon',
  iss: 'evals-other-project',
});

const urlEnv = (value: string, file = '.env.local') =>
  appEnv({ [APP_URL_VAR]: [value, file] });
const keyEnv = (value: string, file = '.env.local') =>
  appEnv({ [APP_KEY_VAR]: [value, file] });

const NOT_CLIENT_KEY =
  "holds a value that is not one of our project's client keys";
const HOLDS_SECRET = 'holds a secret key, not a client key';

describe('config constants', () => {
  it('names the variables the seeded app reads and the two checks', () => {
    expect(URL_VAR).toBe('VITE_SUPABASE_URL');
    expect(KEY_VAR).toBe('VITE_SUPABASE_PUBLISHABLE_KEY');
    expect(URL_CHECK_NAME).toBe("the app's config points at our project");
    expect(KEY_CHECK_NAME).toBe(
      "the app's config holds a client key for our project"
    );
  });
});

describe('checkUrlPointsAtProject', () => {
  it.each([
    ['the project URL', PROJECT_URL],
    ['the project URL with a trailing slash', `${PROJECT_URL}/`],
    ['the project URL with surrounding whitespace', `  ${PROJECT_URL}\t`],
    [
      'an upper-case hostname',
      `https://${HOSTED_REF.toUpperCase()}.supabase.co`,
    ],
    ['the explicit https port', `${PROJECT_URL}:443`],
    [
      'a staging domain whose first label is the ref',
      `https://${HOSTED_REF}.supabase.red`,
    ],
  ])('passes for %s', (_, value) => {
    expect(checkUrlPointsAtProject(HOSTED_OK, urlEnv(value))).toMatchObject({
      name: URL_CHECK_NAME,
      passed: true,
    });
  });

  it.each(['.env', '.env.development', '.env.development.local'])(
    'passes when the URL comes from %s',
    (file) => {
      expect(
        checkUrlPointsAtProject(HOSTED_OK, urlEnv(PROJECT_URL, file)).passed
      ).toBe(true);
    }
  );

  it.each([
    ['the local stack URL', LOCAL_URL],
    ['localhost', 'http://localhost:54321'],
    ['another project', `https://${OTHER_REF}.supabase.co`],
    ['the REST path of the project', `${PROJECT_URL}/rest/v1`],
    ['the REST path with a trailing slash', `${PROJECT_URL}/rest/v1/`],
    ['plain http', `http://${HOSTED_REF}.supabase.co`],
    ['a query string', `${PROJECT_URL}/?schema=public`],
    ['a fragment', `${PROJECT_URL}/#top`],
    ['a ref in a longer first label', `https://x${HOSTED_REF}.supabase.co`],
    [
      'a ref with a suffix in the first label',
      `https://${HOSTED_REF}x.supabase.co`,
    ],
    ['the ref as a later label', `https://app.${HOSTED_REF}.supabase.co`],
    ['the ref as a path segment', `https://supabase.co/${HOSTED_REF}`],
    [
      'the ref inside a path on another host',
      `https://example.com/${HOSTED_REF}.supabase.co`,
    ],
    ['a host with no scheme', `${HOSTED_REF}.supabase.co`],
    ['a placeholder', 'your-project-url'],
    ['a non-default port', `${PROJECT_URL}:8443`],
    ['a username', `https://user@${HOSTED_REF}.supabase.co`],
    [
      'a username and password',
      `https://user:hunter2@${HOSTED_REF}.supabase.co`,
    ],
    [
      'credentials and a port',
      `https://user:hunter2@${HOSTED_REF}.supabase.co:8443`,
    ],
  ])('fails for %s, naming the variable and the file', (_, value) => {
    const check = checkUrlPointsAtProject(
      HOSTED_OK,
      urlEnv(value, '.env.local')
    );

    expect(check).toMatchObject({ name: URL_CHECK_NAME, passed: false });
    expect(check.notes).toContain(APP_URL_VAR);
    expect(check.notes).toContain('.env.local');
    expectNoKeyValues(check.notes);
  });

  it('does not echo the password of a URL that carries credentials', () => {
    const check = checkUrlPointsAtProject(
      HOSTED_OK,
      urlEnv(`https://user:hunter2@${HOSTED_REF}.supabase.co:8443`)
    );

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('credentials or a port');
    expect(check.notes).not.toContain('hunter2');
  });

  it('fails with "is unset" when no env file sets the variable', () => {
    const check = checkUrlPointsAtProject(HOSTED_OK, NO_ENV);

    expect(check).toMatchObject({ name: URL_CHECK_NAME, passed: false });
    expect(check.notes).toContain(APP_URL_VAR);
    expect(check.notes).toContain('is unset');
  });

  it('fails with "is unset" when the variable is set to an empty value', () => {
    const check = checkUrlPointsAtProject(HOSTED_OK, urlEnv('', '.env.local'));

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('is unset');
  });

  it('never puts a key in the notes when the URL holds one', () => {
    for (const value of [
      SERVICE_ROLE_KEY,
      ANON_KEY,
      `${PROJECT_URL}/rest/v1?apikey=${SERVICE_ROLE_KEY}`,
      `https://${OTHER_REF}.supabase.co/?apikey=${SECRET_KEY}`,
    ]) {
      const check = checkUrlPointsAtProject(HOSTED_OK, urlEnv(value));

      expect(check.passed).toBe(false);
      expectNoKeyValues(check.notes);
    }
  });

  it('fails with the read failure when the env files could not be read', () => {
    const check = checkUrlPointsAtProject(HOSTED_OK, ENV_FAILED);

    expect(check).toMatchObject({ name: URL_CHECK_NAME, passed: false });
    expect(check.notes).toContain('Permission denied');
  });

  it('fails and names CLI-2754 when there is no hosted project, even for a URL that looks right', () => {
    const check = checkUrlPointsAtProject(HOSTED_ABSENT, urlEnv(PROJECT_URL));

    expect(check).toMatchObject({ name: URL_CHECK_NAME, passed: false });
    expect(check.notes).toContain('CLI-2754');
  });

  it('shows only the host of the configured URL when there is no hosted project', () => {
    const check = checkUrlPointsAtProject(
      HOSTED_ABSENT,
      urlEnv(`${LOCAL_URL}/?apikey=${SERVICE_ROLE_KEY}`)
    );

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('127.0.0.1');
    expectNoKeyValues(check.notes);
  });
});

describe('checkClientKey', () => {
  it.each([
    ['the legacy anon key', ANON_KEY],
    ['the publishable key', PUBLISHABLE_KEY],
  ])('passes for %s', (_, value) => {
    expect(checkClientKey(HOSTED_OK, keyEnv(value))).toMatchObject({
      name: KEY_CHECK_NAME,
      passed: true,
    });
  });

  it('passes for an opaque client key the project returned', () => {
    const hosted: HostedFacts = {
      ok: true,
      ref: HOSTED_REF,
      clientKeys: [OPAQUE_CLIENT_KEY],
      secretKeys: [OPAQUE_SECRET_KEY],
    };

    expect(checkClientKey(hosted, keyEnv(OPAQUE_CLIENT_KEY)).passed).toBe(true);
  });

  it.each(['.env', '.env.development', '.env.development.local'])(
    'passes when the key comes from %s',
    (file) => {
      expect(checkClientKey(HOSTED_OK, keyEnv(ANON_KEY, file)).passed).toBe(
        true
      );
    }
  );

  it.each([
    ['the service_role key', SERVICE_ROLE_KEY, HOLDS_SECRET],
    ['the sb_secret_ key', SECRET_KEY, HOLDS_SECRET],
  ])(
    'fails for %s, saying it is the secret key without printing it',
    (_, value, phrase) => {
      const check = checkClientKey(HOSTED_OK, keyEnv(value, '.env.local'));

      expect(check).toMatchObject({ name: KEY_CHECK_NAME, passed: false });
      expect(check.notes).toContain(APP_KEY_VAR);
      expect(check.notes).toContain('.env.local');
      expect(check.notes).toContain(phrase);
      expectNoKeyValues(check.notes);
    }
  );

  it.each([
    ['a local stack anon key', LOCAL_ANON_KEY],
    ['another project’s anon key', OTHER_PROJECT_ANON_KEY],
    ['a placeholder', PLACEHOLDER_KEY],
    ['the anon key cut one character short', ANON_KEY.slice(0, -1)],
    ['the anon key with a character appended', `${ANON_KEY}x`],
    ['the publishable key cut short', PUBLISHABLE_KEY.slice(0, -1)],
    [
      'a publishable-shaped key the project does not have',
      'sb_publishable_evalfixture_other_do_not_use',
    ],
    ['the anon key with a leading space', ` ${ANON_KEY}`],
    ['the anon key with trailing whitespace', `${ANON_KEY}  `],
    [
      'the publishable key with surrounding whitespace',
      `\t${PUBLISHABLE_KEY} `,
    ],
  ])(
    'fails for %s, saying it is not one of the project’s client keys',
    (_, value) => {
      const check = checkClientKey(HOSTED_OK, keyEnv(value, '.env.local'));

      expect(check).toMatchObject({ name: KEY_CHECK_NAME, passed: false });
      expect(check.notes).toContain(APP_KEY_VAR);
      expect(check.notes).toContain('.env.local');
      expect(check.notes).toContain(NOT_CLIENT_KEY);
      expect(check.notes).not.toContain(value);
      expectNoKeyValues(check.notes);
    }
  );

  it('judges membership in the project’s own client keys, not the shape of the key', () => {
    const check = checkClientKey(LEGACY_ONLY, keyEnv(PUBLISHABLE_KEY));

    expect(check.passed).toBe(false);
    expect(check.notes).toContain(NOT_CLIENT_KEY);
  });

  it('fails for a secret key of another project without calling it a client key', () => {
    const check = checkClientKey(HOSTED_OK, keyEnv(OTHER_PROJECT_SECRET_KEY));

    expect(check.passed).toBe(false);
    expect(check.notes).toMatch(/secret/i);
    expect(check.notes).not.toContain(OTHER_PROJECT_SECRET_KEY);
  });

  it('fails for a pasted sbp_ access token, saying it is a secret key and not a client key', () => {
    const check = checkClientKey(HOSTED_OK, keyEnv(PERSONAL_ACCESS_TOKEN));

    expect(check).toMatchObject({ name: KEY_CHECK_NAME, passed: false });
    expect(check.notes).toBe(`${APP_KEY_VAR} in .env.local ${HOLDS_SECRET}`);
    expectNoKeyValues(check.notes);
  });

  it('fails for a local-stack service_role key without a hosted project, saying it is a secret key and not a client key', () => {
    const check = checkClientKey(HOSTED_ABSENT, keyEnv(LOCAL_SERVICE_ROLE_KEY));

    expect(check.passed).toBe(false);
    expect(check.notes).toContain(
      `${APP_KEY_VAR} in .env.local ${HOLDS_SECRET}`
    );
    expect(check.notes).toContain('CLI-2754');
    expect(check.notes).not.toContain(LOCAL_SERVICE_ROLE_KEY);
  });

  it.each([
    ['not set by any file', NO_ENV],
    ['set to an empty value', keyEnv('')],
    ['set to whitespace only', keyEnv('  ')],
  ])('fails with "is unset" when the variable is %s', (_, env) => {
    const check = checkClientKey(HOSTED_OK, env);

    expect(check).toMatchObject({ name: KEY_CHECK_NAME, passed: false });
    expect(check.notes).toContain(APP_KEY_VAR);
    expect(check.notes).toContain('is unset');
  });

  it('fails with the read failure when the env files could not be read', () => {
    const check = checkClientKey(HOSTED_OK, ENV_FAILED);

    expect(check).toMatchObject({ name: KEY_CHECK_NAME, passed: false });
    expect(check.notes).toContain('Permission denied');
  });

  it.each([
    ['the anon key', ANON_KEY],
    ['the service_role key', SERVICE_ROLE_KEY],
    ['the sb_secret_ key', SECRET_KEY],
    ['a placeholder', PLACEHOLDER_KEY],
  ])(
    'fails and names CLI-2754 without printing the key when there is no hosted project and the config holds %s',
    (_, value) => {
      const check = checkClientKey(HOSTED_ABSENT, keyEnv(value));

      expect(check).toMatchObject({ name: KEY_CHECK_NAME, passed: false });
      expect(check.notes).toContain('CLI-2754');
      expect(check.notes).not.toContain(value);
      expectNoKeyValues(check.notes);
    }
  );

  it('fails with no hosted project when the key is unset too', () => {
    const check = checkClientKey(HOSTED_ABSENT, NO_ENV);

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('CLI-2754');
  });
});

describe('describeKeyValue', () => {
  const OPAQUE_HOSTED: HostedFacts = {
    ok: true,
    ref: HOSTED_REF,
    clientKeys: [OPAQUE_CLIENT_KEY],
    secretKeys: [OPAQUE_SECRET_KEY],
  };

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace only', ' \t'],
  ])('reports unset for %s', (_, value) => {
    expect(describeKeyValue(HOSTED_OK, value)).toBe('unset');
    expect(describeKeyValue(HOSTED_ABSENT, value)).toBe('unset');
  });

  it.each([
    ['the anon key', ANON_KEY],
    ['the publishable key', PUBLISHABLE_KEY],
  ])('reports client for %s', (_, value) => {
    expect(describeKeyValue(HOSTED_OK, value)).toBe('client');
  });

  it.each([
    ['the service_role key', SERVICE_ROLE_KEY],
    ['the sb_secret_ key', SECRET_KEY],
    [
      'a service_role key of another project',
      fakeJwt({ role: 'service_role', iss: 'evals-other-project' }),
    ],
    ['an sb_secret_ key of another project', OTHER_PROJECT_SECRET_KEY],
    ['the local default sb_secret_ key of the CLI', CLI_LOCAL_SECRET_KEY],
    ['an sbp_ access token', PERSONAL_ACCESS_TOKEN],
  ])('reports secret for %s', (_, value) => {
    expect(describeKeyValue(HOSTED_OK, value)).toBe('secret');
  });

  it.each([
    ['a local stack anon key', LOCAL_ANON_KEY],
    ['a placeholder', PLACEHOLDER_KEY],
    ['a placeholder sb_secret_ key', 'sb_secret_your-secret-key-here'],
    [
      'a publishable-shaped key the project does not have',
      'sb_publishable_evalfixture_other_do_not_use',
    ],
    ['the anon key cut short', ANON_KEY.slice(0, -1)],
    ['the anon key with a leading space', ` ${ANON_KEY}`],
  ])('reports other for %s', (_, value) => {
    expect(describeKeyValue(HOSTED_OK, value)).toBe('other');
  });

  it('recognises a known client key and a known secret key that have no recognisable shape', () => {
    expect(describeKeyValue(OPAQUE_HOSTED, OPAQUE_CLIENT_KEY)).toBe('client');
    expect(describeKeyValue(OPAQUE_HOSTED, OPAQUE_SECRET_KEY)).toBe('secret');
  });

  it('still recognises secret-shaped keys, and nothing as client, without a hosted project', () => {
    expect(describeKeyValue(HOSTED_ABSENT, SERVICE_ROLE_KEY)).toBe('secret');
    expect(describeKeyValue(HOSTED_ABSENT, SECRET_KEY)).toBe('secret');
    expect(describeKeyValue(HOSTED_ABSENT, ANON_KEY)).toBe('other');
    expect(describeKeyValue(HOSTED_ABSENT, PUBLISHABLE_KEY)).toBe('other');
  });
});

describe('the checks against the env that vite expands', () => {
  const resolve = async (files: Record<string, string>) => {
    const { ctx } = workspaceExec(files);
    return readAppEnv(ctx);
  };

  it('passes both checks when the key variable references the anon key and the URL is built from the ref', async () => {
    const env = await resolve({
      '.env': dotenv({
        SUPABASE_ANON_KEY: ANON_KEY,
        SUPABASE_PROJECT_REF: HOSTED_REF,
      }),
      '.env.local': dotenv({
        [APP_URL_VAR]: 'https://${SUPABASE_PROJECT_REF}.supabase.co',
        [APP_KEY_VAR]: '${SUPABASE_ANON_KEY}',
      }),
    });

    expect(checkUrlPointsAtProject(HOSTED_OK, env)).toEqual({
      name: URL_CHECK_NAME,
      passed: true,
    });
    expect(checkClientKey(HOSTED_OK, env)).toEqual({
      name: KEY_CHECK_NAME,
      passed: true,
    });
  });

  it('fails the key check, naming the file and the kind, when the key variable references the service_role key', async () => {
    const env = await resolve({
      '.env.local': dotenv({
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
        [APP_KEY_VAR]: '$SUPABASE_SERVICE_ROLE_KEY',
      }),
    });

    const check = checkClientKey(HOSTED_OK, env);

    expect(check.passed).toBe(false);
    expect(check.notes).toBe(`${APP_KEY_VAR} in .env.local ${HOLDS_SECRET}`);
    expectNoKeyValues(check.notes);
  });

  it('fails the URL check when the URL variable references the local stack', async () => {
    const env = await resolve({
      '.env': dotenv({ LOCAL_API: LOCAL_URL }),
      '.env.local': dotenv({ [APP_URL_VAR]: '${LOCAL_API}' }),
    });

    expect(checkUrlPointsAtProject(HOSTED_OK, env).notes).toContain(
      'is not https'
    );
  });

  it('treats a reference to an unset variable as unset', async () => {
    const env = await resolve({
      '.env.local': dotenv({
        [APP_URL_VAR]: '${NOTHING_SETS_THIS}',
        [APP_KEY_VAR]: '${NOTHING_SETS_THIS}',
      }),
    });

    expect(checkUrlPointsAtProject(HOSTED_OK, env).notes).toBe(
      `${APP_URL_VAR} is unset`
    );
    expect(checkClientKey(HOSTED_OK, env).notes).toBe(
      `${APP_KEY_VAR} is unset`
    );
  });
});
