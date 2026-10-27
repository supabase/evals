// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-cli-002-use-project-api-keys
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ANON_KEY,
  anyCatRoute,
  APP_KEY_VAR,
  checkIgnoreRoute,
  CLI_LOCAL_SECRET_KEY,
  commandResult,
  controlRoute,
  crash,
  dotenv,
  envFilesRoute,
  expectNoKeyValues,
  failure,
  fakeExec,
  fakeJwt,
  grepRoute,
  KILLED,
  PERSONAL_ACCESS_TOKEN,
  PUBLISHABLE_KEY,
  removeWorkspaces,
  SECRET_KEY,
  secretKeyWith,
  SERVICE_ROLE_KEY,
  stderrFailure,
  workspaceExec,
} from './fixtures.js';
import {
  checkNoSecretExposed,
  findExposedSecrets,
  findSecretTokens,
  SECRET_CHECK_NAME,
} from './secrets.js';

afterAll(removeWorkspaces);

const b64url = (text: string) => Buffer.from(text).toString('base64url');
const HEADER = b64url('{"alg":"HS256","typ":"JWT"}');
const rawJwt = (payloadText: string) =>
  [HEADER, b64url(payloadText), 'do-not-use'].join('.');

const KNOWN_PLAIN = 'evals-fixture-plain-secret-do-not-use-0001';
const PLACEHOLDER_IN_KEY_LAYOUT = secretKeyWith('x'.repeat(22), 'x'.repeat(8));

const found = (text: string, known: readonly string[] = []) =>
  [...new Set(findSecretTokens(text, known))].sort();

describe('findSecretTokens', () => {
  it.each([
    [
      'a sb_secret_ key assigned in an env file',
      `SUPABASE_SECRET_KEY=${SECRET_KEY}`,
      [SECRET_KEY],
    ],
    [
      'a service_role JWT assigned in an env file',
      `SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}`,
      [SERVICE_ROLE_KEY],
    ],
    [
      'a service_role JWT in double quotes',
      `const key = "${SERVICE_ROLE_KEY}";`,
      [SERVICE_ROLE_KEY],
    ],
    [
      'a sb_secret_ key in single quotes followed by punctuation',
      `createClient(url, '${SECRET_KEY}');`,
      [SECRET_KEY],
    ],
    [
      'a service_role JWT in a JSON string',
      `{"key":"${SERVICE_ROLE_KEY}","other":1}`,
      [SERVICE_ROLE_KEY],
    ],
    [
      'a service_role JWT after Bearer',
      `Authorization: Bearer ${SERVICE_ROLE_KEY}`,
      [SERVICE_ROLE_KEY],
    ],
    [
      'a service_role JWT with extra claims',
      rawJwt(
        '{"iss":"supabase","ref":"abcdefghijklmnopqrst","role":"service_role","exp":1}'
      ),
      [
        rawJwt(
          '{"iss":"supabase","ref":"abcdefghijklmnopqrst","role":"service_role","exp":1}'
        ),
      ],
    ],
  ])('finds %s', (_, text, expected) => {
    expect(found(text)).toEqual([...expected].sort());
  });

  it('finds the local default sb_secret_ key of the Supabase CLI', () => {
    expect(found(`SUPABASE_SECRET_KEY=${CLI_LOCAL_SECRET_KEY}`)).toEqual([
      CLI_LOCAL_SECRET_KEY,
    ]);
  });

  it('finds an sb_secret_ key whose body holds dashes and underscores', () => {
    const key = secretKeyWith('Ab-Cd_Ef-Gh_Ij-Kl_Mn-O', '-pq_rstu');

    expect(found(`SUPABASE_SECRET_KEY=${key}`)).toEqual([key]);
  });

  it('finds an sb_secret_ key with exactly eight distinct characters in its body', () => {
    const key = secretKeyWith('abcdefgh'.repeat(3).slice(0, 22));

    expect(found(key)).toEqual([key]);
  });

  it.each(['sbp_', 'sbp_oauth_', 'sbp_v0_'])(
    'finds an %s access token',
    (prefix) => {
      const token = `${prefix}${'0123456789abcdef'.repeat(3).slice(0, 40)}`;

      expect(found(`SUPABASE_ACCESS_TOKEN=${token}`)).toEqual([token]);
      expect(found(`token: "${token}"`)).toEqual([token]);
    }
  );

  it('finds the fixture access token', () => {
    expect(found(`SUPABASE_ACCESS_TOKEN=${PERSONAL_ACCESS_TOKEN}`)).toEqual([
      PERSONAL_ACCESS_TOKEN,
    ]);
  });

  it('finds every secret in a text that holds several', () => {
    const text = [
      `A=${SERVICE_ROLE_KEY}`,
      `B=${SECRET_KEY}`,
      `C=${ANON_KEY}`,
    ].join('\n');

    expect(found(text)).toEqual([SERVICE_ROLE_KEY, SECRET_KEY].sort());
  });

  it('finds a known secret value that has no recognisable shape', () => {
    expect(found(`token = ${KNOWN_PLAIN}`, [KNOWN_PLAIN])).toEqual([
      KNOWN_PLAIN,
    ]);
  });

  it('does not report a known secret that is absent from the text', () => {
    expect(found('nothing to see here', [KNOWN_PLAIN])).toEqual([]);
  });

  it('ignores an empty known secret instead of matching everything', () => {
    expect(found('nothing to see here', [''])).toEqual([]);
  });

  it.each([
    ['the anon JWT', `VITE_KEY=${ANON_KEY}`],
    ['the publishable key', `VITE_KEY=${PUBLISHABLE_KEY}`],
    ['text with no keys', 'const answer = 42;'],
    [
      'the bare sb_secret_ prefix in prose',
      'secret keys start with sb_secret_ and are shown once',
    ],
    [
      'an elided sb_secret_ key in prose',
      'looks like sb_secret_... in the dashboard',
    ],
    ['a placeholder sb_secret_ key', 'SUPABASE_SECRET_KEY=sb_secret_xxxxxxxx'],
    [
      'a dashed placeholder sb_secret_ key',
      'SUPABASE_SECRET_KEY=sb_secret_your-secret-key-here',
    ],
    [
      'a commented-out sb_secret_ placeholder of x characters',
      `# SUPABASE_SECRET_KEY=sb_secret_${'x'.repeat(32)}`,
    ],
    [
      'a backticked sb_secret_ placeholder in a README',
      'The server key looks like `sb_secret_XXXXXXXXXXXXXXXXXXXXXXXX`.',
    ],
    [
      'an sb_secret_ placeholder in the real layout with one repeated character',
      PLACEHOLDER_IN_KEY_LAYOUT,
    ],
    [
      'an sb_secret_ key with seven distinct characters in its body',
      secretKeyWith('abcdefg'.repeat(4).slice(0, 22)),
    ],
    [
      'sb_secret_key in prose',
      'never put an sb_secret_key in a VITE_ variable',
    ],
    [
      'an sb_secret_ key with a body one character short',
      secretKeyWith('a1b2c3d4e5f6g7h8i9j0k'),
    ],
    [
      'an sb_secret_ key with a body one character long',
      secretKeyWith('a1b2c3d4e5f6g7h8i9j0klm'),
    ],
    [
      'an sb_secret_ key with a tail one character short',
      secretKeyWith('a1b2c3d4e5f6g7h8i9j0kl', 'abcd123'),
    ],
    [
      'an sb_secret_ key that is part of a longer token',
      secretKeyWith('a1b2c3d4e5f6g7h8i9j0kl', 'abcd1234x'),
    ],
    [
      'an sb_secret_ key glued to a longer token before it',
      `x${secretKeyWith('a1b2c3d4e5f6g7h8i9j0kl')}`,
    ],
    [
      'the bare sbp_ prefix in prose',
      'access tokens start with sbp_ and expire',
    ],
    [
      'an sbp_ placeholder',
      'SUPABASE_ACCESS_TOKEN=sbp_your-personal-access-token',
    ],
    ['an sbp_ token one hex digit short', `sbp_${'a1'.repeat(19)}b`],
    ['an sbp_ token one hex digit long', `sbp_${'a1'.repeat(20)}b`],
    ['an sbp_ token with a non-hex digit', `sbp_${'a1'.repeat(19)}ag`],
    [
      'an sbp_ token glued to a longer token before it',
      `x_sbp_${'a1'.repeat(20)}`,
    ],
    ['a JWT whose payload is not JSON', rawJwt('{"role":"service_role"')],
    [
      'a JWT without a role claim',
      rawJwt('{"iss":"supabase","sub":"service_role"}'),
    ],
    ['a JWT whose role is an array', rawJwt('{"role":["service_role"]}')],
    ['a JWT whose role is null', rawJwt('{"role":null}')],
    [
      'a token with only two JWT segments',
      `${HEADER}.${b64url('{"role":"service_role"}')}`,
    ],
    ['a JWT-looking prefix', 'eyJ'],
    [
      'a service_role JWT with a different capitalisation',
      fakeJwt({ role: 'Service_Role' }),
    ],
  ])('does not report %s', (_, text) => {
    expect(found(text)).toEqual([]);
  });

  it('still reports a real secret that sits next to a malformed JWT', () => {
    const text = `${rawJwt('{"role":"service_role"')} ${SERVICE_ROLE_KEY}`;

    expect(found(text)).toEqual([SERVICE_ROLE_KEY]);
  });
});

