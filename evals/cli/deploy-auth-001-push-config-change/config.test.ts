// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-auth-001-push-config-change
import { describe, expect, it } from 'vitest';
import { mentionsNumber } from '../lib/report.js';
import {
  CONFIG_PATH,
  checkRepoPasswordPolicy,
  parsePasswordPolicy,
  REPO_POLICY_CHECK_NAME,
  REQUIRED_MIN_PASSWORD_LENGTH,
  type RepoPasswordPolicy,
  readRepoPasswordPolicy,
} from './config.js';
import {
  configFileRoute,
  crash,
  fakeExec,
  initTemplateWith,
  MISSING_CONFIG,
  READ_CONFIG_COMMAND,
  readConfigRoute,
  SEED_CONFIG,
  seedWith,
  stderrFailure,
} from './fixtures.js';

const DOES_NOT_PARSE = 'supabase/config.toml does not parse';

const AUTH_HEADER = '[auth]';

const withMultiLineStringHolding = (position: 'before' | 'after') => {
  const decoy = `[notes]
body = """
[auth]
minimum_password_length = 10
"""
`;
  const real = `[auth]
enabled = true
minimum_password_length = 6
`;
  return position === 'before'
    ? `project_id = "orders-app"\n\n${decoy}\n${real}`
    : `project_id = "orders-app"\n\n${real}\n${decoy}`;
};

const PASSING: Array<[name: string, toml: string]> = [
  ['the seed with the length raised to 10', seedWith(10)],
  [
    'a trailing comment after the value',
    seedWith('10 # raised for the policy'),
  ],
  [
    'a header written with inner spaces',
    seedWith(10).replace(AUTH_HEADER, '[ auth ]'),
  ],
  [
    'a header written with a quoted key',
    seedWith(10).replace(AUTH_HEADER, '["auth"]'),
  ],
  [
    'an inline table at the root with no [auth] header',
    `project_id = "orders-app"
auth = { enabled = true, minimum_password_length = 10 }

[db]
major_version = 17
`,
  ],
  [
    'a dotted key at the root with no [auth] header',
    `project_id = "orders-app"
auth.minimum_password_length = 10

[db]
major_version = 17
`,
  ],
  [
    'keys reordered within [auth]',
    `project_id = "orders-app"

[auth]
password_requirements = ""
minimum_password_length = 10
enabled = true
`,
  ],
  [
    'password_requirements also set',
    seedWith(10).replace(
      'password_requirements = ""',
      'password_requirements = "letters_digits"'
    ),
  ],
  ['the number written as 10.0', seedWith('10.0')],
  ['the number written as hexadecimal 0xA', seedWith('0xA')],
  ['the number written with an underscore as 1_0', seedWith('1_0')],
  ['the full supabase init template with 10', initTemplateWith(10)],
  ['CRLF line endings', seedWith(10).replaceAll('\n', '\r\n')],
  [
    '[auth] declared after its [auth.email] sub-table',
    `[auth.email]
enable_signup = true

[auth]
minimum_password_length = 10
`,
  ],
];

const WRONG_VALUE: Array<[name: string, toml: string, value: number]> = [
  ['the unchanged seed', SEED_CONFIG, 6],
  ['a length of 8', seedWith(8), 8],
  ['a length of 12', seedWith(12), 12],
  ['a fractional length of 10.5', seedWith(10.5), 10.5],
  [
    'a commented-out 10 above the real 6',
    seedWith(6).replace(
      'minimum_password_length = 6',
      '# minimum_password_length = 10\nminimum_password_length = 6'
    ),
    6,
  ],
  [
    'a 10 under [auth.email] while [auth] holds 6',
    `${SEED_CONFIG}
[auth.email]
enable_signup = true
minimum_password_length = 10
`,
    6,
  ],
  [
    'a 10 inside a multi-line string after the real [auth]',
    withMultiLineStringHolding('after'),
    6,
  ],
  [
    'a 10 inside a multi-line string before the real [auth]',
    withMultiLineStringHolding('before'),
    6,
  ],
  [
    'the unchanged init template whose other keys hold 10',
    initTemplateWith(6),
    6,
  ],
];

