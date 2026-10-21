// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-003-set-and-list-secrets
import { createHash } from 'node:crypto';
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { CONFIRM_CHECK_NAME, checkListedAfterSet } from './confirm.js';
import { NO_HOSTED_PROJECT } from './hosted.js';
import { SECRET_NAMES } from './seed.js';

const REF = 'abcdefghijklmnopqrst';
const SET_FILE =
  'supabase secrets set --env-file supabase/functions/.env.production';
const SET_DONE = 'Finished supabase secrets set.';
const LIST = 'supabase secrets list';

const fakeDigest = (name: string) =>
  createHash('sha256').update(name).digest('hex');

const listTable = (names: readonly string[] = SECRET_NAMES) =>
  [
    'NAME | DIGEST',
    '-----|-------',
    ...names.map((name) => `${name} | ${fakeDigest(name)}`),
  ].join('\n');

const listJson = (names: readonly string[] = SECRET_NAMES) =>
  JSON.stringify(
    names.map((name) => ({
      name,
      updated_at: '2026-10-20T10:00:00.000Z',
      value: fakeDigest(name),
    }))
  );

function shell(command: string, result?: unknown): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result,
    ts: 0,
  };
}

const patch: ToolCallRecord = {
  tool: { kind: 'other', toolName: 'apply_patch' },
  body: { input: '*** Begin Patch\n*** End Patch' },
  result: 'Done!',
  ts: 0,
};

const setThenListWith = (listCommand: string, listResult: unknown) => [
  shell(SET_FILE, SET_DONE),
  shell(listCommand, listResult),
];

const setThenList = (listCommand: string) =>
  setThenListWith(listCommand, listTable());

const check = (calls: ToolCallRecord[], hosted = true) =>
  checkListedAfterSet(hosted, calls);

const NO_SET = 'no `supabase secrets set` ran';
const NO_LIST_AFTER_SET =
  'no `supabase secrets list` ran after the last `supabase secrets set`';
const didNotShow = (names: string) =>
  `the \`supabase secrets list\` after the last set didn't show: ${names}`;

describe('CONFIRM_CHECK_NAME', () => {
  it('names the confirm half of the journey', () => {
    expect(CONFIRM_CHECK_NAME).toBe(
      "the agent listed the project's secrets after setting them"
    );
  });
});

describe('checkListedAfterSet passing runs', () => {
  it('passes a set from the production file followed by a list that shows all three names', () => {
    expect(check(setThenList(LIST))).toMatchObject({
      name: CONFIRM_CHECK_NAME,
      passed: true,
    });
  });

  it('names the list tool call by its 1-based position among the command calls', () => {
    const result = check([
      patch,
      shell('ls -a supabase/functions', '.env.production'),
      shell(SET_FILE, SET_DONE),
      shell(LIST, listTable()),
    ]);
    expect(result.passed).toBe(true);
    expect(result.notes).toMatch(/\b3\b/);
    expect(result.notes).not.toMatch(/\b4\b/);
  });

  it('reads the command from body.command when the record has no command field', () => {
    const bodyOnly = (command: string, result: string): ToolCallRecord => ({
      tool: { kind: 'other', toolName: 'shell' },
      body: { command },
      result,
      ts: 0,
    });
    expect(
      check([bodyOnly(SET_FILE, SET_DONE), bodyOnly(LIST, listTable())]).passed
    ).toBe(true);
  });

  it('passes a set and a list chained in one call when its output shows all three names', () => {
    expect(
      check([shell(`${SET_FILE} && ${LIST}`, `${SET_DONE}\n${listTable()}`)])
        .passed
    ).toBe(true);
  });

  it('passes a list that printed JSON', () => {
    expect(check(setThenListWith(`${LIST} -o json`, listJson())).passed).toBe(
      true
    );
  });

  it('passes a list whose result is a structured object holding the names', () => {
    expect(check(setThenListWith(LIST, JSON.parse(listJson()))).passed).toBe(
      true
    );
  });

  it('passes through npx with a dist-tag', () => {
    expect(
      check([
        shell(
          'npx supabase@latest secrets set --env-file supabase/functions/.env.production',
          SET_DONE
        ),
        shell('npx supabase@latest secrets list', listTable()),
      ]).passed
    ).toBe(true);
  });

  it('passes a list with --project-ref before the verb', () => {
    expect(
      check(setThenList(`supabase --project-ref ${REF} secrets list`)).passed
    ).toBe(true);
  });

  it('passes three per-name sets followed by one list', () => {
    expect(
      check([
        shell(
          'supabase secrets set RESEND_API_KEY="$RESEND_API_KEY"',
          SET_DONE
        ),
        shell(
          'supabase secrets set STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY"',
          SET_DONE
        ),
        shell(
          'supabase secrets set STRIPE_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET"',
          SET_DONE
        ),
        shell(LIST, listTable()),
      ]).passed
    ).toBe(true);
  });

  it('passes a set run from inside supabase/functions with a relative env file', () => {
    expect(
      check([
        shell(
          'cd supabase/functions && supabase secrets set --env-file .env.production',
          SET_DONE
        ),
        shell(LIST, listTable()),
      ]).passed
    ).toBe(true);
  });

  it('passes when a later list shows all three names even though an earlier one did not', () => {
    expect(
      check([
        shell(SET_FILE, SET_DONE),
        shell(LIST, listTable(['RESEND_API_KEY'])),
        shell(LIST, listTable()),
      ]).passed
    ).toBe(true);
  });

  it('passes a list that shows extra names beside the three', () => {
    expect(
      check(setThenListWith(LIST, listTable([...SECRET_NAMES, 'SENTRY_DSN'])))
        .passed
    ).toBe(true);
  });

  it('passes a set that is followed by a list in a bash -lc wrapper', () => {
    expect(check(setThenList(`bash -lc '${LIST}'`)).passed).toBe(true);
  });
});