describe('findExposedSecrets with scripted commands', () => {
  const CLEAN_SEARCH = grepRoute(failure(1));
  const NO_ENV_FILES = envFilesRoute(commandResult());

  const withCandidate = (
    content: string,
    ignored: Parameters<typeof checkIgnoreRoute>[0] = failure(1)
  ) => [
    controlRoute(commandResult()),
    grepRoute(commandResult('./src/supabase.ts\0')),
    NO_ENV_FILES,
    anyCatRoute(commandResult(content)),
    checkIgnoreRoute(ignored),
  ];

  const probeFailure = async (...routes: Parameters<typeof fakeExec>[0]) => {
    const { ctx, calls } = fakeExec(routes);
    const probe = await findExposedSecrets(ctx, []);
    expect(probe.ok).toBe(false);
    if (probe.ok) throw new Error('expected a failed probe');
    return { notes: probe.notes, calls };
  };

  it('reports a clean workspace when the positive control passes and grep finds no file', async () => {
    const { ctx, calls } = fakeExec([
      controlRoute(commandResult()),
      CLEAN_SEARCH,
      NO_ENV_FILES,
    ]);

    expect(await findExposedSecrets(ctx, [SERVICE_ROLE_KEY])).toEqual({
      ok: true,
      exposures: [],
      storedPrivately: [],
    });
    expect(calls.some((call) => /check-ignore/.test(call))).toBe(false);
  });

  it('fails the probe, never searching, when the positive control fails', async () => {
    const { notes, calls } = await probeFailure(
      controlRoute(failure(1)),
      CLEAN_SEARCH
    );

    expect(notes).toContain('supabase/config.toml');
    expect(calls.some((call) => /\bgrep\b/.test(call))).toBe(false);
  });

  it('fails the probe with the thrown message when the positive control throws', async () => {
    const { notes } = await probeFailure(
      controlRoute(crash('sandbox gone')),
      CLEAN_SEARCH
    );

    expect(notes).toContain('sandbox gone');
  });

  it('fails the probe, carrying the error, when grep exits 2', async () => {
    const { notes } = await probeFailure(
      controlRoute(commandResult()),
      grepRoute(stderrFailure(2, 'grep: Unmatched ( or \\('))
    );

    expect(notes).toContain('grep: Unmatched');
  });

  it('fails the probe when grep never exits, rather than reporting a clean workspace', async () => {
    await probeFailure(controlRoute(commandResult()), grepRoute(KILLED));
  });

  it('fails the probe with the thrown message when grep throws', async () => {
    const { notes } = await probeFailure(
      controlRoute(commandResult()),
      grepRoute(crash('sandbox gone'))
    );

    expect(notes).toContain('sandbox gone');
  });

  it('fails the probe, carrying the error, when git check-ignore exits 128', async () => {
    const { notes } = await probeFailure(
      ...withCandidate(
        `const key = "${SECRET_KEY}";`,
        stderrFailure(128, 'fatal: not a git repository')
      )
    );

    expect(notes).toContain('fatal: not a git repository');
  });

  it.each([
    ['exits without a code', KILLED],
    ['exits 2', stderrFailure(2, 'error')],
    ['throws', crash('sandbox gone')],
  ])(
    'fails the probe, rather than assuming the file is committed or ignored, when git check-ignore %s',
    async (_, ignored) => {
      await probeFailure(
        ...withCandidate(`const key = "${SECRET_KEY}";`, ignored)
      );
    }
  );

  it('fails the probe when a file that grep listed cannot be read, rather than skipping it', async () => {
    const { notes } = await probeFailure(
      controlRoute(commandResult()),
      grepRoute(commandResult('./src/supabase.ts\0')),
      NO_ENV_FILES,
      anyCatRoute(stderrFailure(1, 'cat: ./src/supabase.ts: Permission denied'))
    );

    expect(notes).toContain('src/supabase.ts');
    expect(notes).toContain('Permission denied');
  });

  it.each([
    ['exits non-zero', stderrFailure(1, 'find: ./: Permission denied')],
    ['exits without a code', KILLED],
    ['throws', crash('sandbox gone')],
  ])(
    'fails the probe, reading nothing, when listing the root env files %s',
    async (_, listing) => {
      const { calls } = await probeFailure(
        controlRoute(commandResult()),
        CLEAN_SEARCH,
        envFilesRoute(listing)
      );

      expect(calls.some((call) => /^cat\b/.test(call))).toBe(false);
    }
  );

  it('fails the probe when a root env file that find listed cannot be read', async () => {
    const { notes } = await probeFailure(
      controlRoute(commandResult()),
      CLEAN_SEARCH,
      envFilesRoute(commandResult('./.env.local\0')),
      anyCatRoute(stderrFailure(1, 'cat: .env.local: Permission denied'))
    );

    expect(notes).toContain('.env.local');
  });

  it('reads a root env file that grep did not list', async () => {
    const { ctx, calls } = fakeExec([
      controlRoute(commandResult()),
      CLEAN_SEARCH,
      envFilesRoute(commandResult('./.env.local\0')),
      anyCatRoute(commandResult(dotenv({ [APP_KEY_VAR]: SERVICE_ROLE_KEY }))),
      checkIgnoreRoute(commandResult('.env.local\0')),
    ]);

    const probe = await findExposedSecrets(ctx, []);

    expect(calls.filter((call) => /^cat\b/.test(call))).toHaveLength(1);
    expect(probe).toEqual({
      ok: true,
      exposures: [
        `${APP_KEY_VAR} in .env.local ships a secret key to the browser`,
      ],
      storedPrivately: [],
    });
  });

  it('reads a file that both grep and find list once', async () => {
    const { ctx, calls } = fakeExec([
      controlRoute(commandResult()),
      grepRoute(commandResult('./.env.local\0./src/supabase.ts\0')),
      envFilesRoute(commandResult('./.env.local\0')),
      anyCatRoute(commandResult(dotenv({ SUPABASE_SECRET_KEY: SECRET_KEY }))),
      checkIgnoreRoute(failure(1)),
    ]);

    await findExposedSecrets(ctx, []);

    expect(calls.filter((call) => /^cat\b/.test(call))).toEqual([
      "cat -- '.env.local'",
      "cat -- 'src/supabase.ts'",
    ]);
  });

  it('reports a file that git does not ignore as committed with a secret, without ./ and without the key', async () => {
    const { ctx } = fakeExec(
      withCandidate(`const key = "${SECRET_KEY}";`, failure(1))
    );

    const probe = await findExposedSecrets(ctx, []);

    expect(probe).toEqual({
      ok: true,
      exposures: ['src/supabase.ts would be committed with a secret key'],
      storedPrivately: [],
    });
    expectNoKeyValues(JSON.stringify(probe));
  });

  it('accepts grep paths printed without a ./ prefix', async () => {
    const { ctx } = fakeExec([
      controlRoute(commandResult()),
      grepRoute(commandResult('src/supabase.ts\0')),
      NO_ENV_FILES,
      anyCatRoute(commandResult(`const key = "${SECRET_KEY}";`)),
      checkIgnoreRoute(failure(1)),
    ]);

    const probe = await findExposedSecrets(ctx, []);

    expect(probe.ok && probe.exposures).toEqual([
      'src/supabase.ts would be committed with a secret key',
    ]);
  });

  it('reports no exposure for a secret in a file git ignores', async () => {
    const { ctx } = fakeExec(
      withCandidate(
        `const key = "${SECRET_KEY}";`,
        commandResult('src/supabase.ts\0')
      )
    );

    const probe = await findExposedSecrets(ctx, []);

    expect(probe).toEqual({
      ok: true,
      exposures: [],
      storedPrivately: ['src/supabase.ts'],
    });
  });

  it('drops a candidate whose content holds no secret, such as an anon key, and never asks git about it', async () => {
    const { ctx, calls } = fakeExec(
      withCandidate(`const key = "${ANON_KEY}";`)
    );

    expect(await findExposedSecrets(ctx, [])).toEqual({
      ok: true,
      exposures: [],
      storedPrivately: [],
    });
    expect(calls.some((call) => /check-ignore/.test(call))).toBe(false);
  });

  it('asks git with a throwaway repository and never runs git init in the workspace', async () => {
    const { ctx, calls } = fakeExec(
      withCandidate(`const key = "${SECRET_KEY}";`)
    );

    await findExposedSecrets(ctx, []);

    const command = calls.find((call) => /check-ignore/.test(call)) ?? '';
    expect(command).toContain('mktemp -d');
    expect(command).toContain('--git-dir');
    expect(command).toContain('--work-tree');
    expect(command).toContain('src/supabase.ts');
    expect(command).toContain('rm -rf "$T"');
    expect(command).toMatch(/exit \$s$/);
    expect(command).not.toMatch(/git init(?:\s+-\S+)*\s*(?:&&|;|\||$)/);
  });
});

