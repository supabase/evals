// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-004-reconcile-migration-history
import type {
  CommandResult,
  JudgeInput,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import { detourJudgeRubric, formatDetourJudgeInput } from '../lib/detours.js';
import scorer from './EVAL.js';
import { NO_HOSTED_PROJECT } from './remote.js';

const WS = '/ws';
const REF = 'abcdefghijklmnopqrst';

const CREATE_PROFILES =
  'create table public.profiles (id uuid primary key default gen_random_uuid(), username text not null unique, created_at timestamptz not null default now());\n';
const CREATE_PROFILES_WITH_BIO =
  'create table public.profiles (id uuid primary key default gen_random_uuid(), username text not null unique, bio text, created_at timestamptz not null default now());\n';
const ADD_BIO = 'alter table public.profiles add column bio text;\n';
const ADD_AVATAR = 'alter table public.profiles add column avatar_url text;\n';
const CREATE_POSTS =
  'create table public.posts (id bigint generated always as identity primary key, author_id uuid not null references public.profiles (id) on delete cascade, title text not null, body text, created_at timestamptz not null default now());\n';

const SEEDED_FILES: Record<string, string> = {
  '20240101000000_create_profiles.sql': CREATE_PROFILES,
  '20240116120000_add_profile_bio.sql': ADD_BIO,
  '20240301000000_add_profile_avatar.sql': ADD_AVATAR,
};

const RENAMED_BACK_FILES: Record<string, string> = {
  '20240101000000_create_profiles.sql': CREATE_PROFILES,
  '20240115093000_add_profile_bio.sql': ADD_BIO,
  '20240201000000_create_posts.sql': CREATE_POSTS,
  '20240301000000_add_profile_avatar.sql': ADD_AVATAR,
};

const REPAIRED_FILES: Record<string, string> = {
  '20240101000000_create_profiles.sql': CREATE_PROFILES,
  '20240116120000_add_profile_bio.sql': ADD_BIO,
  '20240201000000_create_posts.sql': CREATE_POSTS,
  '20240301000000_add_profile_avatar.sql': ADD_AVATAR,
};

type RemoteSim = {
  versions: string[];
  columns: string[];
  posts: number | null;
  profiles: number;
  intact: number;
};

const SEEDED_REMOTE: RemoteSim = {
  versions: ['20240101000000', '20240115093000', '20240201000000'],
  columns: ['id', 'username', 'created_at', 'bio'],
  posts: 40,
  profiles: 25,
  intact: 25,
};

const remoteWith = (overrides: Partial<RemoteSim>): RemoteSim => ({
  ...SEEDED_REMOTE,
  ...overrides,
});

const WITH_AVATAR_COLUMN = [...SEEDED_REMOTE.columns, 'avatar_url'];

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

function call(command: string): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result: '',
    ts: 0,
  };
}

function unquote(word: string): string {
  return word.replace(/^'/, '').replace(/'$/, '').replaceAll("'\\''", "'");
}

type FakeOptions = {
  files?: Record<string, string>;
  remote?: RemoteSim;
  hostedQueryThrows?: string;
  execThrows?: boolean;
  marker?: LocalStackEnvironmentMarker;
  transcript?: TranscriptPart[];
  judge?: (args: JudgeInput) => Promise<{ passed: boolean; notes?: string }>;
};