describe('checkListedAfterSet reading the verb past global flags', () => {
  it.each([
    [
      '--project-ref value before the verb',
      `--project-ref ${REF} secrets list`,
    ],
    [
      '--project-ref=value before the verb',
      `--project-ref=${REF} secrets list`,
    ],
    [
      '--project-ref between secrets and list',
      `secrets --project-ref ${REF} list`,
    ],
    ['--project-ref after the verb', `secrets list --project-ref ${REF}`],
    ['--project-ref=value after the verb', `secrets list --project-ref=${REF}`],
    ['--workdir', '--workdir app secrets list'],
    ['--profile', '--profile staging secrets list'],
    ['--log-level', '--log-level debug secrets list'],
    ['--agent', '--agent codex secrets list'],
    ['--dns-resolver', '--dns-resolver https secrets list'],
    ['--network-id', '--network-id net1 secrets list'],
    ['-o', '-o json secrets list'],
    ['--output', '--output json secrets list'],
    ['--output-format', '--output-format json secrets list'],
    ['--env-file', '--env-file .env.production secrets list'],
    ['a boolean flag', '--debug secrets list'],
    ['--workdir=value', '--workdir=app secrets list'],
  ])('counts a list run with %s', (_label, args) => {
    expect(check(setThenList(`supabase ${args}`)).passed).toBe(true);
  });

  it.each([
    [
      '--project-ref value before the verb',
      `--project-ref ${REF} secrets set --env-file .env.production`,
    ],
    ['-o', '-o json secrets set --env-file .env.production'],
    ['--workdir', '--workdir app secrets set --env-file .env.production'],
    [
      '--project-ref=value',
      `--project-ref=${REF} secrets set --env-file .env.production`,
    ],
    [
      'flags between the verb words',
      `secrets --project-ref ${REF} set --env-file .env.production`,
    ],
  ])('counts a set run with %s', (_label, args) => {
    expect(
      check([shell(`supabase ${args}`, SET_DONE), shell(LIST, listTable())])
        .passed
    ).toBe(true);
  });
});

