// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/lib/config-edit
import { readFileSync } from 'node:fs';
import type {
  CommandResult,
  JudgeInput,
  JudgeResult,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import { applyEdits, modify } from 'jsonc-parser';
import { describe, expect, it, vi } from 'vitest';
import { scoreConfigEdit } from './config-edit.js';
import {
  CHECK_NAMES,
  CONFIG_PATHS,
  type ConfigFormat,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  STAGING_CALLBACK,
} from './config-edit-checks.js';
import { DETOUR_CHECK_NAME } from './detours.js';

const EVAL_DIRS: Record<ConfigFormat, string> = {
  toml: 'build-cli-005-edit-config-toml',
  jsonc: 'build-cli-007-edit-config-jsonc',
};

const seedText = (format: ConfigFormat) =>
  readFileSync(
    new URL(
      `../${EVAL_DIRS[format]}/local/${CONFIG_PATHS[format]}`,
      import.meta.url
    ),
    'utf8'
  );

const GITHUB_OK = {
  enabled: true,
  client_id: 'env(GITHUB_CLIENT_ID)',
  secret: 'env(GITHUB_CLIENT_SECRET)',
};

type Values = {
  email?: unknown;
  sms?: unknown;
  redirects?: unknown;
  size?: unknown;
  github?: Record<string, unknown> | null;
  extra?: { path: string[]; value: unknown };
};

const DEFAULTS: Required<Omit<Values, 'extra'>> = {
  email: true,
  sms: false,
  redirects: ['https://127.0.0.1:3000', STAGING_CALLBACK],
  size: '100MB',
  github: GITHUB_OK,
};

function tomlValue(value: unknown): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return `{ ${Object.entries(value)
      .map(([key, inner]) => `${key} = ${tomlValue(inner)}`)
      .join(', ')} }`;
  }
  return JSON.stringify(value);
}

function tomlConfig(values: Values): string {
  const { email, sms, redirects, size, github } = { ...DEFAULTS, ...values };
  let text = seedText('toml')
    .replace(
      'enable_confirmations = false',
      `enable_confirmations = ${tomlValue(email)}`
    )
    .replace(
      /(\[auth\.sms\][\s\S]*?)enable_confirmations = false/,
      `$1enable_confirmations = ${tomlValue(sms)}`
    )
    .replace(
      'additional_redirect_urls = ["https://127.0.0.1:3000"]',
      `additional_redirect_urls = ${tomlValue(redirects)}`
    )
    .replace(
      'file_size_limit = "50MiB"',
      `file_size_limit = ${tomlValue(size)}`
    );
  if (github !== null) {
    text += `\n[auth.external.github]\n${Object.entries(github)
      .map(([key, value]) => `${key} = ${tomlValue(value)}`)
      .join('\n')}\n`;
  }
  if (values.extra) {
    const header = `\n[${values.extra.path.slice(0, -1).join('.')}]\n`;
    text = text.replace(
      header,
      `${header}${values.extra.path.at(-1)} = ${tomlValue(values.extra.value)}\n`
    );
  }
  return text;
}

function jsoncConfig(values: Values): string {
  const { email, sms, redirects, size, github } = { ...DEFAULTS, ...values };
  let text = seedText('jsonc');
  const set = (path: string[], value: unknown) => {
    text = applyEdits(text, modify(text, path, value, {}));
  };
  set(['auth', 'email', 'enable_confirmations'], email);
  set(['auth', 'sms', 'enable_confirmations'], sms);
  set(['auth', 'additional_redirect_urls'], redirects);
  set(['storage', 'file_size_limit'], size);
  if (github !== null) set(['auth', 'external', 'github'], github);
  if (values.extra) set(values.extra.path, values.extra.value);
  return text;
}

const configFor = (format: ConfigFormat, values: Values = {}) =>
  format === 'toml' ? tomlConfig(values) : jsoncConfig(values);

const ok = (stdout = ''): CommandResult => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr: '',
});
const fail = (exitCode: number, stderr = ''): CommandResult => ({
  ok: false,
  exitCode,
  stdout: '',
  stderr,
});
const MISSING = (path: string) =>
  fail(1, `cat: ${path}: No such file or directory`);

