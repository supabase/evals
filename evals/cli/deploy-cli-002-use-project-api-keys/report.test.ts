// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-cli-002-use-project-api-keys
import { describe, expect, it } from 'vitest';
import type { AppSource } from './app-source.js';
import {
  ANON_KEY,
  APP_KEY_VAR,
  APP_URL_VAR,
  appEnv,
  CLEAN_SECRETS,
  ENV_FAILED,
  expectNoKeyValues,
  HOSTED_ABSENT,
  HOSTED_OK,
  HOSTED_REF,
  LOCAL_ANON_KEY,
  LOCAL_URL,
  NO_ENV,
  OTHER_REF,
  PLACEHOLDER_KEY,
  PROJECT_URL,
  PUBLISHABLE_KEY,
  SECRET_KEY,
  SERVICE_ROLE_KEY,
} from './fixtures.js';
import { describeGroundTruth } from './report.js';

type Facts = Parameters<typeof describeGroundTruth>[0];

const READS_BOTH: AppSource = { ok: true, missing: [] };

const HEALTHY: Facts = {
  hosted: HOSTED_OK,
  env: appEnv({ [APP_URL_VAR]: PROJECT_URL, [APP_KEY_VAR]: ANON_KEY }),
  source: READS_BOTH,
  secrets: CLEAN_SECRETS,
  tokenInEnvironment: true,
};

const describe_ = (overrides: Partial<Facts> = {}) =>
  describeGroundTruth({ ...HEALTHY, ...overrides });

const linesFor = (lines: readonly string[], pattern: RegExp) =>
  lines.filter((line) => pattern.test(line)).join('\n');

const urlLine = (lines: readonly string[]) =>
  linesFor(lines, new RegExp(APP_URL_VAR));
const keyLine = (lines: readonly string[]) =>
  linesFor(lines, new RegExp(APP_KEY_VAR));
const tokenLine = (lines: readonly string[]) =>
  linesFor(lines, /SUPABASE_ACCESS_TOKEN/);

const YES = /\byes\b/i;
const NO = /\bno\b/i;