describe('findExposedSecrets against a real workspace', () => {
  const run = async (
    files: Record<string, string | null>,
    known: readonly string[] = []
  ) => {
    const { ctx, dir } = workspaceExec(files);
    const probe = await findExposedSecrets(ctx, known);
    return { probe, dir };
  };

  const okProbe = (probe: Awaited<ReturnType<typeof findExposedSecrets>>) => {
    if (!probe.ok) throw new Error(`expected an ok probe, got: ${probe.notes}`);
    expectNoKeyValues(JSON.stringify(probe));
    return { ...probe, exposures: [...probe.exposures].sort() };
  };

  it('finds nothing in the seeded app', async () => {
    const { probe } = await run({});

    expect(okProbe(probe)).toEqual({
      ok: true,
      exposures: [],
      storedPrivately: [],
    });
  });

  it.each([
    ['the anon key', ANON_KEY],
    ['the publishable key', PUBLISHABLE_KEY],
  ])(
    'finds nothing when %s is written to .env.local with the URL',
    async (_, key) => {
      const { probe } = await run({
        '.env.local': dotenv({
          VITE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
          [APP_KEY_VAR]: key,
        }),
      });

      expect(okProbe(probe)).toEqual({
        ok: true,
        exposures: [],
        storedPrivately: [],
      });
    }
  );

  it.each([
    [
      'a service_role key in the gitignored .env.local',
      '.env.local',
      'SUPABASE_SERVICE_ROLE_KEY',
      SERVICE_ROLE_KEY,
    ],
    [
      'an sb_secret_ key in the gitignored .env',
      '.env',
      'SUPABASE_SECRET_KEY',
      SECRET_KEY,
    ],
    [
      'a service_role key in the gitignored .env.development.local',
      '.env.development.local',
      'SUPABASE_SERVICE_ROLE_KEY',
      SERVICE_ROLE_KEY,
    ],
  ])(
    'treats %s as stored privately, not exposed',
    async (_, file, name, key) => {
      const { probe } = await run({
        [file]: dotenv({
          VITE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
          [name]: key,
        }),
      });

      const result = okProbe(probe);

      expect(result.exposures).toEqual([]);
      expect(result.storedPrivately).toHaveLength(1);
      expect(result.storedPrivately[0]).toContain(file);
    }
  );

  it.each([
    [
      'a service_role key in .env.local',
      '.env.local',
      SERVICE_ROLE_KEY,
      APP_KEY_VAR,
    ],
    ['an sb_secret_ key in .env', '.env', SECRET_KEY, APP_KEY_VAR],
    [
      'a service_role key under another VITE_ name',
      '.env.local',
      SERVICE_ROLE_KEY,
      'VITE_SERVICE_KEY',
    ],
  ])(
    'flags %s as shipped to the browser even though the file is ignored',
    async (_, file, key, name) => {
      const { probe } = await run({ [file]: dotenv({ [name]: key }) });

      const result = okProbe(probe);

      expect(result.exposures).toEqual([
        `${name} in ${file} ships a secret key to the browser`,
      ]);
      expect(result.storedPrivately).toEqual([]);
    }
  );

  it('flags a secret in a VITE_ variable written with export, quotes and CRLF line endings', async () => {
    const { probe } = await run({
      '.env.local': `export ${APP_KEY_VAR}="${SERVICE_ROLE_KEY}" # pasted\r\n`,
    });

    expect(okProbe(probe).exposures).toEqual([
      `${APP_KEY_VAR} in .env.local ships a secret key to the browser`,
    ]);
  });

  it('does not treat a commented-out VITE_ assignment as shipped to the browser', async () => {
    const { probe } = await run({
      '.env.local': `# ${APP_KEY_VAR}=${SERVICE_ROLE_KEY}\n`,
    });

    expect(okProbe(probe).exposures).toEqual([]);
  });

  it('flags a secret hard-coded in a source file as committed', async () => {
    const { probe } = await run({
      'src/supabase.ts': `export const supabase = createClient(url, '${SERVICE_ROLE_KEY}');\n`,
    });

    expect(okProbe(probe).exposures).toEqual([
      'src/supabase.ts would be committed with a secret key',
    ]);
  });

  it('flags a secret under a non-VITE_ name in .env.example as committed only', async () => {
    const { probe } = await run({
      '.env.example': dotenv({ SUPABASE_SECRET_KEY: SECRET_KEY }),
    });

    expect(okProbe(probe).exposures).toEqual([
      '.env.example would be committed with a secret key',
    ]);
  });

  it.each(['.env.example', '.env.test'])(
    'flags a secret in a VITE_ variable of %s as committed and as held but not loaded by Vite',
    async (file) => {
      const { probe } = await run({
        [file]: dotenv({ [APP_KEY_VAR]: SERVICE_ROLE_KEY }),
      });

      expect(okProbe(probe).exposures).toEqual(
        [
          `${APP_KEY_VAR} in ${file} holds a secret key (Vite doesn't load this file in dev or production)`,
          `${file} would be committed with a secret key`,
        ].sort()
      );
    }
  );

  describe('a VITE_ secret that Vite resolves away', () => {
    const OVERRIDDEN = (file: string) =>
      `${APP_KEY_VAR} in ${file} holds a secret key (overridden, so not currently shipped)`;
    const SHIPS = (file: string) =>
      `${APP_KEY_VAR} in ${file} ships a secret key to the browser`;

    it.each([
      ['.env', '.env.local', []],
      [
        '.env.development',
        '.env.development.local',
        ['.env.development would be committed with a secret key'],
      ],
      [
        '.env.production',
        '.env.production.local',
        ['.env.production would be committed with a secret key'],
      ],
    ])(
      'says the secret in %s is overridden, not shipped, when %s sets the anon key',
      async (leftover, override, committed) => {
        const { probe } = await run({
          [leftover]: dotenv({ [APP_KEY_VAR]: SERVICE_ROLE_KEY }),
          [override]: dotenv({ [APP_KEY_VAR]: ANON_KEY }),
        });

        expect(okProbe(probe)).toEqual({
          ok: true,
          exposures: [...committed, OVERRIDDEN(leftover)].sort(),
          storedPrivately: [],
        });
      }
    );

    it.each([
      ['.env', '.env.production'],
      ['.env', '.env.development'],
    ])(
      'still says the secret in %s ships when %s overrides it in only one mode',
      async (leftover, override) => {
        const { probe } = await run({
          [leftover]: dotenv({ [APP_KEY_VAR]: SERVICE_ROLE_KEY }),
          [override]: dotenv({ [APP_KEY_VAR]: ANON_KEY }),
        });

        expect(okProbe(probe).exposures).toEqual([SHIPS(leftover)]);
      }
    );

    it('says the overridden secret is not shipped and the overriding one ships when both files hold a secret', async () => {
      const { probe } = await run({
        '.env': dotenv({ [APP_KEY_VAR]: SERVICE_ROLE_KEY }),
        '.env.local': dotenv({ [APP_KEY_VAR]: SECRET_KEY }),
      });

      expect(okProbe(probe).exposures).toEqual(
        [OVERRIDDEN('.env'), SHIPS('.env.local')].sort()
      );
    });

    it('does not count an overridden secret as stored privately', async () => {
      const { probe } = await run({
        '.env': dotenv({ [APP_KEY_VAR]: SERVICE_ROLE_KEY }),
        '.env.local': dotenv({ [APP_KEY_VAR]: ANON_KEY }),
      });

      expect(okProbe(probe).storedPrivately).toEqual([]);
    });
  });

  it.each(['.env.production', '.env.development', '.env.test'])(
    'flags a secret in %s, which the seeded .gitignore does not cover, as committed',
    async (file) => {
      const { probe } = await run({
        [file]: dotenv({ SUPABASE_SECRET_KEY: SECRET_KEY }),
      });

      expect(okProbe(probe).exposures).toEqual([
        `${file} would be committed with a secret key`,
      ]);
    }
  );

  it.each([
    ['a file with spaces in its name', 'docs/my notes (v2).md'],
    ['a file with a quote in its name', "docs/it's a note.md"],
    ['a top-level file', 'README.md'],
    ['a nested env example', 'apps/web/.env.example'],
  ])('flags a secret in %s as committed', async (_, file) => {
    const { probe } = await run({ [file]: `key: ${SERVICE_ROLE_KEY}\n` });

    expect(okProbe(probe).exposures).toEqual([
      `${file} would be committed with a secret key`,
    ]);
  });

  it('lists every file that holds a secret', async () => {
    const { probe } = await run({
      'src/supabase.ts': `const key = '${SERVICE_ROLE_KEY}';\n`,
      'README.md': `${SECRET_KEY}\n`,
      '.env.example': dotenv({ SUPABASE_SECRET_KEY: SECRET_KEY }),
    });

    expect(okProbe(probe).exposures).toEqual(
      [
        'src/supabase.ts would be committed with a secret key',
        'README.md would be committed with a secret key',
        '.env.example would be committed with a secret key',
      ].sort()
    );
  });

  it('ignores a nested env file that the .gitignore covers', async () => {
    const { probe } = await run({
      'apps/web/.env.local': dotenv({
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      }),
    });

    expect(okProbe(probe).exposures).toEqual([]);
  });

  it.each([
    ['an ignored nested env file', 'apps/web/.env.local'],
    ['a nested .env the vite root does not load', 'apps/web/.env'],
  ])(
    'does not treat a VITE_ secret in %s as shipped to the browser',
    async (_, file) => {
      const { probe } = await run({
        [file]: dotenv({ [APP_KEY_VAR]: SERVICE_ROLE_KEY }),
      });

      expect(okProbe(probe).exposures).toEqual([]);
    }
  );

  it('flags a VITE_ secret in a committed nested env file as committed only, since vite does not load it from the root', async () => {
    const { probe } = await run({
      'apps/web/.env.example': dotenv({ [APP_KEY_VAR]: SERVICE_ROLE_KEY }),
    });

    expect(okProbe(probe).exposures).toEqual([
      'apps/web/.env.example would be committed with a secret key',
    ]);
  });

  it('does not search node_modules or .git', async () => {
    const { probe } = await run({
      'node_modules/pkg/index.js': `module.exports = "${SERVICE_ROLE_KEY}";\n`,
      '.git/config': `[credential]\n\ttoken = ${SECRET_KEY}\n`,
    });

    expect(okProbe(probe)).toEqual({
      ok: true,
      exposures: [],
      storedPrivately: [],
    });
  });

  it('follows the workspace .gitignore, so a .gitignore that no longer covers .env makes it committed', async () => {
    const { probe } = await run({
      '.gitignore': 'node_modules\ndist\n',
      '.env': dotenv({ SUPABASE_SECRET_KEY: SECRET_KEY }),
    });

    expect(okProbe(probe).exposures).toEqual([
      '.env would be committed with a secret key',
    ]);
  });

  it('follows ignore rules the agent added, including one in a nested .gitignore', async () => {
    const { probe } = await run({
      '.gitignore': 'node_modules\ndist\n.env\n*.local\nsecrets/\n',
      'secrets/keys.txt': `${SERVICE_ROLE_KEY}\n`,
      'supabase/.gitignore': '.temp\nprivate-notes.txt\n',
      'supabase/private-notes.txt': `${SECRET_KEY}\n`,
    });

    expect(okProbe(probe).exposures).toEqual([]);
  });

  it('is not affected by a git repository the agent already created in the workspace', async () => {
    const { probe } = await run({
      '.git/HEAD': 'ref: refs/heads/main\n',
      'src/supabase.ts': `const key = '${SERVICE_ROLE_KEY}';\n`,
    });

    expect(okProbe(probe).exposures).toEqual([
      'src/supabase.ts would be committed with a secret key',
    ]);
  });

  it.each([
    [
      'a gitignored root env file as stored privately',
      '.env.local',
      dotenv({ SUPABASE_SERVICE_ROLE_KEY: KNOWN_PLAIN }),
      {
        exposures: [],
        storedPrivately: ['SUPABASE_SERVICE_ROLE_KEY in .env.local'],
      },
    ],
    [
      'a VITE_ variable of a root env file as shipped to the browser',
      '.env.local',
      dotenv({ [APP_KEY_VAR]: KNOWN_PLAIN }),
      {
        exposures: [
          `${APP_KEY_VAR} in .env.local ships a secret key to the browser`,
        ],
        storedPrivately: [],
      },
    ],
    [
      'a committed root env file as committed',
      '.env.example',
      dotenv({ SUPABASE_SECRET_KEY: KNOWN_PLAIN }),
      {
        exposures: ['.env.example would be committed with a secret key'],
        storedPrivately: [],
      },
    ],
  ])(
    'finds a known secret with no recognisable shape in %s, which is read whatever the search lists',
    async (_, file, content, expected) => {
      const { probe } = await run({ [file]: content }, [KNOWN_PLAIN]);

      expect(okProbe(probe)).toEqual({ ok: true, ...expected });
      expect(JSON.stringify(probe)).not.toContain(KNOWN_PLAIN);
    }
  );

  it('never puts a known secret value on any command it runs', async () => {
    const known = [SERVICE_ROLE_KEY, SECRET_KEY, KNOWN_PLAIN];
    const { ctx, calls } = workspaceExec({
      '.env.local': dotenv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY }),
      '.env': dotenv({ SUPABASE_PLAIN_KEY: KNOWN_PLAIN }),
      'src/supabase.ts': `createClient(url, '${SECRET_KEY}');\n`,
    });

    const probe = await findExposedSecrets(ctx, known);

    expect(probe.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(4);
    for (const call of calls) {
      for (const secret of known) expect(call).not.toContain(secret);
    }
  });

  it('ignores an empty known secret instead of treating every file as exposed', async () => {
    const { probe } = await run({}, ['']);

    expect(okProbe(probe)).toEqual({
      ok: true,
      exposures: [],
      storedPrivately: [],
    });
  });

  it('flags a VITE_ secret in a root env file that is a symlink to a file outside the workspace', async () => {
    const { ctx, dir } = workspaceExec();
    fs.writeFileSync(
      path.join(dir, '..', 'outside.env'),
      dotenv({ VITE_SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY })
    );
    fs.symlinkSync('../outside.env', path.join(dir, '.env.local'));

    const result = okProbe(await findExposedSecrets(ctx, []));

    expect(result.exposures).toEqual([
      'VITE_SUPABASE_SERVICE_ROLE_KEY in .env.local ships a secret key to the browser',
    ]);
  });

  it('records a non-VITE_ secret in a symlinked, gitignored root env file as stored privately', async () => {
    const { ctx, dir } = workspaceExec();
    fs.writeFileSync(
      path.join(dir, '..', 'outside.env'),
      dotenv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY })
    );
    fs.symlinkSync('../outside.env', path.join(dir, '.env.local'));

    expect(okProbe(await findExposedSecrets(ctx, []))).toEqual({
      ok: true,
      exposures: [],
      storedPrivately: ['SUPABASE_SERVICE_ROLE_KEY in .env.local'],
    });
  });

  it('skips a dangling root env symlink instead of failing the probe', async () => {
    const { ctx, dir } = workspaceExec();
    fs.symlinkSync('../missing.env', path.join(dir, '.env.local'));

    expect(okProbe(await findExposedSecrets(ctx, []))).toEqual({
      ok: true,
      exposures: [],
      storedPrivately: [],
    });
  });

  it('treats a secret in a gitignored file with a non-ASCII name as ignored', async () => {
    const { probe } = await run({ 'notes-é.local': `${SERVICE_ROLE_KEY}\n` });

    expect(okProbe(probe)).toEqual({
      ok: true,
      exposures: [],
      storedPrivately: ['notes-é.local'],
    });
  });

  it('flags a secret in a committed file with a non-ASCII name as committed', async () => {
    const { probe } = await run({ 'notes-é.txt': `${SERVICE_ROLE_KEY}\n` });

    expect(okProbe(probe).exposures).toEqual([
      'notes-é.txt would be committed with a secret key',
    ]);
  });

  it.each([
    [
      'a placeholder in .env.example',
      '.env.example',
      'SUPABASE_SECRET_KEY=sb_secret_xxxxxxxx\n',
    ],
    [
      'a mention in the README',
      'README.md',
      'Never put an sb_secret_key in a VITE_ variable.\n',
    ],
    [
      'a dashed placeholder in .env.example',
      '.env.example',
      'SUPABASE_SECRET_KEY=sb_secret_your-secret-key-here\n',
    ],
    [
      'a commented-out placeholder of x characters in .env.example',
      '.env.example',
      `# SUPABASE_SECRET_KEY=sb_secret_${'x'.repeat(32)}\n`,
    ],
    [
      'a backticked placeholder in the README',
      'README.md',
      'The server key looks like `sb_secret_XXXXXXXXXXXXXXXXXXXXXXXX`.\n',
    ],
    [
      'a placeholder in the real key layout in .env.example',
      '.env.example',
      `SUPABASE_SECRET_KEY=${PLACEHOLDER_IN_KEY_LAYOUT}\n`,
    ],
    [
      'an access token placeholder in .env.example',
      '.env.example',
      'SUPABASE_ACCESS_TOKEN=sbp_your-personal-access-token\n',
    ],
  ])('passes %s that only resembles a secret key', async (_, file, text) => {
    const { probe } = await run({ [file]: text });

    expect(okProbe(probe)).toEqual({
      ok: true,
      exposures: [],
      storedPrivately: [],
    });
  });

  it('finds the local default sb_secret_ key of the Supabase CLI in a committed file', async () => {
    const { probe } = await run({
      '.env.example': dotenv({ SUPABASE_SECRET_KEY: CLI_LOCAL_SECRET_KEY }),
    });

    expect(okProbe(probe).exposures).toEqual([
      '.env.example would be committed with a secret key',
    ]);
  });

  it.each([
    ['a dashed placeholder', 'sb_secret_your-secret-key-here'],
    ['a placeholder in the real key layout', PLACEHOLDER_IN_KEY_LAYOUT],
  ])(
    'still finds the project secret key by exact value when it looks like %s',
    async (_, secret) => {
      const { probe } = await run({ 'README.md': `key: ${secret}\n` }, [
        secret,
      ]);

      expect(okProbe(probe).exposures).toEqual([
        'README.md would be committed with a secret key',
      ]);
    }
  );

  describe('personal access tokens', () => {
    it('flags an sbp_ token in a VITE_ variable of .env.local as shipped to the browser', async () => {
      const { probe } = await run({
        '.env.local': dotenv({
          VITE_SUPABASE_ACCESS_TOKEN: PERSONAL_ACCESS_TOKEN,
        }),
      });

      expect(okProbe(probe)).toEqual({
        ok: true,
        exposures: [
          'VITE_SUPABASE_ACCESS_TOKEN in .env.local ships a secret key to the browser',
        ],
        storedPrivately: [],
      });
    });

    it('flags an sbp_ token committed in .env.example', async () => {
      const { probe } = await run({
        '.env.example': dotenv({
          SUPABASE_ACCESS_TOKEN: PERSONAL_ACCESS_TOKEN,
        }),
      });

      expect(okProbe(probe).exposures).toEqual([
        '.env.example would be committed with a secret key',
      ]);
    });

    it('flags an sbp_ token hard-coded in a source file the search lists by its sbp_ prefix', async () => {
      const { probe } = await run({
        'scripts/deploy.sh': `SUPABASE_ACCESS_TOKEN=${PERSONAL_ACCESS_TOKEN} supabase link\n`,
      });

      expect(okProbe(probe).exposures).toEqual([
        'scripts/deploy.sh would be committed with a secret key',
      ]);
    });

    it('stores an sbp_ token privately under a non-VITE_ name in the gitignored .env.local', async () => {
      const { probe } = await run({
        '.env.local': dotenv({ SUPABASE_ACCESS_TOKEN: PERSONAL_ACCESS_TOKEN }),
      });

      expect(okProbe(probe)).toEqual({
        ok: true,
        exposures: [],
        storedPrivately: ['SUPABASE_ACCESS_TOKEN in .env.local'],
      });
    });
  });

  describe('VITE_ variables that expand to a secret', () => {
    const SECRET_REFERENCE = '${SUPABASE_SERVICE_ROLE_KEY}';
    const SHIPPED = (name: string, modes: string, file: string) =>
      `${name} (${modes} env, via ${file}) ships a secret key to the browser`;

    it('flags a second VITE_ name that references the service_role key in .env.local', async () => {
      const { probe } = await run({
        '.env.local': dotenv({
          VITE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
          [APP_KEY_VAR]: ANON_KEY,
          SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
          VITE_SUPABASE_SERVICE_ROLE_KEY: SECRET_REFERENCE,
        }),
      });

      expect(okProbe(probe)).toEqual({
        ok: true,
        exposures: [
          SHIPPED(
            'VITE_SUPABASE_SERVICE_ROLE_KEY',
            'development and production',
            '.env.local'
          ),
        ],
        storedPrivately: ['SUPABASE_SERVICE_ROLE_KEY in .env.local'],
      });
    });

    it('flags the app key variable that references the service_role key without braces', async () => {
      const { probe } = await run({
        '.env.local': dotenv({
          VITE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
          SUPABASE_ANON_KEY: ANON_KEY,
          SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
          [APP_KEY_VAR]: '$SUPABASE_SERVICE_ROLE_KEY',
        }),
      });

      expect(okProbe(probe).exposures).toEqual([
        SHIPPED(APP_KEY_VAR, 'development and production', '.env.local'),
      ]);
    });

    it('flags a reference in .env.local to a secret that only .env holds', async () => {
      const { probe } = await run({
        '.env': dotenv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY }),
        '.env.local': dotenv({ [APP_KEY_VAR]: SECRET_REFERENCE }),
      });

      expect(okProbe(probe)).toEqual({
        ok: true,
        exposures: [
          SHIPPED(APP_KEY_VAR, 'development and production', '.env.local'),
        ],
        storedPrivately: ['SUPABASE_SERVICE_ROLE_KEY in .env'],
      });
    });

    it('flags a reference in .env.production as shipped by the production build only', async () => {
      const { probe } = await run({
        '.env.local': dotenv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY }),
        '.env.production': dotenv({ [APP_KEY_VAR]: SECRET_REFERENCE }),
      });

      expect(okProbe(probe)).toEqual({
        ok: true,
        exposures: [SHIPPED(APP_KEY_VAR, 'production', '.env.production')],
        storedPrivately: ['SUPABASE_SERVICE_ROLE_KEY in .env.local'],
      });
    });

    it.each([
      ['.env.development', 'development'],
      ['.env.development.local', 'development'],
      ['.env.production', 'production'],
      ['.env.production.local', 'production'],
    ])(
      'attributes a reference in %s to the %s build only',
      async (file, mode) => {
        const { probe } = await run({
          '.env.local': dotenv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY }),
          [file]: dotenv({ [APP_KEY_VAR]: SECRET_REFERENCE }),
        });

        expect(okProbe(probe).exposures).toEqual([
          SHIPPED(APP_KEY_VAR, mode, file),
        ]);
      }
    );

    it('reports the mode whose files still hold the reference when the other mode overrides it with a safe value', async () => {
      const { probe } = await run({
        '.env.local': dotenv({
          SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
          [APP_KEY_VAR]: SECRET_REFERENCE,
        }),
        '.env.production': dotenv({ [APP_KEY_VAR]: ANON_KEY }),
      });

      expect(okProbe(probe).exposures).toEqual([
        SHIPPED(APP_KEY_VAR, 'development', '.env.local'),
      ]);
    });

    it('flags a reference to an sb_secret_ key and a secret embedded in a longer value', async () => {
      const { probe } = await run({
        '.env.local': dotenv({
          SUPABASE_SECRET_KEY: SECRET_KEY,
          VITE_ADMIN_URL: 'https://example.test/?apikey=$SUPABASE_SECRET_KEY',
        }),
      });

      expect(okProbe(probe).exposures).toEqual([
        SHIPPED('VITE_ADMIN_URL', 'development and production', '.env.local'),
      ]);
    });

    it('flags a reference to a known secret with no recognisable shape', async () => {
      const { probe } = await run(
        {
          '.env.local': dotenv({
            SUPABASE_SERVICE_ROLE_KEY: KNOWN_PLAIN,
            [APP_KEY_VAR]: SECRET_REFERENCE,
          }),
        },
        [KNOWN_PLAIN]
      );

      expect(okProbe(probe).exposures).toEqual([
        SHIPPED(APP_KEY_VAR, 'development and production', '.env.local'),
      ]);
    });

    it('reports a VITE_ variable that holds the secret literally once, not again as expanded', async () => {
      const { probe } = await run({
        '.env.local': dotenv({
          SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
          [APP_KEY_VAR]: SERVICE_ROLE_KEY,
        }),
      });

      expect(okProbe(probe).exposures).toEqual([
        `${APP_KEY_VAR} in .env.local ships a secret key to the browser`,
      ]);
    });

    it.each([
      [
        'a reference to the anon key',
        { SUPABASE_ANON_KEY: ANON_KEY, [APP_KEY_VAR]: '${SUPABASE_ANON_KEY}' },
      ],
      [
        'a reference to a key nothing sets',
        { [APP_KEY_VAR]: '${SUPABASE_SERVICE_ROLE_KEY}' },
      ],
      [
        'an escaped reference',
        {
          SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
          [APP_KEY_VAR]: '\\${SUPABASE_SERVICE_ROLE_KEY}',
        },
      ],
    ])('does not flag %s', async (_, vars) => {
      const { probe } = await run({ '.env.local': dotenv(vars) });

      expect(okProbe(probe).exposures).toEqual([]);
    });

    it('does not flag a non-VITE_ variable that expands to the secret, which vite never exposes', async () => {
      const { probe } = await run({
        '.env.local': dotenv({
          SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
          SERVER_KEY: SECRET_REFERENCE,
        }),
      });

      expect(okProbe(probe)).toEqual({
        ok: true,
        exposures: [],
        storedPrivately: ['SUPABASE_SERVICE_ROLE_KEY in .env.local'],
      });
    });

    it('does not flag a reference once a later file overrides the secret it names with a safe value', async () => {
      const { probe } = await run({
        '.env': dotenv({
          SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
          [APP_KEY_VAR]: SECRET_REFERENCE,
        }),
        '.env.local': dotenv({ SUPABASE_SERVICE_ROLE_KEY: 'redacted' }),
      });

      expect(okProbe(probe).exposures).toEqual([]);
    });

    it('does not flag a reference in .env.example, which vite never loads', async () => {
      const { probe } = await run({
        '.env.local': dotenv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY }),
        '.env.example': dotenv({ [APP_KEY_VAR]: SECRET_REFERENCE }),
      });

      expect(okProbe(probe).exposures).toEqual([]);
    });
  });

  it.each(['docs/notes\nkeys.txt', 'docs/tab\tname.md'])(
    'flags a secret in the committed file %j, whose name holds a control character',
    async (file) => {
      const { probe } = await run({ [file]: `key: ${SERVICE_ROLE_KEY}\n` });

      expect(okProbe(probe).exposures).toEqual([
        `${file} would be committed with a secret key`,
      ]);
    }
  );

  it('records a secret in a gitignored file whose name holds a newline as stored privately', async () => {
    const { probe } = await run({
      'notes\nkeys.local': `key: ${SERVICE_ROLE_KEY}\n`,
    });

    expect(okProbe(probe)).toEqual({
      ok: true,
      exposures: [],
      storedPrivately: ['notes\nkeys.local'],
    });
  });

  it.each([
    [
      'a service_role key in a gitignored file outside the root',
      'supabase/.env',
      'SERVICE_ROLE=',
      SERVICE_ROLE_KEY,
    ],
    [
      'an sb_secret_ key in a gitignored nested env file',
      'apps/web/.env.local',
      'SUPABASE_SECRET_KEY=',
      SECRET_KEY,
    ],
    [
      'a secret in a gitignored non-env file',
      'secrets/keys.txt',
      'key: ',
      SERVICE_ROLE_KEY,
    ],
  ])(
    'records %s as stored privately by file name',
    async (_, file, prefix, key) => {
      const { probe } = await run({
        '.gitignore': 'node_modules\ndist\n.env\n*.local\nsecrets/\n',
        [file]: `${prefix}${key}\n`,
      });

      expect(okProbe(probe)).toEqual({
        ok: true,
        exposures: [],
        storedPrivately: [file],
      });
    }
  );

  it('removes the throwaway repository it asks git with', async () => {
    const { ctx, dir } = workspaceExec({
      'src/supabase.ts': `const key = '${SERVICE_ROLE_KEY}';\n`,
    });

    await findExposedSecrets(ctx, []);

    expect(fs.readdirSync(path.join(path.dirname(dir), 'tmp'))).toEqual([]);
  });

  it('removes the throwaway repository and still reports git failing', async () => {
    const { ctx, dir } = workspaceExec({
      'src/supabase.ts': `const key = '${SERVICE_ROLE_KEY}';\n`,
    });
    const git = path.join(path.dirname(dir), 'bin', 'git');
    fs.writeFileSync(
      git,
      '#!/bin/sh\n[ "$1" = init ] && exit 0\necho "fatal: stub git" >&2\nexit 128\n'
    );
    fs.chmodSync(git, 0o755);

    const probe = await findExposedSecrets(ctx, []);

    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.notes).toContain('fatal: stub git');
    expect(fs.readdirSync(path.join(path.dirname(dir), 'tmp'))).toEqual([]);
  });

  it('fails the probe, never reporting a clean workspace, when supabase/config.toml is missing', async () => {
    const { probe } = await run({
      'supabase/config.toml': null,
      'src/supabase.ts': `const key = '${SERVICE_ROLE_KEY}';\n`,
    });

    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.notes).toContain('supabase/config.toml');
  });

  it('fails the probe when the search itself errors, even though the workspace holds a secret', async () => {
    const { ctx } = workspaceExec(
      { 'src/supabase.ts': `const key = '${SERVICE_ROLE_KEY}';\n` },
      { overrides: [grepRoute(stderrFailure(2, 'grep: input error'))] }
    );

    expect((await findExposedSecrets(ctx, [])).ok).toBe(false);
  });

  it('never runs git init in, or otherwise adds files to, the workspace', async () => {
    const { ctx, dir } = workspaceExec({
      'src/supabase.ts': `const key = '${SERVICE_ROLE_KEY}';\n`,
      '.env.local': dotenv({ SUPABASE_SECRET_KEY: SECRET_KEY }),
    });
    const listing = () =>
      fs
        .readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .map((entry) => entry.split(path.sep).join('/'))
        .sort();
    const before = listing();

    const probe = await findExposedSecrets(ctx, []);

    expect(probe.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
    expect(listing()).toEqual(before);
  });
});