const ENV_FILE = `GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}\nGITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}\n`;

type FakeOptions = {
  format?: ConfigFormat;
  config?: string | CommandResult;
  envFile?: string | CommandResult;
  localEnv?: string | CommandResult;
  rootEnv?: string | CommandResult;
  grep?: CommandResult;
  committed?: string[];
  find?: CommandResult;
  toolCalls?: ToolCallRecord[];
  reportVerdict?: JudgeResult;
};

const shellCall = (command: string, error?: string): ToolCallRecord => ({
  tool: { kind: 'other', toolName: 'shell' },
  body: { command },
  command,
  result: '',
  ts: 0,
  ...(error === undefined ? {} : { error }),
});

const asResult = (value: string | CommandResult) =>
  typeof value === 'string' ? ok(value) : value;

function fakeCtx(options: FakeOptions = {}) {
  const format = options.format ?? 'toml';
  const path = CONFIG_PATHS[format];
  const judge = vi.fn(async (args: JudgeInput): Promise<JudgeResult> => {
    if (
      args.input.startsWith('Ground truth observed by the harness') &&
      options.reportVerdict
    ) {
      return options.reportVerdict;
    }
    return { passed: true, notes: 'judge ok' };
  });
  const exec = vi.fn(async (command: string): Promise<CommandResult> => {
    if (command === `cat '${path}'`) {
      return asResult(options.config ?? configFor(format));
    }
    if (command === "cat 'supabase/.env'") {
      return asResult(options.envFile ?? ENV_FILE);
    }
    if (command === "cat 'supabase/.env.local'") {
      return asResult(options.localEnv ?? MISSING('supabase/.env.local'));
    }
    if (command === "cat '.env'") {
      return asResult(options.rootEnv ?? MISSING('.env'));
    }
    if (command.startsWith('grep ')) {
      return options.grep ?? ok('./supabase/.env\n');
    }
    if (command.startsWith('d=$(mktemp')) {
      return ok((options.committed ?? []).map((file) => `${file}\n`).join(''));
    }
    if (command.startsWith('find ')) return options.find ?? ok(`${path}\n`);
    if (command.endsWith('--version')) return ok('3.2.0-beta.17\n');
    return fail(127, 'command not found');
  });
  const ctx = {
    exec,
    judge,
    toolCalls: options.toolCalls ?? [shellCall('supabase config validate')],
    transcript: [],
    environmentMarker: async () => undefined,
  } as unknown as LocalStackEvalContext;
  return { ctx, judge, exec };
}

const OPTIONS = (format: ConfigFormat) => ({
  format,
  validateConvention: true,
  localDir: new URL(`../${EVAL_DIRS[format]}/local/`, import.meta.url),
});

type Result = Awaited<ReturnType<typeof scoreConfigEdit>>;

const failedNames = (result: Result) =>
  (result.checks ?? []).filter(({ passed }) => !passed).map(({ name }) => name);

const notesOf = (result: Result, name: string) =>
  result.checks?.find((check) => check.name === name)?.notes ?? '';

const ALL_NAMES = [
  CHECK_NAMES.emailConfirmations,
  CHECK_NAMES.redirect,
  CHECK_NAMES.fileSizeLimit,
  CHECK_NAMES.github,
  CHECK_NAMES.secretNotCommitted,
  CHECK_NAMES.nothingElse,
  CHECK_NAMES.sameFile,
  CHECK_NAMES.report,
  DETOUR_CHECK_NAME,
  'metrics',
];

