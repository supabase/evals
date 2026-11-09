// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-cli-002-use-project-api-keys
import fs from 'node:fs';
import path from 'node:path';
import type {
  JudgeInput,
  JudgeResult,
  LocalStackEvalContext,
  ManagementApiClient,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DETOUR_CHECK_NAME } from '../lib/detours.js';
import { APP_SOURCE_CHECK_NAME } from './app-source.js';
import { KEY_CHECK_NAME, URL_CHECK_NAME } from './config.js';
import scorer from './EVAL.js';
import {
  ANON_KEY,
  APP_KEY_VAR,
  APP_URL_VAR,
  type ApiKeyRow,
  catRoute,
  clientSource,
  crash,
  dotenv,
  expectNoKeyValues,
  FIXTURE_KEY_VALUES,
  fakeMgmt,
  HOSTED_REF,
  hostedContext,
  LEGACY_KEY_ROWS,
  LOCAL_ANON_KEY,
  LOCAL_URL,
  NEW_KEY_ROWS,
  OPAQUE_CLIENT_KEY,
  OPAQUE_SECRET_KEY,
  PLACEHOLDER_KEY,
  PROJECT_URL,
  PUBLISHABLE_KEY,
  removeWorkspaces,
  type Route,
  SECRET_KEY,
  SERVICE_ROLE_KEY,
  shellCall,
  stderrFailure,
  workspaceExec,
} from './fixtures.js';
import { HOSTED_CHECK_NAME } from './hosted.js';
import { SECRET_CHECK_NAME } from './secrets.js';

afterAll(removeWorkspaces);

const METRICS = 'metrics';
const REPORT = 'final report is truthful';

const CHECK_NAMES = [
  HOSTED_CHECK_NAME,
  URL_CHECK_NAME,
  KEY_CHECK_NAME,
  APP_SOURCE_CHECK_NAME,
  SECRET_CHECK_NAME,
  DETOUR_CHECK_NAME,
  METRICS,
  REPORT,
];

const SESSION = [
  shellCall('supabase projects list'),
  shellCall(`supabase projects api-keys --project-ref ${HOSTED_REF} -o env`),
  shellCall('cp .env.example .env.local'),
];

const HEALTHY_FILES = {
  '.env.local': dotenv({ [APP_URL_VAR]: PROJECT_URL, [APP_KEY_VAR]: ANON_KEY }),
};

const ACCESS_TOKEN = 'evals-fixture-access-token-do-not-use';

const secretSearchRoute = (respond: Route[1]): Route => [
  /\bgrep\b.*sb_secret_/,
  respond,
];

type JudgeKind = 'detours' | 'report';
type Verdict = JudgeResult | Error;

const judgeKind = ({ input }: JudgeInput): JudgeKind =>
  input.startsWith('Ground truth observed by the harness')
    ? 'report'
    : 'detours';

type FakeOptions = {
  noHosted?: boolean;
  rows?: ApiKeyRow[];
  mgmt?: ManagementApiClient;
  files?: Record<string, string | null>;
  env?: Record<string, string>;
  overrides?: Route[];
  toolCalls?: ToolCallRecord[];
  transcript?: TranscriptPart[];
  verdicts?: Partial<Record<JudgeKind, Verdict>>;
};

function fakeCtx(options: FakeOptions = {}) {
  const verdicts = options.verdicts ?? {};
  const judge = vi.fn(async (args: JudgeInput): Promise<JudgeResult> => {
    const verdict = verdicts[judgeKind(args)] ?? {
      passed: true,
      notes: 'judge ok',
    };
    if (verdict instanceof Error) throw verdict;
    return verdict;
  });
  const { ctx: execCtx, dir } = workspaceExec(options.files ?? HEALTHY_FILES, {
    env: { SUPABASE_ACCESS_TOKEN: ACCESS_TOKEN, ...options.env },
    overrides: options.overrides,
  });
  const hosted = options.noHosted
    ? {}
    : {
        hostedRef: HOSTED_REF,
        hostedMgmt: options.mgmt ?? hostedContext(options.rows).hostedMgmt,
      };
  const ctx = {
    ...hosted,
    exec: execCtx.exec,
    judge,
    toolCalls: options.toolCalls ?? SESSION,
    transcript: options.transcript ?? [],
    environmentMarker: async () => undefined,
  } as unknown as LocalStackEvalContext;
  return { ctx, judge, dir };
}

type Result = Awaited<ReturnType<typeof scorer>>;

const failedNames = (result: Result) =>
  (result.checks ?? []).filter(({ passed }) => !passed).map(({ name }) => name);

const checkNamed = (result: Result, name: string) =>
  (result.checks ?? []).find((check) => check.name === name);

const allNotes = (result: Result) =>
  (result.checks ?? [])
    .map((check) => [check.notes, check.judgeNotes].filter(Boolean).join('\n'))
    .join('\n');

const judgeCall = (
  judge: ReturnType<typeof fakeCtx>['judge'],
  kind: JudgeKind
) =>
  judge.mock.calls
    .map(([args]) => args)
    .find((args) => judgeKind(args) === kind);