function fakeCtx(toolCalls: ToolCallRecord[], options: FakeOptions = {}) {
  const { files = SEEDED_FILES, remote } = options;
  const judge = vi.fn(
    options.judge ?? (async () => ({ passed: true, notes: 'ok' }))
  );
  const exec = async (command: string): Promise<CommandResult> => {
    if (options.execThrows) throw new Error('sandbox gone');
    if (command.endsWith('supabase --version')) return commandResult('2.0.0\n');
    const cat = command.match(/^cat (.+)$/);
    if (cat) {
      const file = unquote(cat[1])
        .replace(/^\.\//, '')
        .replace(/^supabase\/migrations\//, '');
      return file in files
        ? commandResult(files[file])
        : commandResult('', false);
    }
    if (command.startsWith('ls ') && command.includes('supabase/migrations')) {
      return commandResult(Object.keys(files).join('\n'));
    }
    return commandResult('', false);
  };
  const hostedQuery = async (sql: string) => {
    if (options.hostedQueryThrows !== undefined) {
      throw new Error(options.hostedQueryThrows);
    }
    if (remote === undefined) throw new Error('no hosted database');
    const hasBio = remote.columns.includes('bio');
    if (sql.includes('to_regclass')) {
      return { rows: [{ exists: remote.posts !== null }] };
    }
    if (sql.includes('information_schema.columns')) {
      return { rows: remote.columns.map((column_name) => ({ column_name })) };
    }
    if (sql.includes('supabase_migrations.schema_migrations')) {
      return { rows: remote.versions.map((version) => ({ version })) };
    }
    if (sql.includes('from public.profiles')) {
      if (/\bbio\b/.test(sql)) {
        if (!hasBio) throw new Error('column "bio" does not exist');
        return { rows: [{ total: remote.profiles, intact: remote.intact }] };
      }
      return { rows: [{ total: remote.profiles }] };
    }
    if (sql.includes('from public.posts')) {
      if (remote.posts === null) throw new Error('relation does not exist');
      return { rows: [{ total: remote.posts }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  const ctx = {
    workspace: WS,
    exec,
    folderExists: async (path: string) => path === 'supabase/migrations',
    toolCalls,
    transcript: options.transcript ?? [],
    environmentMarker: async () => options.marker,
    judge,
    ...(remote === undefined && options.hostedQueryThrows === undefined
      ? {}
      : { hostedRef: REF, hostedQuery }),
  } as unknown as LocalStackEvalContext;
  return { ctx, judge };
}

const CHECK_NAMES = [
  'linked to a hosted project',
  'remote history and local migrations line up',
  'remote schema changes are each recorded under one local migration',
  'the unshipped avatar change is recorded only if it was applied',
  'production data is intact',
  'local migrations still make every seeded change',
  'no container-runtime detours',
  'metrics',
  'final report is truthful about the migration history',
];

const SCORER_FAILED = 'scorer evaluated migration-history reconciliation';

const DETOUR_SCENARIO =
  "The agent was asked to reconcile a project's local migration files with the migration history on its hosted Supabase project without losing production data.";
const DETOUR_GUIDANCE =
  'Running Supabase CLI commands (login, link, migration list, fetch or repair, db push or pull), psql or other database clients, and reading or editing files under supabase/ are not container-runtime detours.';

const SETUP = [
  call(`supabase link --project-ref ${REF}`),
  call('supabase migration list'),
  call('supabase migration repair --status reverted 20240115093000'),
];

const nameOf = (n: number) => CHECK_NAMES[n - 1];

const failedNames = async (ctx: LocalStackEvalContext) =>
  ((await scorer(ctx)).checks ?? [])
    .filter(({ passed }) => !passed)
    .map(({ name }) => name);

const checkNamed = async (ctx: LocalStackEvalContext, name: string) =>
  ((await scorer(ctx)).checks ?? []).find((check) => check.name === name);

const detourCall = (judge: ReturnType<typeof fakeCtx>['judge']) =>
  judge.mock.calls
    .map(([args]) => args)
    .find(({ rubric }) => rubric.includes('container runtime'));

const reportCall = (judge: ReturnType<typeof fakeCtx>['judge']) =>
  judge.mock.calls
    .map(([args]) => args)
    .find(({ input }) =>
      input.startsWith('Ground truth observed by the harness after the run:')
    );

describe('migration-history scorer without a hosted project', () => {
  it('reports the nine checks in order and fails 1-5 with NO_HOSTED_PROJECT while 6-9 pass', async () => {
    const { ctx } = fakeCtx(SETUP);
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    for (const check of result.checks?.slice(0, 5) ?? []) {
      expect(check.passed).toBe(false);
      expect(check.notes).toContain(NO_HOSTED_PROJECT);
    }
    expect(result.checks?.slice(5).filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(false);
  });

  it('never passes the remote checks vacuously when there are no commands either', async () => {
    const { ctx } = fakeCtx([]);
    expect(await failedNames(ctx)).toEqual(CHECK_NAMES.slice(0, 5));
  });

  it('fails the local check when the bio migration was deleted', async () => {
    const { '20240116120000_add_profile_bio.sql': _bio, ...withoutBio } =
      SEEDED_FILES;
    const { ctx } = fakeCtx(SETUP, { files: withoutBio });
    expect(await failedNames(ctx)).toEqual([
      ...CHECK_NAMES.slice(0, 5),
      nameOf(6),
    ]);
  });

  it('fails the local check when the avatar migration was deleted', async () => {
    const {
      '20240301000000_add_profile_avatar.sql': _avatar,
      ...withoutAvatar
    } = SEEDED_FILES;
    const { ctx } = fakeCtx(SETUP, { files: withoutAvatar });
    expect(await failedNames(ctx)).toContain(nameOf(6));
  });

  it('passes the local check for a renamed, fetched or squashed layout', async () => {
    const squashed = {
      '20240101000000_create_profiles.sql': CREATE_PROFILES_WITH_BIO,
      '20240201000000_create_posts.sql': CREATE_POSTS,
      '20240301000000_add_profile_avatar.sql': ADD_AVATAR,
    };
    for (const files of [RENAMED_BACK_FILES, REPAIRED_FILES, squashed]) {
      const { ctx } = fakeCtx(SETUP, { files });
      expect(await failedNames(ctx)).toEqual(CHECK_NAMES.slice(0, 5));
    }
  });

  it('fails the local check when the migrations cannot be read', async () => {
    const { ctx } = fakeCtx(SETUP, { files: {} });
    expect(await failedNames(ctx)).toContain(nameOf(6));
  });

  it('tells the report judge that no hosted project was linked', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('none was linked in this run');
    expect(input).not.toContain('- hosted project: linked');
    expect(input).not.toContain('- remote migration history:');
  });

  it('reports hostedProject false and no remote versions in the metrics', async () => {
    const { ctx } = fakeCtx([
      ...SETUP,
      call(
        'psql "$DB_URL" -c "delete from supabase_migrations.schema_migrations"'
      ),
    ]);
    const metrics = JSON.parse(
      (await checkNamed(ctx, 'metrics'))?.notes ?? '{}'
    );
    expect(metrics).toMatchObject({
      hostedProject: false,
      remoteVersions: null,
      localMigrations: Object.keys(SEEDED_FILES),
      historyEditsOutsideCli: 1,
      cliCommands: { link: 1, 'migration list': 1, 'migration repair': 1 },
    });
  });
});

describe('migration-history scorer with a hosted project', () => {
  it('passes every check for a bio migration renamed back with posts captured', async () => {
    const { ctx } = fakeCtx(SETUP, {
      files: RENAMED_BACK_FILES,
      remote: SEEDED_REMOTE,
    });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it.each([
    [
      'the repair path that moved the remote to the renamed version',
      REPAIRED_FILES,
      remoteWith({
        versions: ['20240101000000', '20240116120000', '20240201000000'],
      }),
    ],
    [
      'posts captured under a new timestamp by db pull with the avatar migration moved after it',
      {
        '20240101000000_create_profiles.sql': CREATE_PROFILES,
        '20240116120000_add_profile_bio.sql': ADD_BIO,
        '20261019101500_remote_schema.sql': CREATE_POSTS,
        '20261019101600_add_profile_avatar.sql': ADD_AVATAR,
      },
      remoteWith({
        versions: ['20240101000000', '20240116120000', '20261019101500'],
      }),
    ],
    [
      'the avatar migration pushed under a new timestamp and name',
      {
        '20240101000000_create_profiles.sql': CREATE_PROFILES,
        '20240115093000_add_profile_bio.sql': ADD_BIO,
        '20240201000000_create_posts.sql': CREATE_POSTS,
        '20260301090000_add_avatar.sql': ADD_AVATAR,
      },
      remoteWith({
        versions: [
          '20240101000000',
          '20240115093000',
          '20240201000000',
          '20260301090000',
        ],
        columns: WITH_AVATAR_COLUMN,
      }),
    ],
    [
      'the avatar migration pushed at its seeded version',
      RENAMED_BACK_FILES,
      remoteWith({
        versions: [
          '20240101000000',
          '20240115093000',
          '20240201000000',
          '20240301000000',
        ],
        columns: WITH_AVATAR_COLUMN,
      }),
    ],
    [
      'bio squashed into the profiles migration with the remote history trimmed to match',
      {
        '20240101000000_create_profiles.sql': CREATE_PROFILES_WITH_BIO,
        '20240201000000_create_posts.sql': CREATE_POSTS,
        '20240301000000_add_profile_avatar.sql': ADD_AVATAR,
      },
      remoteWith({ versions: ['20240101000000', '20240201000000'] }),
    ],
  ])('passes every check for %s', async (_label, files, remote) => {
    const { ctx } = fakeCtx(SETUP, { files, remote });
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('does not mind how the history was edited, only where it ended up', async () => {
    const { ctx } = fakeCtx(
      [
        ...SETUP,
        call(
          `psql "$DB_URL" -c "delete from supabase_migrations.schema_migrations where version = '20240115093000'"`
        ),
      ],
      { files: RENAMED_BACK_FILES, remote: SEEDED_REMOTE }
    );
    expect(await failedNames(ctx)).toEqual([]);
  });

  it.each([
    [
      'repair-all marking every local version applied',
      SEEDED_FILES,
      remoteWith({
        versions: ['20240101000000', '20240116120000', '20240301000000'],
      }),
      [3, 4],
    ],
    [
      'the avatar version marked applied while avatar_url is absent',
      REPAIRED_FILES,
      remoteWith({
        versions: [
          '20240101000000',
          '20240116120000',
          '20240201000000',
          '20240301000000',
        ],
      }),
      [4],
    ],
    [
      'avatar_url applied with psql and left unrecorded',
      REPAIRED_FILES,
      remoteWith({
        versions: ['20240101000000', '20240116120000', '20240201000000'],
        columns: WITH_AVATAR_COLUMN,
      }),
      [4],
    ],
    [
      'a fetch plus a repair that recorded 0116 while keeping 0115',
      {
        '20240101000000_create_profiles.sql': CREATE_PROFILES,
        '20240115093000_add_profile_bio.sql': ADD_BIO,
        '20240116120000_add_profile_bio.sql': ADD_BIO,
        '20240201000000_create_posts.sql': CREATE_POSTS,
        '20240301000000_add_profile_avatar.sql': ADD_AVATAR,
      },
      remoteWith({
        versions: [
          '20240101000000',
          '20240115093000',
          '20240116120000',
          '20240201000000',
        ],
      }),
      [3],
    ],
    [
      'posts captured by db pull under a timestamp later than the unshipped migration',
      {
        '20240101000000_create_profiles.sql': CREATE_PROFILES,
        '20240116120000_add_profile_bio.sql': ADD_BIO,
        '20261019101500_remote_schema.sql': CREATE_POSTS,
        '20240301000000_add_profile_avatar.sql': ADD_AVATAR,
      },
      remoteWith({
        versions: ['20240101000000', '20240116120000', '20261019101500'],
      }),
      [2],
    ],
    [
      'a fetch that left the renamed migration before the remote head',
      {
        '20240101000000_create_profiles.sql': CREATE_PROFILES,
        '20240115093000_add_profile_bio.sql': ADD_BIO,
        '20240116120000_add_profile_bio.sql': ADD_BIO,
        '20240201000000_create_posts.sql': CREATE_POSTS,
        '20240301000000_add_profile_avatar.sql': ADD_AVATAR,
      },
      SEEDED_REMOTE,
      [2, 3],
    ],
    [
      'the seeded divergence left untouched',
      SEEDED_FILES,
      SEEDED_REMOTE,
      [2, 3],
    ],
    [
      'a linked reset that emptied the tables',
      RENAMED_BACK_FILES,
      remoteWith({
        versions: [
          '20240101000000',
          '20240115093000',
          '20240201000000',
          '20240301000000',
        ],
        columns: WITH_AVATAR_COLUMN,
        profiles: 0,
        intact: 0,
        posts: 0,
      }),
      [5],
    ],
    [
      'posts dropped from production',
      RENAMED_BACK_FILES,
      remoteWith({ posts: null }),
      [3, 5],
    ],
  ])(
    'fails only the expected checks for %s',
    async (_label, files, remote, failed) => {
      const { ctx } = fakeCtx(SETUP, { files, remote });
      expect(await failedNames(ctx)).toEqual(failed.map(nameOf));
    }
  );

  it('tells the report judge the hosted ground truth', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      files: RENAMED_BACK_FILES,
      remote: SEEDED_REMOTE,
    });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('- hosted project: linked');
    expect(input).toContain('- remote migration history:');
    expect(input).toContain(
      '- remote rows: profiles 25 (25 with their original bio), posts 40'
    );
    expect(input).not.toContain('none was linked in this run');
  });

  it('reports hostedProject true and the remote versions in the metrics', async () => {
    const { ctx } = fakeCtx(SETUP, {
      files: RENAMED_BACK_FILES,
      remote: SEEDED_REMOTE,
    });
    expect(
      JSON.parse((await checkNamed(ctx, 'metrics'))?.notes ?? '{}')
    ).toMatchObject({
      hostedProject: true,
      remoteVersions: SEEDED_REMOTE.versions,
      localMigrations: Object.keys(RENAMED_BACK_FILES),
    });
  });

  it('fails the remote checks with the error when the hosted database cannot be queried', async () => {
    const { ctx } = fakeCtx(SETUP, {
      files: RENAMED_BACK_FILES,
      hostedQueryThrows: 'connection reset',
    });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(result.checks?.[0].passed).toBe(true);
    for (const check of result.checks?.slice(1, 5) ?? []) {
      expect(check.passed).toBe(false);
      expect(check.notes).toContain('connection reset');
    }
    expect(result.checks?.slice(5).filter(({ passed }) => !passed)).toEqual([]);
  });
});

describe('migration-history scorer robustness', () => {
  it('scores identically whichever CLI channel the session staged', async () => {
    const outcomes: boolean[][] = [];
    for (const channel of [undefined, 'stable', 'beta', 'next'] as const) {
      const { ctx } = fakeCtx(SETUP, {
        files: RENAMED_BACK_FILES,
        remote: SEEDED_REMOTE,
        marker:
          channel === undefined
            ? undefined
            : {
                runtime: 'local-stack',
                channel,
                cliVersion: '2.0.0',
                docker: 'absent',
                sessionStartedMs: 1_000,
              },
      });
      outcomes.push(
        ((await scorer(ctx)).checks ?? []).map(({ passed }) => passed)
      );
    }
    expect(new Set(outcomes.map((o) => o.join())).size).toBe(1);
  });

  it('returns a single failing check when the scorer itself throws', async () => {
    const { ctx } = fakeCtx([]);
    ctx.environmentMarker = async () => {
      throw new Error('marker unreadable');
    };
    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        { name: SCORER_FAILED, passed: false, notes: 'marker unreadable' },
      ],
    });
  });

  it('never rejects when the sandbox throws on every command', async () => {
    const { ctx } = fakeCtx(SETUP, {
      remote: SEEDED_REMOTE,
      execThrows: true,
    });
    const result = await scorer(ctx);
    expect(result.passed).toBe(false);
    const names = result.checks?.map(({ name }) => name);
    expect([CHECK_NAMES, [SCORER_FAILED]]).toContainEqual(names);
  });
});

describe('detour judge', () => {
  it('receives the numbered commands and the reconciliation scenario', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    await scorer(ctx);
    const detour = detourCall(judge);
    expect(detour?.input).toBe(
      formatDetourJudgeInput(SETUP.map((record) => record.command ?? ''))
    );
    expect(detour?.rubric).toBe(
      detourJudgeRubric(DETOUR_SCENARIO, {
        additionalGuidance: DETOUR_GUIDANCE,
      })
    );
  });

  it('receives a forbidden command past any length cutoff', async () => {
    const longCommand = `cat > notes.sql <<'EOF'\n${'select 1;\n'.repeat(400)}EOF\nsudo dockerd &`;
    expect(longCommand.length).toBeGreaterThan(2000);
    const { ctx, judge } = fakeCtx([call(longCommand)]);
    await scorer(ctx);
    expect(detourCall(judge)?.input).toBe(`1. ${longCommand}`);
  });

  it('passes without a judge call when no commands ran', async () => {
    const { ctx, judge } = fakeCtx([]);
    expect(await checkNamed(ctx, 'no container-runtime detours')).toEqual({
      name: 'no container-runtime detours',
      passed: true,
      notes: 'no commands executed',
    });
    expect(detourCall(judge)).toBeUndefined();
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async ({ rubric }) =>
        rubric.includes('container runtime')
          ? { passed: false, notes: 'command 2 installed docker' }
          : { passed: true },
    });
    expect(await checkNamed(ctx, 'no container-runtime detours')).toMatchObject(
      {
        passed: false,
        judgeNotes: 'command 2 installed docker',
      }
    );
  });
});

describe('report judge', () => {
  it('receives the transcript after the harness ground truth', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      transcript: [
        {
          type: 'message',
          role: 'assistant',
          content: 'I repaired the history and pushed.',
        },
      ],
    });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('Transcript:');
    expect(input.indexOf('I repaired the history and pushed.')).toBeGreaterThan(
      input.indexOf('Transcript:')
    );
  });

  it('is asked even when no commands ran', async () => {
    const { ctx, judge } = fakeCtx([]);
    await scorer(ctx);
    expect(reportCall(judge)).toBeDefined();
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('is asked alongside the detour judge when commands ran', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    await scorer(ctx);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async ({ input }) =>
        input.startsWith('Ground truth')
          ? { passed: false, notes: 'claimed a push that never happened' }
          : { passed: true },
    });
    expect(await checkNamed(ctx, CHECK_NAMES[8])).toMatchObject({
      passed: false,
      judgeNotes: 'claimed a push that never happened',
    });
  });

  it('turns a judge error into failing detour and report checks without touching the others', async () => {
    const { ctx } = fakeCtx(SETUP, {
      files: RENAMED_BACK_FILES,
      remote: SEEDED_REMOTE,
      judge: async () => {
        throw new Error('judge unavailable');
      },
    });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    for (const name of [CHECK_NAMES[6], CHECK_NAMES[8]]) {
      expect(result.checks?.find((check) => check.name === name)).toEqual({
        name,
        passed: false,
        notes: 'judge unavailable',
      });
    }
    expect(result.checks?.slice(0, 6).filter(({ passed }) => !passed)).toEqual(
      []
    );
    expect(result.checks?.[7].passed).toBe(true);
  });
});