describe.each(['toml', 'jsonc'] as const)('scoreConfigEdit (%s)', (format) => {
  const score = (options: FakeOptions = {}) => {
    const fake = fakeCtx({ format, ...options });
    return scoreConfigEdit(fake.ctx, OPTIONS(format)).then((result) => ({
      result,
      ...fake,
    }));
  };

  it('passes every check for a correct end state', async () => {
    const { result } = await score();

    expect(result.checks?.map(({ name }) => name)).toEqual(ALL_NAMES);
    expect(failedNames(result)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('accepts a literal client id and a MiB size', async () => {
    const { result } = await score({
      config: configFor(format, {
        size: '100MiB',
        github: { ...GITHUB_OK, client_id: GITHUB_CLIENT_ID },
      }),
    });

    expect(failedNames(result)).toEqual([]);
  });

  it('fails email confirmations when only the sms one is set', async () => {
    const { result } = await score({
      config: configFor(format, { email: false, sms: true }),
    });

    expect(failedNames(result)).toEqual([
      CHECK_NAMES.emailConfirmations,
      CHECK_NAMES.nothingElse,
    ]);
    expect(notesOf(result, CHECK_NAMES.emailConfirmations)).toContain(
      'auth.sms.enable_confirmations'
    );
  });

  it.each([
    104857600,
    100000000,
    '100MB',
    '100M',
    '100mb',
    '100MiB',
    '100 MiB',
    '102400KiB',
    '104857600',
  ])('accepts file_size_limit %j', async (size) => {
    const { result } = await score({ config: configFor(format, { size }) });

    expect(failedNames(result)).toEqual([]);
  });

  it.each(['50MiB', '1GB', '100', '100XB', 'lots', 50, true])(
    'fails file_size_limit %j',
    async (size) => {
      const { result } = await score({ config: configFor(format, { size }) });

      expect(failedNames(result)).toEqual([CHECK_NAMES.fileSizeLimit]);
    }
  );

  it('fails a literal secret in the config on the github and secret checks', async () => {
    const { result } = await score({
      config: configFor(format, {
        github: { ...GITHUB_OK, secret: GITHUB_CLIENT_SECRET },
      }),
      grep: ok(`./${CONFIG_PATHS[format]}\n./supabase/.env\n`),
      committed: [CONFIG_PATHS[format]],
    });

    expect(failedNames(result)).toEqual([
      CHECK_NAMES.github,
      CHECK_NAMES.secretNotCommitted,
    ]);
    expect(notesOf(result, CHECK_NAMES.secretNotCommitted)).toContain(
      CONFIG_PATHS[format]
    );
  });

  it('fails when the redirect replaces the seed entry', async () => {
    const { result } = await score({
      config: configFor(format, { redirects: [STAGING_CALLBACK] }),
    });

    expect(failedNames(result)).toEqual([CHECK_NAMES.nothingElse]);
    expect(notesOf(result, CHECK_NAMES.nothingElse)).toContain(
      'lost the seed entry'
    );
  });

  it('fails the redirect check when the callback is missing', async () => {
    const { result } = await score({
      config: configFor(format, { redirects: ['https://127.0.0.1:3000'] }),
    });

    expect(failedNames(result)).toEqual([CHECK_NAMES.redirect]);
  });

  it('fails nothing-else when an unknown key is added', async () => {
    const { result } = await score({
      config: configFor(format, {
        extra: { path: ['auth', 'redirect_urls'], value: [STAGING_CALLBACK] },
      }),
    });

    expect(failedNames(result)).toEqual([CHECK_NAMES.nothingElse]);
    expect(notesOf(result, CHECK_NAMES.nothingElse)).toContain(
      'auth.redirect_urls'
    );
  });

  it('fails nothing-else when github gets a key the apple block lacks', async () => {
    const { result } = await score({
      config: configFor(format, {
        github: { ...GITHUB_OK, scopes: 'read:user' },
      }),
    });

    expect(failedNames(result)).toEqual([CHECK_NAMES.nothingElse]);
    expect(notesOf(result, CHECK_NAMES.nothingElse)).toContain(
      'auth.external.github.scopes'
    );
  });

  it('fails the github check when the env var is not set', async () => {
    const { result } = await score({
      envFile: 'GITHUB_CLIENT_ID=Iv1.8a61f9b3a7aba766\nGITHUB_CLIENT_SECRET=\n',
    });

    expect(failedNames(result)).toEqual([CHECK_NAMES.github]);
    expect(notesOf(result, CHECK_NAMES.github)).toContain(
      'GITHUB_CLIENT_SECRET'
    );
  });

  it('fails when the credentials exist only in a root .env', async () => {
    const { result } = await score({
      envFile: MISSING('supabase/.env'),
      rootEnv: ENV_FILE,
      grep: ok('./.env\n'),
    });

    expect(failedNames(result)).toEqual([CHECK_NAMES.github]);
  });

  it('accepts credentials moved to an ignored supabase/.env.local', async () => {
    const { result } = await score({
      envFile: MISSING('supabase/.env'),
      localEnv: ENV_FILE,
      grep: ok('./supabase/.env.local\n'),
    });

    expect(failedNames(result)).toEqual([]);
  });

  it('accepts a renamed variable that holds the right value', async () => {
    const { result } = await score({
      config: configFor(format, {
        github: {
          ...GITHUB_OK,
          secret: 'env(SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET)',
        },
      }),
      envFile: `${ENV_FILE}SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET=${GITHUB_CLIENT_SECRET}\n`,
    });

    expect(failedNames(result)).toEqual([]);
  });

  it.each([
    [
      'swapped refs',
      {
        client_id: 'env(GITHUB_CLIENT_SECRET)',
        secret: 'env(GITHUB_CLIENT_ID)',
      },
    ],
    ['secret points at the id variable', { secret: 'env(GITHUB_CLIENT_ID)' }],
    ['client id is a different literal', { client_id: 'Iv1.other' }],
  ])('fails the github check on %s', async (_label, override) => {
    const { result } = await score({
      config: configFor(format, { github: { ...GITHUB_OK, ...override } }),
    });

    expect(failedNames(result)).toEqual([CHECK_NAMES.github]);
  });

  it('fails the github check when the env file holds a placeholder secret', async () => {
    const { result } = await score({
      envFile: `GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}\nGITHUB_CLIENT_SECRET=your-github-client-secret\n`,
      grep: fail(1),
    });

    expect(failedNames(result)).toEqual([
      CHECK_NAMES.github,
      CHECK_NAMES.secretNotCommitted,
    ]);
  });

  it.each(['supabase/.env.example', 'supabase/.env.staging'])(
    'fails the secret check when the secret is committed in %s',
    async (file) => {
      const { result } = await score({
        grep: ok(`./supabase/.env\n./${file}\n`),
        committed: [file],
      });

      expect(failedNames(result)).toEqual([CHECK_NAMES.secretNotCommitted]);
      expect(notesOf(result, CHECK_NAMES.secretNotCommitted)).toContain(file);
    }
  );

  it('passes the secret check when the secret sits only in ignored files', async () => {
    const { result } = await score({
      grep: ok('./supabase/.env\n./supabase/.env.local\n'),
    });

    expect(failedNames(result)).toEqual([]);
  });

  it.each([
    ['redirect_uri', 'https://staging.orders-app.dev/auth/callback'],
    ['url', 'https://github.com'],
  ])('fails nothing-else when github sets %s', async (key, value) => {
    const { result } = await score({
      config: configFor(format, { github: { ...GITHUB_OK, [key]: value } }),
    });

    expect(failedNames(result)).toEqual([CHECK_NAMES.nothingElse]);
    expect(notesOf(result, CHECK_NAMES.nothingElse)).toContain(
      `auth.external.github.${key}`
    );
  });

  it('allows github keys left at the seed block defaults', async () => {
    const { result } = await score({
      config: configFor(format, {
        github: { ...GITHUB_OK, redirect_uri: '', skip_nonce_check: false },
      }),
    });

    expect(failedNames(result)).toEqual([]);
  });

  it('fails the github check when it is not enabled or not configured', async () => {
    const disabled = await score({
      config: configFor(format, { github: { ...GITHUB_OK, enabled: 'true' } }),
    });
    const absent = await score({ config: configFor(format, { github: null }) });

    expect(failedNames(disabled.result)).toEqual([CHECK_NAMES.github]);
    expect(failedNames(absent.result)).toEqual([CHECK_NAMES.github]);
  });

  it('fails the same-file check when the config was converted or backed up', async () => {
    const other = format === 'toml' ? 'config.jsonc' : 'config.toml';
    const { result } = await score({
      find: ok(
        `${CONFIG_PATHS[format]}\nsupabase/${other}\nsupabase/config.toml.bak\n`
      ),
    });

    expect(failedNames(result)).toEqual([CHECK_NAMES.sameFile]);
  });

  it('fails every config check when the seeded file is gone', async () => {
    const { result } = await score({
      config: MISSING(CONFIG_PATHS[format]),
      find: ok('supabase/config.json\n'),
    });

    expect(failedNames(result)).toEqual([
      CHECK_NAMES.emailConfirmations,
      CHECK_NAMES.redirect,
      CHECK_NAMES.fileSizeLimit,
      CHECK_NAMES.github,
      CHECK_NAMES.nothingElse,
      CHECK_NAMES.sameFile,
    ]);
    expect(notesOf(result, CHECK_NAMES.redirect)).toContain('is missing');
  });

  it('fails every config check with a clear note when the file does not parse', async () => {
    const { result } = await score({ config: '{ "auth": [\n[[broken' });

    expect(failedNames(result)).toEqual([
      CHECK_NAMES.emailConfirmations,
      CHECK_NAMES.redirect,
      CHECK_NAMES.fileSizeLimit,
      CHECK_NAMES.github,
      CHECK_NAMES.nothingElse,
    ]);
    expect(notesOf(result, CHECK_NAMES.emailConfirmations)).toContain(
      'does not parse'
    );
  });

  it('fails the secret check when the workspace cannot be searched', async () => {
    const { result } = await score({ grep: fail(2, 'grep: boom') });

    expect(failedNames(result)).toEqual([CHECK_NAMES.secretNotCommitted]);
  });

  it('fails the secret check when the scan finds the secret nowhere', async () => {
    const { result } = await score({ grep: fail(1) });

    expect(failedNames(result)).toEqual([CHECK_NAMES.secretNotCommitted]);
    expect(notesOf(result, CHECK_NAMES.secretNotCommitted)).toContain(
      'cannot be trusted'
    );
  });

  it('fails the report check on a false report and grounds the judge in the facts', async () => {
    const { result, judge } = await score({
      config: configFor(format, { email: false }),
      reportVerdict: { passed: false, notes: 'claimed email confirmations' },
    });

    expect(failedNames(result)).toEqual([
      CHECK_NAMES.emailConfirmations,
      CHECK_NAMES.report,
    ]);
    const input = judge.mock.calls
      .map(([args]) => args.input)
      .find((text) => text.startsWith('Ground truth'));
    expect(input).toContain(`- ${CHECK_NAMES.emailConfirmations}: failed`);
    expect(input).toContain(`- ${CHECK_NAMES.github}: passed`);
    expect(input).not.toContain(GITHUB_CLIENT_SECRET);
  });

  it('records validate usage in the metrics', async () => {
    const { result } = await score({
      toolCalls: [
        shellCall('supabase config validate', 'exit 1'),
        shellCall('supabase config validate'),
        shellCall('supabase start'),
      ],
    });

    expect(JSON.parse(notesOf(result, 'metrics'))).toMatchObject({
      format,
      validateConvention: true,
      validateRuns: 2,
      validateFailures: 1,
      otherConfigRuns: 1,
      otherConfigFailures: 0,
      ranValidate: true,
      commentsKept: 1,
      cliVersion: '3.2.0-beta.17',
    });
  });
});

describe('scoreConfigEdit failures', () => {
  it('returns one failing check when the scorer cannot read the marker', async () => {
    const { ctx } = fakeCtx();
    ctx.environmentMarker = async () => {
      throw new Error('marker unreadable');
    };

    expect(await scoreConfigEdit(ctx, OPTIONS('toml'))).toEqual({
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the config edit',
          passed: false,
          notes: 'marker unreadable',
        },
      ],
    });
  });
});

describe('JSONC parsing', () => {
  it('accepts comments and trailing commas in the agent file', async () => {
    const text = `{
  // keep me
  "auth": {
    "email": { "enable_confirmations": true, },
  },
}`;
    const { ctx } = fakeCtx({ format: 'jsonc', config: text });

    const result = await scoreConfigEdit(ctx, OPTIONS('jsonc'));

    expect(notesOf(result, CHECK_NAMES.emailConfirmations)).toBe('');
    expect(notesOf(result, CHECK_NAMES.redirect)).not.toContain(
      'does not parse'
    );
  });
});