describe('checkListedAfterSet failing runs', () => {
  it('fails when no secrets were set at all', () => {
    expect(check([shell(LIST, listTable())])).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes: NO_SET,
    });
  });

  it('fails when nothing ran', () => {
    expect(check([])).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes: NO_SET,
    });
  });

  it('fails when the secrets were set but never listed', () => {
    expect(check([shell(SET_FILE, SET_DONE)])).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes: NO_LIST_AFTER_SET,
    });
  });

  it('fails when the only list ran before the set', () => {
    expect(
      check([shell(LIST, listTable()), shell(SET_FILE, SET_DONE)])
    ).toMatchObject({ passed: false, notes: NO_LIST_AFTER_SET });
  });

  it('fails when a second set follows the list', () => {
    expect(
      check([
        shell(SET_FILE, SET_DONE),
        shell(LIST, listTable()),
        shell(SET_FILE, SET_DONE),
      ])
    ).toMatchObject({ passed: false, notes: NO_LIST_AFTER_SET });
  });

  it('fails when an unset follows the list', () => {
    expect(
      check([
        shell(SET_FILE, SET_DONE),
        shell(LIST, listTable()),
        shell('supabase secrets unset RESEND_API_KEY', 'Finished.'),
      ])
    ).toMatchObject({ passed: false, notes: NO_LIST_AFTER_SET });
  });

  it('fails when a list chained before the set in one call shows the names', () => {
    expect(
      check([shell(`${LIST} && ${SET_FILE}`, `${listTable()}\n${SET_DONE}`)])
    ).toMatchObject({ passed: false, notes: NO_LIST_AFTER_SET });
  });

  it('fails a list that did not show one name, naming it', () => {
    expect(
      check(
        setThenListWith(
          LIST,
          listTable(['RESEND_API_KEY', 'STRIPE_SECRET_KEY'])
        )
      )
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes: didNotShow('STRIPE_WEBHOOK_SECRET'),
    });
  });

  it('names every name a list did not show', () => {
    const { notes } = check(
      setThenListWith(LIST, listTable(['RESEND_API_KEY']))
    );
    expect(notes).toContain(didNotShow(''));
    expect(notes).toContain('STRIPE_SECRET_KEY');
    expect(notes).toContain('STRIPE_WEBHOOK_SECRET');
    expect(notes).not.toContain('RESEND_API_KEY');
  });

  it('judges the list that showed the most names when several came after the set', () => {
    const { notes } = check([
      shell(SET_FILE, SET_DONE),
      shell(LIST, listTable(['RESEND_API_KEY', 'STRIPE_SECRET_KEY'])),
      shell(LIST, listTable(['RESEND_API_KEY'])),
    ]);
    expect(notes).toBe(didNotShow('STRIPE_WEBHOOK_SECRET'));
  });

  it('does not credit a list that showed all three names before the last set', () => {
    expect(
      check([
        shell(SET_FILE, SET_DONE),
        shell(LIST, listTable()),
        shell(SET_FILE, SET_DONE),
        shell(LIST, listTable(['RESEND_API_KEY'])),
      ])
    ).toMatchObject({ passed: false });
  });

  it('counts a name only as a whole word in the list output', () => {
    expect(
      check(
        setThenListWith(
          LIST,
          listTable([
            'RESEND_API_KEY',
            'STRIPE_SECRET_KEY_BACKUP',
            'STRIPE_WEBHOOK_SECRET',
          ])
        )
      )
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes: didNotShow('STRIPE_SECRET_KEY'),
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('treats a list result of %s as showing no names', (_label, result) => {
    const { passed, notes } = check(setThenListWith(LIST, result));
    expect(passed).toBe(false);
    for (const name of SECRET_NAMES) expect(notes).toContain(name);
  });

  it('fails with NO_HOSTED_PROJECT without a hosted project, even for a run that would pass', () => {
    expect(check(setThenList(LIST), false)).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });

  it('fails with NO_HOSTED_PROJECT without a hosted project when nothing ran', () => {
    expect(check([], false)).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });
});

describe('checkListedAfterSet commands that do not count', () => {
  it('does not count a set that only asked for --help', () => {
    expect(
      check([
        shell('supabase secrets set --help', 'Usage: supabase secrets set'),
        shell(LIST, listTable()),
      ])
    ).toMatchObject({ passed: false, notes: NO_SET });
  });

  it('does not count a set that only asked for -h', () => {
    expect(
      check([
        shell('supabase secrets set -h', 'Usage'),
        shell(LIST, listTable()),
      ])
    ).toMatchObject({ passed: false, notes: NO_SET });
  });

  it('does not count a list that only asked for --help, even when its output names every secret', () => {
    expect(
      check([shell(SET_FILE, SET_DONE), shell(`${LIST} --help`, listTable())])
    ).toMatchObject({ passed: false, notes: NO_LIST_AFTER_SET });
  });

  it('does not count a list that only asked for -h', () => {
    expect(
      check([shell(SET_FILE, SET_DONE), shell(`${LIST} -h`, listTable())])
    ).toMatchObject({ passed: false, notes: NO_LIST_AFTER_SET });
  });

  it('does not count a --help set that follows a real list as a later write', () => {
    expect(
      check([
        shell(SET_FILE, SET_DONE),
        shell(LIST, listTable()),
        shell('supabase secrets set --help', 'Usage'),
      ]).passed
    ).toBe(true);
  });

  it('does not count an echoed command line', () => {
    expect(
      check([shell(SET_FILE, SET_DONE), shell(`echo "${LIST}"`, listTable())])
    ).toMatchObject({ passed: false, notes: NO_LIST_AFTER_SET });
  });

  it('does not count another supabase list as a secrets list', () => {
    for (const command of [
      'supabase projects list',
      'supabase functions list',
      'supabase migration list',
    ]) {
      expect(
        check([shell(SET_FILE, SET_DONE), shell(command, listTable())])
      ).toMatchObject({ passed: false, notes: NO_LIST_AFTER_SET });
    }
  });

  it('does not count a bare secrets command or an unknown secrets verb', () => {
    for (const command of [
      'supabase secrets',
      'supabase secrets get RESEND_API_KEY',
    ]) {
      expect(
        check([shell(command, ''), shell(LIST, listTable())])
      ).toMatchObject({ passed: false, notes: NO_SET });
    }
  });

  it('does not count a non-supabase command that mentions the verbs', () => {
    expect(
      check([
        shell("grep -rn 'secrets set' README.md", 'README.md:3: secrets set'),
        shell(LIST, listTable()),
      ])
    ).toMatchObject({ passed: false, notes: NO_SET });
  });
});