const NOT_SET: Array<[name: string, toml: string]> = [
  [
    'a 10 only under [auth.email] and no key in [auth]',
    `project_id = "orders-app"

[auth]
enabled = true

[auth.email]
minimum_password_length = 10
`,
  ],
  ['no [auth] table at all', 'project_id = "orders-app"\n'],
  ['auth set to a number rather than a table', 'auth = 5\n'],
  [
    'auth declared as an array of tables',
    '[[auth]]\nminimum_password_length = 10\n',
  ],
  ['an empty file', ''],
];

const NOT_A_NUMBER: Array<[name: string, toml: string, json: string]> = [
  ['the string "10"', seedWith('"10"'), '"10"'],
  ['the boolean true', seedWith('true'), 'true'],
  ['the array [10]', seedWith('[10]'), '[10]'],
];

const UNPARSEABLE: Array<[name: string, toml: string]> = [
  ['plain garbage', 'this is not toml ['],
  [
    'the key defined twice in [auth], 6 then 10',
    seedWith(6).replace(
      'minimum_password_length = 6',
      'minimum_password_length = 6\nminimum_password_length = 10'
    ),
  ],
  ['[auth] declared twice', `${seedWith(10)}\n[auth]\nenabled = true\n`],
  ['an unterminated string value', seedWith('"10')],
];

const notesOf = (check: { notes?: string }) => check.notes ?? '';

describe('config constants', () => {
  it('keeps the check name stable for the results dashboard', () => {
    expect(CONFIG_PATH).toBe('supabase/config.toml');
    expect(REQUIRED_MIN_PASSWORD_LENGTH).toBe(10);
    expect(REPO_POLICY_CHECK_NAME).toBe(
      "the repo's Supabase config requires passwords of at least 10 characters"
    );
  });
});

describe('parsePasswordPolicy with checkRepoPasswordPolicy', () => {
  it.each(PASSING)('accepts %s', (_, toml) => {
    const policy = parsePasswordPolicy(toml);

    expect(policy).toEqual({
      ok: true,
      minPasswordLength: 10,
      conflictingRemotes: [],
    });
    expect(checkRepoPasswordPolicy(policy)).toMatchObject({
      name: REPO_POLICY_CHECK_NAME,
      passed: true,
    });
  });

  it.each(WRONG_VALUE)('rejects %s', (_, toml, value) => {
    const policy = parsePasswordPolicy(toml);

    expect(policy).toEqual({
      ok: true,
      minPasswordLength: value,
      conflictingRemotes: [],
    });
    const check = checkRepoPasswordPolicy(policy);
    expect(check).toMatchObject({
      name: REPO_POLICY_CHECK_NAME,
      passed: false,
    });
    expect(mentionsNumber(notesOf(check), value)).toBe(true);
    expect(mentionsNumber(notesOf(check), 10)).toBe(true);
  });

  it.each(NOT_SET)('reports not set for %s', (_, toml) => {
    const policy = parsePasswordPolicy(toml);

    expect(policy.ok).toBe(true);
    if (!policy.ok) return;
    expect(policy.minPasswordLength).toBeUndefined();
    const check = checkRepoPasswordPolicy(policy);
    expect(check).toMatchObject({
      name: REPO_POLICY_CHECK_NAME,
      passed: false,
    });
    expect(notesOf(check)).toContain('not set');
  });

  it.each(NOT_A_NUMBER)('rejects %s as not a number', (_, toml, json) => {
    const policy = parsePasswordPolicy(toml);

    expect(policy.ok).toBe(true);
    const check = checkRepoPasswordPolicy(policy);
    expect(check.passed).toBe(false);
    expect(notesOf(check)).toContain(json);
    expect(notesOf(check)).toMatch(/not a number/i);
  });

  it.each(UNPARSEABLE)('reports %s as not parseable', (_, toml) => {
    const policy = parsePasswordPolicy(toml);

    expect(policy.ok).toBe(false);
    if (policy.ok) return;
    expect(policy.notes.startsWith(DOES_NOT_PARSE)).toBe(true);
    const check = checkRepoPasswordPolicy(policy);
    expect(check).toMatchObject({
      name: REPO_POLICY_CHECK_NAME,
      passed: false,
    });
    expect(check.notes).toBe(policy.notes);
  });
});