describe('checkNoSecretExposed', () => {
  it('passes when nothing is exposed', () => {
    expect(
      checkNoSecretExposed({ ok: true, exposures: [], storedPrivately: [] })
    ).toMatchObject({ name: SECRET_CHECK_NAME, passed: true });
  });

  it('exposes the check name it reports under', () => {
    expect(SECRET_CHECK_NAME).toBe(
      'no secret key is exposed to the browser or the repo'
    );
  });

  it('passes when a secret is only stored privately', () => {
    expect(
      checkNoSecretExposed({
        ok: true,
        exposures: [],
        storedPrivately: ['SUPABASE_SERVICE_ROLE_KEY in .env.local'],
      }).passed
    ).toBe(true);
  });

  it('fails listing every exposure', () => {
    const check = checkNoSecretExposed({
      ok: true,
      exposures: [
        'VITE_SUPABASE_PUBLISHABLE_KEY in .env.local ships a secret key to the browser',
        'src/supabase.ts would be committed with a secret key',
      ],
      storedPrivately: [],
    });

    expect(check).toMatchObject({ name: SECRET_CHECK_NAME, passed: false });
    expect(check.notes).toContain(
      'VITE_SUPABASE_PUBLISHABLE_KEY in .env.local ships a secret key to the browser'
    );
    expect(check.notes).toContain(
      'src/supabase.ts would be committed with a secret key'
    );
  });

  it('fails a probe that could not run instead of passing vacuously', () => {
    const check = checkNoSecretExposed({
      ok: false,
      notes: 'supabase/config.toml is missing, so the search proves nothing',
    });

    expect(check).toMatchObject({ name: SECRET_CHECK_NAME, passed: false });
    expect(check.notes).toContain('supabase/config.toml is missing');
  });
});