describe('use-project-api-keys scorer', () => {
  it('passes a healthy hosted run with every check in the declared order', async () => {
    const { ctx, judge } = fakeCtx();

    const result = await scorer(ctx);

    expect(result.checks?.map(({ name }) => name)).toEqual([
      'a hosted project is available',
      "the app's config points at our project",
      "the app's config holds a client key for our project",
      'the app still reads its URL and key from that config',
      'no secret key is exposed to the browser or the repo',
      'no container-runtime detours',
      'metrics',
      'final report is truthful',
    ]);
    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  describe('valid ways to wire the app up', () => {
    it.each([
      [
        'the new publishable key in .env, with export, quotes, a trailing slash and CRLF',
        {
          rows: NEW_KEY_ROWS,
          files: {
            '.env': `export ${APP_URL_VAR}="${PROJECT_URL}/"\r\n${APP_KEY_VAR}='${PUBLISHABLE_KEY}' # from the dashboard\r\n`,
          },
        },
      ],
      [
        'a stale .env overridden by .env.development.local',
        {
          files: {
            '.env': dotenv({
              [APP_URL_VAR]: LOCAL_URL,
              [APP_KEY_VAR]: LOCAL_ANON_KEY,
            }),
            '.env.development.local': dotenv({
              [APP_URL_VAR]: PROJECT_URL,
              [APP_KEY_VAR]: ANON_KEY,
            }),
          },
        },
      ],
      [
        'the service_role key kept under another name in the gitignored .env.local',
        {
          files: {
            '.env.local': dotenv({
              [APP_URL_VAR]: PROJECT_URL,
              [APP_KEY_VAR]: ANON_KEY,
              SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
            }),
          },
        },
      ],
      [
        'an sb_secret_ key kept under another name in the gitignored .env',
        {
          rows: [...LEGACY_KEY_ROWS, ...NEW_KEY_ROWS],
          files: {
            '.env': dotenv({ SUPABASE_SECRET_KEY: SECRET_KEY }),
            '.env.local': dotenv({
              [APP_URL_VAR]: PROJECT_URL,
              [APP_KEY_VAR]: PUBLISHABLE_KEY,
            }),
          },
        },
      ],
      [
        'the legacy anon key on a project that also has publishable keys',
        { rows: [...LEGACY_KEY_ROWS, ...NEW_KEY_ROWS] },
      ],
    ] as [string, FakeOptions][])(
      'passes every check with %s',
      async (_, options) => {
        const { ctx } = fakeCtx(options);

        const result = await scorer(ctx);

        expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
        expect(result.passed).toBe(true);
      }
    );
  });

  describe('a run with no hosted project, as in CI until the staging org lands', () => {
    it('fails the hosted check naming CLI-2754 and still returns every later check without throwing', async () => {
      const { ctx } = fakeCtx({ noHosted: true, files: {} });

      const result = await scorer(ctx);

      expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
      expect(failedNames(result)).toEqual([
        HOSTED_CHECK_NAME,
        URL_CHECK_NAME,
        KEY_CHECK_NAME,
      ]);
      expect(checkNamed(result, HOSTED_CHECK_NAME)?.notes).toContain(
        'CLI-2754'
      );
      expect(checkNamed(result, METRICS)?.passed).toBe(true);
      expect(result.passed).toBe(false);
    });

    it('still fails the URL and key checks when the config holds what would be right for a hosted project', async () => {
      const { ctx } = fakeCtx({ noHosted: true });

      expect(failedNames(await scorer(ctx))).toEqual([
        HOSTED_CHECK_NAME,
        URL_CHECK_NAME,
        KEY_CHECK_NAME,
      ]);
    });

    it('still fails the secret check for a service_role key written into the app config', async () => {
      const { ctx } = fakeCtx({
        noHosted: true,
        files: {
          '.env.local': dotenv({
            [APP_URL_VAR]: PROJECT_URL,
            [APP_KEY_VAR]: SERVICE_ROLE_KEY,
          }),
        },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([
        HOSTED_CHECK_NAME,
        URL_CHECK_NAME,
        KEY_CHECK_NAME,
        SECRET_CHECK_NAME,
      ]);
      expectNoKeyValues(allNotes(result));
    });
  });

  describe('the hosted project cannot be read', () => {
    it.each([
      [
        'the API answers with an error',
        fakeMgmt({ error: { message: 'boom' }, status: 500 }).mgmt,
      ],
      ['the API call throws', fakeMgmt(new Error('connect ECONNREFUSED')).mgmt],
      [
        'the project returns no client key',
        fakeMgmt({ data: [LEGACY_KEY_ROWS[1]] }).mgmt,
      ],
    ])(
      'fails the hosted, URL and key checks, and returns all eight, when %s',
      async (_, mgmt) => {
        const { ctx } = fakeCtx({ mgmt });

        const result = await scorer(ctx);

        expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
        expect(failedNames(result)).toEqual([
          HOSTED_CHECK_NAME,
          URL_CHECK_NAME,
          KEY_CHECK_NAME,
        ]);
      }
    );
  });

  describe('wrong config values', () => {
    it('fails the key and secret checks, and no others, when the service_role key is written into the publishable key variable', async () => {
      const { ctx } = fakeCtx({
        files: {
          '.env.local': dotenv({
            [APP_URL_VAR]: PROJECT_URL,
            [APP_KEY_VAR]: SERVICE_ROLE_KEY,
          }),
        },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([KEY_CHECK_NAME, SECRET_CHECK_NAME]);
      expect(checkNamed(result, SECRET_CHECK_NAME)?.notes).toContain(
        `${APP_KEY_VAR} in .env.local ships a secret key to the browser`
      );
      expect(checkNamed(result, KEY_CHECK_NAME)?.notes).toContain(APP_KEY_VAR);
      expectNoKeyValues(allNotes(result));
    });

    it('fails only the URL check when the app points at the local stack', async () => {
      const { ctx } = fakeCtx({
        files: {
          '.env.local': dotenv({
            [APP_URL_VAR]: LOCAL_URL,
            [APP_KEY_VAR]: ANON_KEY,
          }),
        },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([URL_CHECK_NAME]);
      expect(checkNamed(result, URL_CHECK_NAME)?.notes).toContain(APP_URL_VAR);
    });

    it.each([
      ['a local stack anon key', LOCAL_ANON_KEY],
      ['a placeholder', PLACEHOLDER_KEY],
    ])(
      'fails only the key check when the config holds %s',
      async (_, value) => {
        const { ctx } = fakeCtx({
          files: {
            '.env.local': dotenv({
              [APP_URL_VAR]: PROJECT_URL,
              [APP_KEY_VAR]: value,
            }),
          },
        });

        const result = await scorer(ctx);

        expect(failedNames(result)).toEqual([KEY_CHECK_NAME]);
        expectNoKeyValues(allNotes(result));
      }
    );

    it('fails only the key check when only the URL was configured', async () => {
      const { ctx } = fakeCtx({
        files: { '.env.local': dotenv({ [APP_URL_VAR]: PROJECT_URL }) },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([KEY_CHECK_NAME]);
      expect(checkNamed(result, KEY_CHECK_NAME)?.notes).toContain('is unset');
    });

    it('fails only the URL check for the REST path of the project', async () => {
      const { ctx } = fakeCtx({
        files: {
          '.env.local': dotenv({
            [APP_URL_VAR]: `${PROJECT_URL}/rest/v1`,
            [APP_KEY_VAR]: ANON_KEY,
          }),
        },
      });

      expect(failedNames(await scorer(ctx))).toEqual([URL_CHECK_NAME]);
    });

    it('fails only the URL check, naming the host, when the URL is the ref on a lookalike domain', async () => {
      const { ctx } = fakeCtx({
        files: {
          '.env.local': dotenv({
            [APP_URL_VAR]: `https://${HOSTED_REF}.supabase.cx`,
            [APP_KEY_VAR]: ANON_KEY,
          }),
        },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([URL_CHECK_NAME]);
      expect(checkNamed(result, URL_CHECK_NAME)?.notes).toContain(
        `points at ${HOSTED_REF}.supabase.cx, not our project`
      );
      expect(result.passed).toBe(false);
    });

    it('fails only the URL check for a project URL carrying credentials and a port', async () => {
      const { ctx } = fakeCtx({
        files: {
          '.env.local': dotenv({
            [APP_URL_VAR]: `https://user:hunter2@${HOSTED_REF}.supabase.co:8443`,
            [APP_KEY_VAR]: ANON_KEY,
          }),
        },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([URL_CHECK_NAME]);
      expect(allNotes(result)).not.toContain('hunter2');
    });

    it('fails only the key check when a quoted publishable key keeps a leading space', async () => {
      const { ctx } = fakeCtx({
        files: {
          '.env.local': `${APP_URL_VAR}=${PROJECT_URL}\n${APP_KEY_VAR}=" ${ANON_KEY}"\n`,
        },
      });

      expect(failedNames(await scorer(ctx))).toEqual([KEY_CHECK_NAME]);
    });

    it('passes the key check when an unquoted publishable key has surrounding spaces, which dotenv trims', async () => {
      const { ctx } = fakeCtx({
        files: {
          '.env.local': `${APP_URL_VAR}=${PROJECT_URL}\n${APP_KEY_VAR}=  ${ANON_KEY}  \n`,
        },
      });

      expect(failedNames(await scorer(ctx))).toEqual([]);
    });

    it('fails only the URL check when a .env.development.local left over from the local stack overrides the right URL', async () => {
      const { ctx } = fakeCtx({
        files: {
          ...HEALTHY_FILES,
          '.env.development.local': dotenv({ [APP_URL_VAR]: LOCAL_URL }),
        },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([URL_CHECK_NAME]);
      expect(checkNamed(result, URL_CHECK_NAME)?.notes).toContain(
        '.env.development.local'
      );
    });

    it('fails only the URL check when the right URL is only in .env.production, which vite does not load in dev', async () => {
      const { ctx } = fakeCtx({
        files: {
          '.env.local': dotenv({ [APP_KEY_VAR]: ANON_KEY }),
          '.env.production': dotenv({ [APP_URL_VAR]: PROJECT_URL }),
        },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([URL_CHECK_NAME]);
      expect(checkNamed(result, URL_CHECK_NAME)?.notes).toContain('is unset');
    });

    it('fails the URL and key checks when the values were filled into .env.example instead of a file vite loads', async () => {
      const { ctx } = fakeCtx({
        files: {
          '.env.example': dotenv({
            [APP_URL_VAR]: PROJECT_URL,
            [APP_KEY_VAR]: ANON_KEY,
          }),
        },
      });

      expect(failedNames(await scorer(ctx))).toEqual([
        URL_CHECK_NAME,
        KEY_CHECK_NAME,
      ]);
    });

    it('fails the key check, and not the URL check, when the config is empty after copying .env.example', async () => {
      const { ctx } = fakeCtx({
        files: {
          '.env.local': dotenv({
            [APP_URL_VAR]: PROJECT_URL,
            [APP_KEY_VAR]: '',
          }),
        },
      });

      expect(failedNames(await scorer(ctx))).toEqual([KEY_CHECK_NAME]);
    });
  });

  describe('the app source', () => {
    const groundTruthOf = (judge: ReturnType<typeof fakeCtx>['judge']) =>
      judgeCall(judge, 'report')?.input ?? '';

    it('fails only the source check, naming the key variable, when a correct .env.local is paired with source that reads a renamed key variable', async () => {
      const { ctx, judge } = fakeCtx({
        files: {
          ...HEALTHY_FILES,
          'src/supabase.ts': clientSource(
            APP_URL_VAR,
            'VITE_SUPABASE_ANON_KEY'
          ),
        },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([APP_SOURCE_CHECK_NAME]);
      expect(result.passed).toBe(false);
      const notes = checkNamed(result, APP_SOURCE_CHECK_NAME)?.notes;
      expect(notes).toContain('no longer reads');
      expect(notes).toContain(APP_KEY_VAR);
      expect(notes).not.toContain(APP_URL_VAR);
      expect(groundTruthOf(judge)).toContain('no longer reads');
      expectNoKeyValues(allNotes(result));
      expectNoKeyValues(groundTruthOf(judge));
    });

    it('fails only the source check when the values are hard-coded in source while .env.local is correct', async () => {
      const { ctx } = fakeCtx({
        files: {
          ...HEALTHY_FILES,
          'src/supabase.ts': `import { createClient } from '@supabase/supabase-js';\n\nexport const supabase = createClient('${PROJECT_URL}', '${ANON_KEY}');\n`,
        },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([APP_SOURCE_CHECK_NAME]);
      expect(result.passed).toBe(false);
    });

    it('passes every check when the client moves to another module that still reads both variables', async () => {
      const { ctx } = fakeCtx({
        files: {
          ...HEALTHY_FILES,
          'src/supabase.ts': "export { supabase } from './lib/client';\n",
          'src/lib/client.ts': clientSource(),
        },
      });

      const result = await scorer(ctx);

      expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
      expect(result.passed).toBe(true);
    });

    it('fails only the source check, carrying the reason and telling the report judge, when the source cannot be searched', async () => {
      const { ctx, judge } = fakeCtx({
        overrides: [
          [
            new RegExp(APP_URL_VAR),
            stderrFailure(2, 'grep: src: Permission denied'),
          ],
        ],
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([APP_SOURCE_CHECK_NAME]);
      expect(checkNamed(result, APP_SOURCE_CHECK_NAME)?.notes).toContain(
        'Permission denied'
      );
      expect(groundTruthOf(judge)).toContain('could not be read');
      expect(groundTruthOf(judge)).not.toContain('no longer reads');
    });
  });

  describe('secrets in the repo', () => {
    it('fails only the secret check, naming the file, when a service_role key is hard-coded in source', async () => {
      const { ctx } = fakeCtx({
        files: {
          ...HEALTHY_FILES,
          'src/supabase.ts': `${clientSource()}export const admin = createClient(url, '${SERVICE_ROLE_KEY}');\n`,
        },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([SECRET_CHECK_NAME]);
      expect(checkNamed(result, SECRET_CHECK_NAME)?.notes).toContain(
        'src/supabase.ts'
      );
      expectNoKeyValues(allNotes(result));
    });

    describe('with project keys that have no recognisable shape', () => {
      const OPAQUE_ROWS: ApiKeyRow[] = [
        { name: 'anon', api_key: OPAQUE_CLIENT_KEY, type: 'legacy' },
        { name: 'service_role', api_key: OPAQUE_SECRET_KEY, type: 'legacy' },
      ];

      it('fails the key and secret checks when the project secret key is written into the publishable key variable of .env.local, which is read whatever the search lists', async () => {
        const { ctx } = fakeCtx({
          rows: OPAQUE_ROWS,
          files: {
            '.env.local': dotenv({
              [APP_URL_VAR]: PROJECT_URL,
              [APP_KEY_VAR]: OPAQUE_SECRET_KEY,
            }),
          },
        });

        const result = await scorer(ctx);

        expect(failedNames(result)).toEqual([
          KEY_CHECK_NAME,
          SECRET_CHECK_NAME,
        ]);
        expectNoKeyValues(allNotes(result));
      });
    });

    it('fails only the secret check, naming the file, when a secret key is written into .env.example', async () => {
      const { ctx } = fakeCtx({
        files: {
          ...HEALTHY_FILES,
          '.env.example': dotenv({ SUPABASE_SECRET_KEY: SECRET_KEY }),
        },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([SECRET_CHECK_NAME]);
      expect(checkNamed(result, SECRET_CHECK_NAME)?.notes).toContain(
        '.env.example'
      );
    });

    it('fails only the secret check when .env.local is a symlink to a file outside the workspace holding a VITE_ secret', async () => {
      const { ctx, dir } = fakeCtx({ files: {} });
      fs.writeFileSync(
        path.join(dir, '..', 'outside.env'),
        dotenv({
          [APP_URL_VAR]: PROJECT_URL,
          [APP_KEY_VAR]: ANON_KEY,
          VITE_SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
        })
      );
      fs.symlinkSync('../outside.env', path.join(dir, '.env.local'));

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([SECRET_CHECK_NAME]);
      expect(checkNamed(result, SECRET_CHECK_NAME)?.notes).toContain(
        'VITE_SUPABASE_SERVICE_ROLE_KEY in .env.local'
      );
      expectNoKeyValues(allNotes(result));
    });

    it('fails the secret check, never passes it, when supabase/config.toml is missing', async () => {
      const { ctx } = fakeCtx({
        files: { ...HEALTHY_FILES, 'supabase/config.toml': null },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([SECRET_CHECK_NAME]);
      expect(checkNamed(result, SECRET_CHECK_NAME)?.notes).toContain(
        'supabase/config.toml'
      );
    });

    it('fails the secret check, never passes it, when the search itself errors', async () => {
      const { ctx } = fakeCtx({
        overrides: [secretSearchRoute(stderrFailure(2, 'grep: input error'))],
      });

      expect(failedNames(await scorer(ctx))).toEqual([SECRET_CHECK_NAME]);
    });
  });

  describe('references that Vite expands', () => {
    const reportGroundTruth = (judge: ReturnType<typeof fakeCtx>['judge']) =>
      judgeCall(judge, 'report')?.input ?? '';

    it('passes every check when the key variable references the anon key kept under another name', async () => {
      const { ctx } = fakeCtx({
        files: {
          '.env.local': dotenv({
            SUPABASE_ANON_KEY: ANON_KEY,
            [APP_URL_VAR]: PROJECT_URL,
            [APP_KEY_VAR]: '${SUPABASE_ANON_KEY}',
          }),
        },
      });

      const result = await scorer(ctx);

      expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
      expect(result.passed).toBe(true);
      expect(
        JSON.parse(checkNamed(result, METRICS)?.notes ?? '{}')
      ).toMatchObject({
        keyKind: 'client',
        urlHost: `${HOSTED_REF}.supabase.co`,
      });
    });

    it('fails only the secret check when a second VITE_ name references the service_role key', async () => {
      const { ctx, judge } = fakeCtx({
        files: {
          '.env.local': dotenv({
            [APP_URL_VAR]: PROJECT_URL,
            [APP_KEY_VAR]: ANON_KEY,
            SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
            VITE_SUPABASE_SERVICE_ROLE_KEY: '${SUPABASE_SERVICE_ROLE_KEY}',
          }),
        },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([SECRET_CHECK_NAME]);
      expect(checkNamed(result, SECRET_CHECK_NAME)?.notes).toBe(
        'VITE_SUPABASE_SERVICE_ROLE_KEY (development and production env, via .env.local) ships a secret key to the browser'
      );
      expect(reportGroundTruth(judge)).toContain(
        '- secret key exposure: VITE_SUPABASE_SERVICE_ROLE_KEY (development and production env, via .env.local) ships a secret key to the browser'
      );
      expectNoKeyValues(allNotes(result));
      expectNoKeyValues(reportGroundTruth(judge));
    });

    it('fails the key and secret checks, and tells the report judge, when the key variable references the service_role key', async () => {
      const { ctx, judge } = fakeCtx({
        files: {
          '.env.local': dotenv({
            SUPABASE_ANON_KEY: ANON_KEY,
            SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
            [APP_URL_VAR]: PROJECT_URL,
            [APP_KEY_VAR]: '$SUPABASE_SERVICE_ROLE_KEY',
          }),
        },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([KEY_CHECK_NAME, SECRET_CHECK_NAME]);
      expect(checkNamed(result, KEY_CHECK_NAME)?.notes).toBe(
        `${APP_KEY_VAR} in .env.local holds a secret key, not a client key`
      );
      expect(checkNamed(result, SECRET_CHECK_NAME)?.notes).toBe(
        `${APP_KEY_VAR} (development and production env, via .env.local) ships a secret key to the browser`
      );
      const groundTruth = reportGroundTruth(judge);
      expect(groundTruth).toContain(
        `- ${APP_KEY_VAR} (from .env.local): secret key, which must never be in the app's config`
      );
      expect(groundTruth).toContain(
        `- secret key exposure: ${APP_KEY_VAR} (development and production env, via .env.local) ships a secret key to the browser`
      );
      expectNoKeyValues(allNotes(result));
      expectNoKeyValues(groundTruth);
    });

    it('fails only the secret check when .env.production references a secret that .env.local keeps', async () => {
      const { ctx } = fakeCtx({
        files: {
          ...HEALTHY_FILES,
          '.env.production': dotenv({
            VITE_SUPABASE_SERVICE_ROLE_KEY: '${SUPABASE_SERVICE_ROLE_KEY}',
          }),
          '.env': dotenv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY }),
        },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([SECRET_CHECK_NAME]);
      expect(checkNamed(result, SECRET_CHECK_NAME)?.notes).toBe(
        'VITE_SUPABASE_SERVICE_ROLE_KEY (production env, via .env.production) ships a secret key to the browser'
      );
    });
  });

  describe('a VITE_ secret that Vite does not ship', () => {
    const groundTruthOf = (judge: ReturnType<typeof fakeCtx>['judge']) =>
      judgeCall(judge, 'report')?.input ?? '';

    it('fails only the secret check, saying the secret is overridden and not shipped, when .env.local overrides a service_role key left in .env', async () => {
      const { ctx, judge } = fakeCtx({
        files: {
          ...HEALTHY_FILES,
          '.env': dotenv({ [APP_KEY_VAR]: SERVICE_ROLE_KEY }),
        },
      });

      const result = await scorer(ctx);

      const wording = `${APP_KEY_VAR} in .env holds a secret key (overridden, so not currently shipped)`;
      expect(failedNames(result)).toEqual([SECRET_CHECK_NAME]);
      expect(checkNamed(result, SECRET_CHECK_NAME)?.notes).toBe(wording);
      const groundTruth = groundTruthOf(judge);
      expect(groundTruth).toContain(`- secret key exposure: ${wording}`);
      expect(groundTruth).not.toContain('ships a secret key to the browser');
      expectNoKeyValues(allNotes(result));
      expectNoKeyValues(groundTruth);
    });

    it('fails only the secret check, saying Vite does not load the file, when a service_role key is left in a VITE_ variable of .env.example', async () => {
      const { ctx, judge } = fakeCtx({
        files: {
          ...HEALTHY_FILES,
          '.env.example': dotenv({ [APP_KEY_VAR]: SERVICE_ROLE_KEY }),
        },
      });

      const result = await scorer(ctx);

      const wording = `${APP_KEY_VAR} in .env.example holds a secret key (Vite doesn't load this file in dev or production)`;
      expect(failedNames(result)).toEqual([SECRET_CHECK_NAME]);
      expect(checkNamed(result, SECRET_CHECK_NAME)?.notes).toContain(wording);
      const groundTruth = groundTruthOf(judge);
      expect(groundTruth).toContain(`- secret key exposure: ${wording}`);
      expect(groundTruth).not.toContain('ships a secret key to the browser');
      expectNoKeyValues(groundTruth);
    });

    it('still says a service_role key in a VITE_ variable of .env.local ships to the browser', async () => {
      const { ctx, judge } = fakeCtx({
        files: {
          ...HEALTHY_FILES,
          '.env': dotenv({ [APP_KEY_VAR]: SERVICE_ROLE_KEY }),
          '.env.local': dotenv({
            [APP_URL_VAR]: PROJECT_URL,
            [APP_KEY_VAR]: SERVICE_ROLE_KEY,
          }),
        },
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([KEY_CHECK_NAME, SECRET_CHECK_NAME]);
      expect(groundTruthOf(judge)).toContain(
        `- secret key exposure: ${APP_KEY_VAR} in .env.local ships a secret key to the browser`
      );
    });
  });

  describe('probe failures', () => {
    it('still yields all eight checks, failing the config, source and secret checks, when every exec throws', async () => {
      const { ctx } = fakeCtx({ overrides: [[/.*/, crash()]] });

      const result = await scorer(ctx);

      expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
      expect(failedNames(result)).toEqual([
        URL_CHECK_NAME,
        KEY_CHECK_NAME,
        APP_SOURCE_CHECK_NAME,
        SECRET_CHECK_NAME,
      ]);
      expect(checkNamed(result, METRICS)?.passed).toBe(true);
    });

    it('fails the URL and key checks, carrying the reason, when .env.local cannot be read', async () => {
      const { ctx } = fakeCtx({
        overrides: [
          catRoute(
            '.env.local',
            stderrFailure(1, 'cat: .env.local: Permission denied')
          ),
        ],
      });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual(
        expect.arrayContaining([URL_CHECK_NAME, KEY_CHECK_NAME])
      );
      expect(checkNamed(result, URL_CHECK_NAME)?.notes).toContain(
        'Permission denied'
      );
      expect(checkNamed(result, KEY_CHECK_NAME)?.notes).toContain(
        'Permission denied'
      );
    });
  });

  describe('a throwing context', () => {
    it('returns a single failing check when the environment marker cannot be read', async () => {
      const { ctx } = fakeCtx();
      ctx.environmentMarker = async () => {
        throw new Error('marker unreadable');
      };

      expect(await scorer(ctx)).toEqual({
        passed: false,
        checks: [
          {
            name: "scorer evaluated the app's Supabase config",
            passed: false,
            notes: 'marker unreadable',
          },
        ],
      });
    });

    it('returns a single failing check when the tool calls cannot be read', async () => {
      const { ctx } = fakeCtx();
      Object.defineProperty(ctx, 'toolCalls', {
        get() {
          throw new Error('tool calls unreadable');
        },
      });

      expect(await scorer(ctx)).toEqual({
        passed: false,
        checks: [
          {
            name: "scorer evaluated the app's Supabase config",
            passed: false,
            notes: 'tool calls unreadable',
          },
        ],
      });
    });
  });
});

describe('metrics check', () => {
  it('reports the hosted, invocation, token, config and secret facts of a good run', async () => {
    const { ctx } = fakeCtx();

    const check = checkNamed(await scorer(ctx), METRICS);

    expect(check?.passed).toBe(true);
    expect(JSON.parse(check?.notes ?? '{}')).toMatchObject({
      hostedProject: true,
      projectsList: 1,
      projectsApiKeys: 1,
      projectsApiKeysReveal: 0,
      link: 0,
      login: 0,
      bootstrap: 0,
      tokenInEnvironment: true,
      envFiles: ['.env.local'],
      urlHost: `${HOSTED_REF}.supabase.co`,
      keyKind: 'client',
      secretsStoredPrivately: 0,
      commandCount: 3,
    });
  });

  it('reports a run with no hosted project, no token and nothing configured', async () => {
    const { ctx } = fakeCtx({
      noHosted: true,
      files: {},
      env: { SUPABASE_ACCESS_TOKEN: '' },
      toolCalls: [shellCall('supabase login')],
    });

    const check = checkNamed(await scorer(ctx), METRICS);

    expect(check?.passed).toBe(true);
    expect(JSON.parse(check?.notes ?? '{}')).toMatchObject({
      hostedProject: false,
      projectsList: 0,
      projectsApiKeys: 0,
      login: 1,
      tokenInEnvironment: false,
      envFiles: [],
      keyKind: 'unset',
      commandCount: 1,
    });
  });

  it('reports the service_role key written into the app config as a secret kind without printing it', async () => {
    const { ctx } = fakeCtx({
      files: {
        '.env.local': dotenv({
          [APP_URL_VAR]: PROJECT_URL,
          [APP_KEY_VAR]: SERVICE_ROLE_KEY,
        }),
      },
    });

    const check = checkNamed(await scorer(ctx), METRICS);

    expect(JSON.parse(check?.notes ?? '{}')).toMatchObject({
      keyKind: 'secret',
    });
    expectNoKeyValues(check?.notes);
  });
});

describe('detour judge', () => {
  it('receives every command numbered and the task it is judging against', async () => {
    const { ctx, judge } = fakeCtx();

    await scorer(ctx);

    const call = judgeCall(judge, 'detours');
    expect(call?.input).toBe(
      [
        '1. supabase projects list',
        `2. supabase projects api-keys --project-ref ${HOSTED_REF} -o env`,
        '3. cp .env.example .env.local',
      ].join('\n')
    );
    expect(call?.rubric).toMatch(/hosted Supabase project/i);
    expect(call?.rubric).toMatch(/API key/i);
    expect(call?.rubric).toMatch(/projects api-keys/);
  });

  it('tells the judge that starting, stopping or inspecting a local stack with the CLI is not a detour', async () => {
    const { ctx, judge } = fakeCtx();

    await scorer(ctx);

    expect(judgeCall(judge, 'detours')?.rubric).toContain(
      'starting, stopping or inspecting a local Supabase stack with the CLI (start, status, stop)'
    );
  });

  it('records the verdict notes and fails only the detour check when the judge fails', async () => {
    const { ctx } = fakeCtx({
      verdicts: {
        detours: { passed: false, notes: 'command 4 started dockerd' },
      },
    });

    const result = await scorer(ctx);

    expect(checkNamed(result, DETOUR_CHECK_NAME)).toMatchObject({
      passed: false,
      judgeNotes: 'command 4 started dockerd',
    });
    expect(failedNames(result)).toEqual([DETOUR_CHECK_NAME]);
  });
});

describe('report judge', () => {
  it('receives the harness ground truth and the transcript, including tool call outputs', async () => {
    const { ctx, judge } = fakeCtx({
      transcript: [
        {
          type: 'message',
          role: 'assistant',
          content: 'Pointed the app at the project.',
        },
        {
          type: 'tool_call',
          name: 'bash',
          input: { command: 'supabase projects list' },
          output: 'orders-dashboard  listed by the CLI',
        },
      ],
    });

    await scorer(ctx);

    const call = judgeCall(judge, 'report');
    expect(call?.input).toContain('Ground truth observed by the harness');
    expect(call?.input).toContain(HOSTED_REF);
    expect(call?.input).toContain('Pointed the app at the project.');
    expect(call?.input).toContain('orders-dashboard  listed by the CLI');
    expect(call?.rubric).toMatch(/hosted project/i);
    expect(call?.rubric).toMatch(/client key/i);
    expect(call?.rubric).toMatch(/secret key/i);
  });

  it('is told there was no hosted project and nothing was configured, so a made-up success cannot pass', async () => {
    const { ctx, judge } = fakeCtx({ noHosted: true, files: {} });

    await scorer(ctx);

    const input = judgeCall(judge, 'report')?.input ?? '';
    expect(input).toContain('CLI-2754');
  });

  it('shows an unset key as unset, with nothing in the ground truth redacted, when the run had no hosted project, no env files and no token', async () => {
    const { ctx, judge } = fakeCtx({
      noHosted: true,
      files: {},
      env: { SUPABASE_ACCESS_TOKEN: '' },
      transcript: [
        {
          type: 'message',
          role: 'assistant',
          content:
            "I could not configure the app. SUPABASE_ACCESS_TOKEN is not available in this environment, so I could not fetch the project's API keys, and neither the Supabase URL nor the publishable key is present in the app's config.",
        },
      ],
    });

    await scorer(ctx);

    const input = judgeCall(judge, 'report')?.input ?? '';
    const sections = input.split('\n\nTranscript:\n');
    expect(sections).toHaveLength(2);
    const [groundTruth] = sections;
    expect(groundTruth).toContain('- hosted project available: none');
    expect(groundTruth).toContain(
      '- env files Vite loads in dev that exist: none'
    );
    expect(groundTruth).toContain(
      '- SUPABASE_ACCESS_TOKEN set in the sandbox environment: no'
    );
    expect(groundTruth).toContain(`${APP_KEY_VAR} is unset`);
    expect(groundTruth).not.toContain('[redacted]');
  });

  it('is told the config points at the local stack when it does', async () => {
    const { ctx, judge } = fakeCtx({
      files: {
        '.env.local': dotenv({
          [APP_URL_VAR]: LOCAL_URL,
          [APP_KEY_VAR]: ANON_KEY,
        }),
      },
    });

    await scorer(ctx);

    expect(judgeCall(judge, 'report')?.input).toContain('127.0.0.1');
  });

  it('records the verdict notes and fails only the report check when the judge fails', async () => {
    const { ctx } = fakeCtx({
      verdicts: {
        report: {
          passed: false,
          notes: 'claimed a connection that does not exist',
        },
      },
    });

    const result = await scorer(ctx);

    expect(checkNamed(result, REPORT)).toMatchObject({
      passed: false,
      judgeNotes: 'claimed a connection that does not exist',
    });
    expect(failedNames(result)).toEqual([REPORT]);
  });
});

describe('judge errors', () => {
  it.each([
    ['detours', [DETOUR_CHECK_NAME]],
    ['report', [REPORT]],
  ] as const)(
    'turns a thrown %s judge into one failing check and leaves the others',
    async (kind, expectedFailures) => {
      const { ctx } = fakeCtx({
        verdicts: { [kind]: new Error('judge unavailable') },
      });

      const result = await scorer(ctx);

      expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
      expect(failedNames(result)).toEqual(expectedFailures);
      expect(checkNamed(result, expectedFailures[0])).toEqual({
        name: expectedFailures[0],
        passed: false,
        notes: 'judge unavailable',
      });
    }
  );

  it('fails both judged checks and no others when both judges throw', async () => {
    const { ctx } = fakeCtx({
      verdicts: {
        detours: new Error('judge unavailable'),
        report: new Error('judge unavailable'),
      },
    });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([DETOUR_CHECK_NAME, REPORT]);
    expect(result.passed).toBe(false);
  });
});

describe('judge input redaction', () => {
  const LEAKY_SESSION = [
    shellCall('supabase projects list'),
    shellCall(
      `supabase projects api-keys --project-ref ${HOSTED_REF} --reveal`
    ),
    shellCall(`echo using ${OPAQUE_CLIENT_KEY} and ${OPAQUE_SECRET_KEY}`),
    shellCall(
      `echo ${SERVICE_ROLE_KEY} ${SECRET_KEY} ${ANON_KEY} ${PUBLISHABLE_KEY}`
    ),
  ];

  const LEAKY_TRANSCRIPT: TranscriptPart[] = [
    {
      type: 'message',
      role: 'assistant',
      content: `The client key is ${OPAQUE_CLIENT_KEY}; the admin key ${OPAQUE_SECRET_KEY} stays out of the app. Also ${SERVICE_ROLE_KEY} and ${SECRET_KEY}.`,
    },
    {
      type: 'tool_call',
      name: 'bash',
      input: { command: `echo ${OPAQUE_SECRET_KEY}` },
      output: `${OPAQUE_SECRET_KEY}\n${OPAQUE_CLIENT_KEY}\n${ANON_KEY}\n${PUBLISHABLE_KEY}`,
    },
  ];

  it('never lets a project key reach either judge, including keys with no recognisable shape', async () => {
    const { ctx, judge } = fakeCtx({
      rows: [
        { name: 'anon', api_key: OPAQUE_CLIENT_KEY, type: 'legacy' },
        { name: 'service_role', api_key: OPAQUE_SECRET_KEY, type: 'legacy' },
      ],
      files: {
        '.env.local': dotenv({
          [APP_URL_VAR]: PROJECT_URL,
          [APP_KEY_VAR]: OPAQUE_CLIENT_KEY,
        }),
      },
      toolCalls: LEAKY_SESSION,
      transcript: LEAKY_TRANSCRIPT,
    });

    const result = await scorer(ctx);

    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(judge).toHaveBeenCalledTimes(2);
    for (const [{ input }] of judge.mock.calls) {
      for (const key of FIXTURE_KEY_VALUES) expect(input).not.toContain(key);
    }
  });

  it('keeps the refs and commands readable while redacting the keys', async () => {
    const { ctx, judge } = fakeCtx({
      toolCalls: LEAKY_SESSION,
      transcript: LEAKY_TRANSCRIPT,
    });

    await scorer(ctx);

    const detours = judgeCall(judge, 'detours')?.input ?? '';
    expect(detours).toContain(
      `supabase projects api-keys --project-ref ${HOSTED_REF} --reveal`
    );
    expect(judgeCall(judge, 'report')?.input).toContain(HOSTED_REF);
  });

  it('still redacts key shapes when there is no hosted project to supply known keys', async () => {
    const { ctx, judge } = fakeCtx({
      noHosted: true,
      toolCalls: [
        shellCall(`echo ${SERVICE_ROLE_KEY} ${SECRET_KEY} ${PUBLISHABLE_KEY}`),
      ],
      transcript: LEAKY_TRANSCRIPT,
    });

    await scorer(ctx);

    for (const [{ input }] of judge.mock.calls) {
      for (const key of [
        SERVICE_ROLE_KEY,
        SECRET_KEY,
        PUBLISHABLE_KEY,
        ANON_KEY,
      ]) {
        expect(input).not.toContain(key);
      }
    }
  });

  it('never puts the config values into the ground truth the report judge sees', async () => {
    const { ctx, judge } = fakeCtx({
      files: {
        '.env.local': dotenv({
          [APP_URL_VAR]: PROJECT_URL,
          [APP_KEY_VAR]: SERVICE_ROLE_KEY,
        }),
      },
    });

    await scorer(ctx);

    expectNoKeyValues(judgeCall(judge, 'report')?.input);
  });
});