const withRemotes = (base: string | number, remotes: string) =>
  `${seedWith(base)}\n${remotes}`;

const remoteAuth = (name: string, value: string | number) => `[remotes.${name}]
project_id = "abcdefghijklmnopqrst"

[remotes.${name}.auth]
minimum_password_length = ${value}
`;

describe('[remotes.<name>] overrides', () => {
  it('fails when an override of 6 would reach the project, naming the block and the value', () => {
    const policy = parsePasswordPolicy(withRemotes(10, remoteAuth('prod', 6)));

    expect(policy).toEqual({
      ok: true,
      minPasswordLength: 10,
      conflictingRemotes: [{ name: 'prod', value: 6 }],
    });
    const check = checkRepoPasswordPolicy(policy);
    expect(check).toMatchObject({
      name: REPO_POLICY_CHECK_NAME,
      passed: false,
    });
    expect(notesOf(check)).toBe(
      '[remotes.prod] overrides auth.minimum_password_length with 6'
    );
  });

  it('fails on the base value when it is 6 even though an override holds 10', () => {
    const policy = parsePasswordPolicy(withRemotes(6, remoteAuth('prod', 10)));

    expect(policy).toMatchObject({ ok: true, minPasswordLength: 6 });
    expect(checkRepoPasswordPolicy(policy)).toEqual({
      name: REPO_POLICY_CHECK_NAME,
      passed: false,
      notes: 'auth.minimum_password_length is 6, not 10',
    });
  });

  it('passes when the override also holds 10', () => {
    const policy = parsePasswordPolicy(withRemotes(10, remoteAuth('prod', 10)));

    expect(policy).toEqual({
      ok: true,
      minPasswordLength: 10,
      conflictingRemotes: [],
    });
    expect(checkRepoPasswordPolicy(policy).passed).toBe(true);
  });

  it.each([
    [
      'a remote that only overrides [db]',
      '[remotes.staging]\nproject_id = "abcdefghijklmnopqrst"\n\n[remotes.staging.db]\nmajor_version = 17\n',
    ],
    [
      'a remote whose [auth] leaves the length alone',
      '[remotes.staging.auth]\nenable_signup = false\n',
    ],
  ])('passes with %s', (_, remotes) => {
    const policy = parsePasswordPolicy(withRemotes(10, remotes));

    expect(policy).toMatchObject({ ok: true, conflictingRemotes: [] });
    expect(checkRepoPasswordPolicy(policy).passed).toBe(true);
  });

  it.each([
    ['remotes set to a number', `remotes = 5\n${seedWith(10)}`],
    [
      'remotes declared as an array of tables',
      withRemotes(10, '[[remotes]]\nproject_id = "a"\n'),
    ],
    ['a remote set to a number', withRemotes(10, '[remotes]\nprod = 5\n')],
    [
      'a remote auth set to a number',
      withRemotes(10, '[remotes.prod]\nauth = 5\n'),
    ],
  ])('ignores %s', (_, toml) => {
    const policy = parsePasswordPolicy(toml);

    expect(policy).toEqual({
      ok: true,
      minPasswordLength: 10,
      conflictingRemotes: [],
    });
    expect(checkRepoPasswordPolicy(policy).passed).toBe(true);
  });

  it('joins every conflicting override in the notes with "; "', () => {
    const policy = parsePasswordPolicy(
      withRemotes(
        10,
        `${remoteAuth('prod', 6)}\n${remoteAuth('staging', 10)}\n${remoteAuth('preview', 8)}`
      )
    );

    expect(checkRepoPasswordPolicy(policy).notes).toBe(
      '[remotes.prod] overrides auth.minimum_password_length with 6; [remotes.preview] overrides auth.minimum_password_length with 8'
    );
  });

  it('shows a non-numeric override as JSON', () => {
    const policy = parsePasswordPolicy(
      withRemotes(10, remoteAuth('prod', '"10"'))
    );

    expect(checkRepoPasswordPolicy(policy).notes).toBe(
      '[remotes.prod] overrides auth.minimum_password_length with "10"'
    );
  });
});