describe('describeGroundTruth', () => {
  it('returns one string per line, with no line holding a newline', () => {
    const lines = describe_();

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain('\n');
  });

  describe('hosted project', () => {
    it('names the ref when a hosted project is available', () => {
      const lines = describe_();

      expect(linesFor(lines, /hosted project/i)).toContain(HOSTED_REF);
    });

    it('says there is none, and why, when no hosted project is available', () => {
      const text = describe_({ hosted: HOSTED_ABSENT }).join('\n');

      expect(text).toContain('CLI-2754');
      expect(linesFor(text.split('\n'), /hosted project/i)).toMatch(/none/i);
    });
  });

  describe('access token', () => {
    it.each([
      [true, YES, NO],
      [false, NO, YES],
    ])(
      'reports tokenInEnvironment=%s on the SUPABASE_ACCESS_TOKEN line',
      (value, expected, unexpected) => {
        const line = tokenLine(describe_({ tokenInEnvironment: value }));

        expect(line).toMatch(expected);
        expect(line).not.toMatch(unexpected);
      }
    );

    it('says unknown for a token the harness could not probe', () => {
      expect(tokenLine(describe_({ tokenInEnvironment: null }))).toMatch(
        /unknown/i
      );
    });
  });

  describe('env files', () => {
    it('lists the env files that exist', () => {
      const lines = describe_({
        env: appEnv({
          [APP_URL_VAR]: [PROJECT_URL, '.env'],
          [APP_KEY_VAR]: [ANON_KEY, '.env.development.local'],
        }),
      });

      const line = linesFor(lines, /env files/i);
      expect(line).toContain('.env');
      expect(line).toContain('.env.development.local');
    });

    it('says none when no env file exists', () => {
      expect(linesFor(describe_({ env: NO_ENV }), /env files/i)).toMatch(
        /none/i
      );
    });

    it('carries the reason the env files could not be read', () => {
      expect(describe_({ env: ENV_FAILED }).join('\n')).toContain(
        'Permission denied'
      );
    });
  });

  describe('app URL', () => {
    it('shows the host and says it is our project when it is', () => {
      const line = urlLine(describe_());

      expect(line).toContain(`${HOSTED_REF}.supabase.co`);
      expect(line).toMatch(YES);
      expect(line).not.toMatch(NO);
    });

    it.each([
      ['the local stack', LOCAL_URL, '127.0.0.1'],
      [
        'another project',
        `https://${OTHER_REF}.supabase.co`,
        `${OTHER_REF}.supabase.co`,
      ],
      [
        'the project REST path',
        `${PROJECT_URL}/rest/v1`,
        `${HOSTED_REF}.supabase.co`,
      ],
    ])(
      'shows the host and says it is not our project for %s',
      (_, value, host) => {
        const line = urlLine(
          describe_({ env: appEnv({ [APP_URL_VAR]: value }) })
        );

        expect(line).toContain(host);
        expect(line).toMatch(NO);
        expect(line).not.toMatch(YES);
      }
    );

    it('shows the host and says it is not our project for the ref on a lookalike domain', () => {
      const line = urlLine(
        describe_({
          env: appEnv({ [APP_URL_VAR]: `https://${HOSTED_REF}.supabase.cx` }),
        })
      );

      expect(line).toContain(`${HOSTED_REF}.supabase.cx`);
      expect(line).toMatch(NO);
      expect(line).not.toMatch(YES);
    });

    it('says it is unset when no file sets it', () => {
      expect(urlLine(describe_({ env: NO_ENV }))).toMatch(/unset/i);
    });

    it('never says the URL is our project when there is no hosted project to compare against', () => {
      const line = urlLine(describe_({ hosted: HOSTED_ABSENT }));

      expect(line).toContain(`${HOSTED_REF}.supabase.co`);
      expect(line).not.toMatch(YES);
    });
  });

  describe('app key', () => {
    it.each([
      ['unset', NO_ENV, 'unset'],
      [
        'the project client key',
        appEnv({ [APP_KEY_VAR]: PUBLISHABLE_KEY }),
        'client',
      ],
      [
        'the service_role key',
        appEnv({ [APP_KEY_VAR]: SERVICE_ROLE_KEY }),
        'secret',
      ],
      ['the sb_secret_ key', appEnv({ [APP_KEY_VAR]: SECRET_KEY }), 'secret'],
      ['a local stack key', appEnv({ [APP_KEY_VAR]: LOCAL_ANON_KEY }), 'other'],
      ['a placeholder', appEnv({ [APP_KEY_VAR]: PLACEHOLDER_KEY }), 'other'],
    ])('states the kind of a config that holds %s as "%s"', (_, env, kind) => {
      expect(keyLine(describe_({ env }))).toMatch(
        new RegExp(`\\b${kind}\\b`, 'i')
      );
    });

    it('says unknown, not client or other, when there is no hosted project to verify the key against', () => {
      const line = keyLine(describe_({ hosted: HOSTED_ABSENT }));

      expect(line).toContain('unknown (no hosted project to compare against)');
      expect(line).not.toMatch(/\bclient\b|\bother\b/i);
    });

    it.each([
      ['the service_role key', SERVICE_ROLE_KEY],
      ['the sb_secret_ key', SECRET_KEY],
    ])(
      'still calls %s a secret key when there is no hosted project',
      (_, value) => {
        const line = keyLine(
          describe_({
            hosted: HOSTED_ABSENT,
            env: appEnv({ [APP_KEY_VAR]: value }),
          })
        );

        expect(line).toMatch(/\bsecret key\b/i);
        expect(line).not.toMatch(/unknown/i);
      }
    );

    it('still says unset when there is no hosted project and no key', () => {
      expect(
        keyLine(describe_({ hosted: HOSTED_ABSENT, env: NO_ENV }))
      ).toMatch(/unset/i);
    });
  });

  describe('app source', () => {
    const sourceText = (source: AppSource) => describe_({ source }).join('\n');
    const unreadLines = (source: AppSource) =>
      describe_({ source }).filter((line) => /no longer reads/.test(line));

    it('says the app reads both variables when none is missing', () => {
      const text = sourceText(READS_BOTH);

      expect(text).toMatch(/reads both/i);
      expect(text).not.toContain('no longer reads');
      expect(text).not.toMatch(/could not be read/i);
    });

    it.each([
      ['the URL variable', [APP_URL_VAR], APP_KEY_VAR],
      ['the key variable', [APP_KEY_VAR], APP_URL_VAR],
    ])(
      'names only the variable the source no longer reads when %s is missing',
      (_, missing, present) => {
        const source: AppSource = { ok: true, missing };

        const lines = unreadLines(source);

        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(missing[0]);
        expect(lines[0]).not.toContain(present);
        expect(sourceText(source)).not.toMatch(/reads both/i);
      }
    );

    it('names both variables on one line when the source reads neither', () => {
      const lines = unreadLines({
        ok: true,
        missing: [APP_URL_VAR, APP_KEY_VAR],
      });

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(APP_URL_VAR);
      expect(lines[0]).toContain(APP_KEY_VAR);
    });

    it('says the source could not be read, and why, instead of claiming a variable is unread', () => {
      const text = sourceText({
        ok: false,
        notes: 'exit 2: grep: src: Permission denied',
      });

      expect(text).toMatch(/could not be read/i);
      expect(text).toContain('Permission denied');
      expect(text).not.toContain('no longer reads');
      expect(text).not.toMatch(/reads both/i);
    });
  });

  describe('secret exposure', () => {
    it('lists every exposure by its description', () => {
      const exposures = [
        `${APP_KEY_VAR} in .env.local ships a secret key to the browser`,
        'src/supabase.ts would be committed with a secret key',
      ];

      const text = describe_({
        secrets: { ok: true, exposures, storedPrivately: [] },
      }).join('\n');

      for (const exposure of exposures) expect(text).toContain(exposure);
    });

    it('carries the wording of a VITE_ secret that no mode ships without saying it ships', () => {
      const exposures = [
        `${APP_KEY_VAR} in .env holds a secret key (overridden, so not currently shipped)`,
        `${APP_KEY_VAR} in .env.example holds a secret key (Vite doesn't load this file in dev or production)`,
      ];

      const text = describe_({
        secrets: { ok: true, exposures, storedPrivately: [] },
      }).join('\n');

      for (const exposure of exposures) {
        expect(text).toContain(`- secret key exposure: ${exposure}`);
      }
      expect(text).not.toContain('ships a secret key');
    });

    it('lists secrets stored privately', () => {
      const text = describe_({
        secrets: {
          ok: true,
          exposures: [],
          storedPrivately: ['SUPABASE_SERVICE_ROLE_KEY in .env.local'],
        },
      }).join('\n');

      expect(text).toContain('SUPABASE_SERVICE_ROLE_KEY in .env.local');
    });

    it('does not claim any exposure when the search found none', () => {
      const text = describe_().join('\n');

      expect(text).not.toMatch(/ships a secret key|would be committed/);
    });

    it('carries the reason the search could not run instead of implying nothing was found', () => {
      const text = describe_({
        secrets: {
          ok: false,
          notes:
            'supabase/config.toml is missing, so the search proves nothing',
        },
      }).join('\n');

      expect(text).toContain('supabase/config.toml is missing');
    });
  });

  describe('key values', () => {
    it('never include a key value, whatever the config and the hosted project hold', () => {
      const lines = describe_({
        env: appEnv({
          [APP_URL_VAR]: `${PROJECT_URL}/rest/v1?apikey=${SERVICE_ROLE_KEY}`,
          [APP_KEY_VAR]: SERVICE_ROLE_KEY,
          SUPABASE_SECRET_KEY: SECRET_KEY,
        }),
        secrets: {
          ok: true,
          exposures: [
            `${APP_KEY_VAR} in .env.local ships a secret key to the browser`,
          ],
          storedPrivately: ['SUPABASE_SECRET_KEY in .env.local'],
        },
      });

      expectNoKeyValues(lines.join('\n'));
    });

    it.each([
      ['reads both variables', READS_BOTH],
      [
        'no longer reads a variable',
        { ok: true, missing: [APP_URL_VAR, APP_KEY_VAR] },
      ],
      ['could not be read', { ok: false, notes: 'exit 2: grep: src: failed' }],
    ] satisfies [string, AppSource][])(
      'never include a key value when the source %s',
      (_, source) => {
        const lines = describe_({
          env: appEnv({
            [APP_URL_VAR]: PROJECT_URL,
            [APP_KEY_VAR]: SERVICE_ROLE_KEY,
          }),
          source,
        });

        expectNoKeyValues(lines.join('\n'));
      }
    );

    it.each([
      ['the anon key', ANON_KEY],
      ['the publishable key', PUBLISHABLE_KEY],
      ['a local stack key', LOCAL_ANON_KEY],
    ])('never include the value of a config that holds %s', (_, value) => {
      const text = describe_({ env: appEnv({ [APP_KEY_VAR]: value }) }).join(
        '\n'
      );

      expect(text).not.toContain(value);
    });
  });
});