describe('checkRepoPasswordPolicy', () => {
  it('fails with the policy notes when the config could not be read', () => {
    const policy: RepoPasswordPolicy = {
      ok: false,
      notes: 'supabase/config.toml is missing',
    };

    expect(checkRepoPasswordPolicy(policy)).toEqual({
      name: REPO_POLICY_CHECK_NAME,
      passed: false,
      notes: 'supabase/config.toml is missing',
    });
  });

  it('fails without throwing for an integer too large for a JS number', () => {
    const policy = parsePasswordPolicy(seedWith('9007199254740993'));

    expect(() => checkRepoPasswordPolicy(policy)).not.toThrow();
    expect(checkRepoPasswordPolicy(policy).passed).toBe(false);
  });
});

describe('the seeded config.toml', () => {
  it('requires 6 and fails the repo check until the agent edits it', () => {
    const policy = parsePasswordPolicy(SEED_CONFIG);

    expect(policy).toEqual({
      ok: true,
      minPasswordLength: 6,
      conflictingRemotes: [],
    });
    expect(checkRepoPasswordPolicy(policy).passed).toBe(false);
  });
});

describe('readRepoPasswordPolicy', () => {
  it('reads supabase/config.toml with cat and parses what it prints', async () => {
    const { ctx, calls } = fakeExec([configFileRoute(seedWith(10))]);

    expect(await readRepoPasswordPolicy(ctx)).toEqual({
      ok: true,
      minPasswordLength: 10,
      conflictingRemotes: [],
    });
    expect(calls).toEqual([READ_CONFIG_COMMAND]);
  });

  it('reports a missing file as supabase/config.toml is missing', async () => {
    const { ctx } = fakeExec([readConfigRoute(MISSING_CONFIG)]);

    expect(await readRepoPasswordPolicy(ctx)).toEqual({
      ok: false,
      notes: 'supabase/config.toml is missing',
    });
  });

  it('reports any other cat failure with its exit code and stderr', async () => {
    const { ctx } = fakeExec([
      readConfigRoute(
        stderrFailure(2, 'cat: supabase/config.toml: Permission denied')
      ),
    ]);

    const policy = await readRepoPasswordPolicy(ctx);

    expect(policy.ok).toBe(false);
    if (policy.ok) return;
    expect(policy.notes).toContain('exit 2');
    expect(policy.notes).toContain('Permission denied');
    expect(policy.notes).not.toContain('is missing');
  });

  it('reports a killed cat with a null exit code as not ok', async () => {
    const { ctx } = fakeExec([
      readConfigRoute({ ok: false, exitCode: null, stdout: '', stderr: '' }),
    ]);

    const policy = await readRepoPasswordPolicy(ctx);

    expect(policy.ok).toBe(false);
    if (policy.ok) return;
    expect(policy.notes).toContain('exit null');
  });

  it('does not parse the stdout of a failed cat', async () => {
    const { ctx } = fakeExec([
      readConfigRoute({
        ok: false,
        exitCode: 1,
        stdout: seedWith(10),
        stderr: 'cat: read error',
      }),
    ]);

    expect((await readRepoPasswordPolicy(ctx)).ok).toBe(false);
  });

  it('returns not ok with the message instead of throwing when exec throws', async () => {
    const { ctx } = fakeExec([readConfigRoute(crash('sandbox gone'))]);

    const policy = await readRepoPasswordPolicy(ctx);

    expect(policy.ok).toBe(false);
    if (policy.ok) return;
    expect(policy.notes).toContain('sandbox gone');
  });
});
