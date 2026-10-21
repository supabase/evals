// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-003-set-and-list-secrets
import { createHash } from 'node:crypto';
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
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

function shell(
  command: string,
  result?: unknown,
  error?: string
): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result,
    error,
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
const NO_TOKEN =
  'Access token not provided. Supply an access token by running `supabase login` or setting the SUPABASE_ACCESS_TOKEN environment variable.';
const ERRORED = 'the `supabase secrets list` after the last set errored and';
const didNotShow = (names: string) => `${ERRORED} didn't show ${names}`;
const showedOnly = (shown: string, names: string) =>
  `${ERRORED} showed only ${shown} and didn't show ${names}`;

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

describe('checkListedAfterSet reading a call that exited non-zero', () => {
  const CHAINED_LIST = `${LIST} && ${LIST} -o json | jq -e 'length == 3'`;

  it('reads the list table from the error of a call that exited non-zero', () => {
    expect(
      check([
        shell(SET_FILE, SET_DONE),
        shell(CHAINED_LIST, undefined, listTable()),
      ])
    ).toMatchObject({ passed: true });
  });

  it('reads names split between a call result and its error', () => {
    expect(
      check([
        shell(SET_FILE, SET_DONE),
        shell(
          CHAINED_LIST,
          listTable(['RESEND_API_KEY']),
          listTable(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'])
        ),
      ]).passed
    ).toBe(true);
  });

  it('fails a list whose error shows only some names, naming the rest', () => {
    expect(
      check([
        shell(SET_FILE, SET_DONE),
        shell(
          CHAINED_LIST,
          undefined,
          listTable(['RESEND_API_KEY', 'STRIPE_SECRET_KEY'])
        ),
      ])
    ).toMatchObject({
      passed: false,
      notes:
        "the 2 `supabase secrets list` runs after the last set errored and showed only RESEND_API_KEY, STRIPE_SECRET_KEY and didn't show STRIPE_WEBHOOK_SECRET",
    });
  });
});

describe('checkListedAfterSet crediting a clean list that checked against the expected names', () => {
  const SET = `/bin/bash -lc '${SET_FILE}'`;
  const checkedExpected = (call: number) =>
    `\`supabase secrets list\` in tool call ${call} exited cleanly while checking against the expected names`;
  const showedEveryName = (call: number) =>
    `\`supabase secrets list\` in tool call ${call} showed every secret name`;

  it.each([
    [
      'a list piped to a name count',
      `/bin/bash -lc "supabase secrets list -o json | jq -r '.[].name' | grep -cxE 'RESEND_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET'"`,
      '3\n',
    ],
    [
      'a comm diff that prints a summary',
      `/bin/bash -lc "missing=\\$(comm -23 <(grep -v '^#' supabase/functions/.env.production | cut -d= -f1 | sort) <(supabase secrets list -o json | jq -r '.[].name' | sort)); [ -z \\"\\$missing\\" ] && echo 'all 3 present' || echo \\"missing: \\$missing\\""`,
      'all 3 present\n',
    ],
    [
      'a jq -e contains that exited cleanly',
      `supabase secrets list -o json | jq -e 'map(.name) | contains(["RESEND_API_KEY","STRIPE_SECRET_KEY","STRIPE_WEBHOOK_SECRET"])'`,
      'true\n',
    ],
  ])('passes %s', (_label, command, output) => {
    expect(check([shell(SET, SET_DONE), shell(command, output)])).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: true,
      notes: checkedExpected(2),
    });
  });

  it('credits a list chained after a set when its output shows every name', () => {
    expect(
      check([shell(`${SET_FILE} && ${LIST}`, `${SET_DONE}\n${listTable()}`)])
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: true,
      notes: showedEveryName(1),
    });
  });

  it('still reads a comparison against the production file that follows a chained set', () => {
    expect(
      check([
        shell(
          `${SET_FILE} && comm -23 <(cut -d= -f1 supabase/functions/.env.production | sort) <(${LIST} -o json | jq -r '.[].name' | sort)`,
          ''
        ),
      ])
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: true,
      notes: checkedExpected(1),
    });
  });

  it('says the list showed every name when it did, even though it also exited cleanly', () => {
    expect(check(setThenList(LIST)).notes).toBe(showedEveryName(2));
  });

  it('passes a clean list that checked the names after an errored one', () => {
    expect(
      check([
        shell(SET_FILE, SET_DONE),
        shell(LIST, undefined, NO_TOKEN),
        shell(
          `supabase secrets list -o json | jq -e 'map(.name) | contains(["RESEND_API_KEY","STRIPE_SECRET_KEY","STRIPE_WEBHOOK_SECRET"])'`,
          'true\n'
        ),
      ])
    ).toMatchObject({ passed: true, notes: checkedExpected(3) });
  });

  it('keeps crediting an errored list whose error holds the whole table', () => {
    expect(
      check([shell(SET_FILE, SET_DONE), shell(LIST, undefined, listTable())])
    ).toMatchObject({ passed: true, notes: showedEveryName(2) });
  });

  it('fails a list whose call errored and named none of the secrets', () => {
    expect(
      check([shell(SET_FILE, SET_DONE), shell(LIST, undefined, NO_TOKEN)])
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes: didNotShow(
        'RESEND_API_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET'
      ),
    });
  });

  it('does not credit a clean list that ran before the last set', () => {
    expect(
      check([
        shell(SET_FILE, SET_DONE),
        shell(LIST, '3\n'),
        shell(SET_FILE, SET_DONE),
        shell(LIST, undefined, NO_TOKEN),
      ])
    ).toMatchObject({ passed: false });
  });

  it('does not credit an errored list that checked against the expected names', () => {
    expect(
      check([
        shell(SET_FILE, SET_DONE),
        shell(
          `supabase secrets list -o json | jq -e 'map(.name) | contains(["RESEND_API_KEY","STRIPE_SECRET_KEY","STRIPE_WEBHOOK_SECRET"])'`,
          undefined,
          'jq: error: connection refused'
        ),
      ])
    ).toMatchObject({ passed: false });
  });
});

describe('checkListedAfterSet crediting a list saved to a file and read back', () => {
  const SET = `/bin/bash -lc '${SET_FILE}'`;
  const savedList = (redirect: string) =>
    `/bin/bash -lc 'supabase secrets list ${redirect}'`;
  const readBack = (list: number, read: number) =>
    `\`supabase secrets list\` in tool call ${list} saved its output to a file that tool call ${read} read back showing every secret name`;

  it.each([
    [
      'a > redirect with stderr merged',
      '> /tmp/secrets.txt 2>&1',
      'cat /tmp/secrets.txt',
    ],
    ['a >> redirect', '>> /tmp/secrets.txt', 'cat /tmp/secrets.txt'],
    ['a redirect with no space', '>/tmp/secrets.txt', 'cat /tmp/secrets.txt'],
    ['a relative path read back with ./', '> secrets.txt', 'cat ./secrets.txt'],
    [
      'a read-back that filters the file',
      '> /tmp/secrets.txt',
      "grep -E 'API_KEY|SECRET' /tmp/secrets.txt",
    ],
  ])('passes %s', (_label, redirect, read) => {
    expect(
      check([
        shell(SET, SET_DONE),
        shell(savedList(redirect), ''),
        shell(`/bin/bash -lc '${read}'`, listTable()),
      ])
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: true,
      notes: readBack(2, 3),
    });
  });

  it.each([
    [
      'a pipeline',
      `supabase secrets list -o json | jq -r '.[].name' > names.txt`,
    ],
    [
      'a pipeline inside a double-quoted wrapper',
      `/bin/bash -lc "supabase secrets list -o json | jq -r '.[].name' > names.txt"`,
    ],
    [
      'a pipeline of three stages',
      `supabase secrets list -o json | jq -r '.[].name' | sort >> names.txt`,
    ],
  ])('passes a list saved by the last stage of %s', (_label, list) => {
    expect(
      check([
        shell(SET, SET_DONE),
        shell(list, ''),
        shell('cat names.txt', `${SECRET_NAMES.join('\n')}\n`),
      ])
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: true,
      notes: readBack(2, 3),
    });
  });

  it('passes a read-back that is not the call right after the list', () => {
    expect(
      check([
        shell(SET, SET_DONE),
        shell(savedList('> /tmp/secrets.txt 2>&1'), ''),
        shell('ls -l /tmp/secrets.txt', '-rw-r--r-- 1 u g 300 secrets.txt'),
        shell('cat /tmp/secrets.txt', listTable()),
      ])
    ).toMatchObject({ passed: true, notes: readBack(2, 4) });
  });

  it('passes a read-back of a list whose own call carries an error', () => {
    expect(
      check([
        shell(SET, SET_DONE),
        shell(savedList('> /tmp/secrets.txt 2>&1'), '', 'exit status 1'),
        shell('cat /tmp/secrets.txt', listTable()),
      ])
    ).toMatchObject({ passed: true, notes: readBack(2, 3) });
  });
});

describe('checkListedAfterSet refusing a clean exit that checked nothing', () => {
  const SET = `/bin/bash -lc '${SET_FILE}'`;
  const UNCHECKED =
    'the `supabase secrets list` after the last set exited cleanly without checking against the expected names';
  const savedList = (redirect: string) =>
    `/bin/bash -lc 'supabase secrets list ${redirect}'`;
  const allNames = SECRET_NAMES.join(', ');

  it('fails a list whose output was discarded and reported as ok', () => {
    expect(
      check([
        shell(SET, SET_DONE),
        shell(
          `/bin/bash -lc 'supabase secrets list >/dev/null 2>&1 && echo "secrets list ok"'`,
          'secrets list ok\n'
        ),
      ])
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes: `${UNCHECKED}, and didn't show ${allNames}`,
    });
  });

  it('fails a list truncated by head, naming the one name it showed', () => {
    expect(
      check([
        shell(SET, SET_DONE),
        shell(
          `/bin/bash -lc 'supabase secrets list | head -n 3'`,
          listTable(['RESEND_API_KEY'])
        ),
      ])
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes: `${UNCHECKED}, and showed only RESEND_API_KEY and didn't show STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET`,
    });
  });

  it('fails a failed list piped into jq that exited zero with an error text', () => {
    expect(
      check([
        shell(SET, SET_DONE),
        shell(
          `/bin/bash -lc "supabase secrets list -o json | jq -r '.[].name'"`,
          'Unexpected error retrieving project secrets: 503 Service Unavailable\n'
        ),
      ])
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes: `${UNCHECKED}, and didn't show ${allNames}`,
    });
  });

  it('fails a clean list when the other list errored, saying both states', () => {
    expect(
      check([
        shell(SET, SET_DONE),
        shell(LIST, undefined, NO_TOKEN),
        shell(`${LIST} | head -n 3`, listTable(['RESEND_API_KEY'])),
      ])
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes:
        "the 2 `supabase secrets list` runs after the last set errored or exited cleanly without checking against the expected names, and showed only RESEND_API_KEY and didn't show STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET",
    });
  });

  it('judges the clean list that showed the most names when several came after the set', () => {
    expect(
      check([
        shell(SET, SET_DONE),
        shell(`${LIST} | head -n 3`, listTable(['RESEND_API_KEY'])),
        shell(
          `${LIST} | head -n 4`,
          listTable(['RESEND_API_KEY', 'STRIPE_SECRET_KEY'])
        ),
      ])
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes:
        "the 2 `supabase secrets list` runs after the last set exited cleanly without checking against the expected names, and showed only RESEND_API_KEY, STRIPE_SECRET_KEY and didn't show STRIPE_WEBHOOK_SECRET",
    });
  });

  it.each([
    [
      'the file holds an access-token error',
      [
        shell(savedList('> /tmp/secrets.txt 2>&1; echo exit=$?'), 'exit=1\n'),
        shell(`/bin/bash -lc 'cat /tmp/secrets.txt'`, NO_TOKEN),
      ],
    ],
    [
      'the read-back call does not mention the file',
      [
        shell(savedList('> /tmp/secrets.txt 2>&1'), ''),
        shell('cat /tmp/other.txt', listTable()),
      ],
    ],
    [
      'the read-back names only some of the secrets',
      [
        shell(savedList('> /tmp/secrets.txt 2>&1'), ''),
        shell('cat /tmp/secrets.txt', listTable(['RESEND_API_KEY'])),
      ],
    ],
    [
      'the read-back came before the list',
      [
        shell('cat /tmp/secrets.txt', listTable()),
        shell(savedList('> /tmp/secrets.txt 2>&1'), ''),
      ],
    ],
    [
      'the read-back only mentions a longer file name',
      [
        shell(savedList('> /tmp/secrets.txt 2>&1'), ''),
        shell('cat /tmp/secrets.txt.bak', listTable()),
      ],
    ],
    [
      'only stderr was redirected',
      [
        shell(savedList('2> /tmp/secrets.txt'), ''),
        shell('cat /tmp/secrets.txt', listTable()),
      ],
    ],
  ])('fails a saved list when %s', (_label, calls) => {
    const { passed, notes } = check([shell(SET, SET_DONE), ...calls]);
    expect(passed).toBe(false);
    expect(notes).toContain('without checking against the expected names');
  });

  it('fails a saved list whose call errored and whose file holds an access-token error', () => {
    expect(
      check([
        shell(SET, SET_DONE),
        shell(savedList('> /tmp/secrets.txt 2>&1'), '', 'exit status 1'),
        shell('cat /tmp/secrets.txt', NO_TOKEN),
      ])
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes: didNotShow(allNames),
    });
  });

  const NOTHING_SHOWN = `didn't show ${allNames}`;

  it.each([
    ['discarded', `${SET_FILE} && ${LIST} >/dev/null`, '', NOTHING_SHOWN],
    [
      'truncated by head',
      `${SET_FILE} && ${LIST} | head -n 3`,
      listTable(['RESEND_API_KEY']),
      "showed only RESEND_API_KEY and didn't show STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET",
    ],
    [
      'chained after per-name sets',
      `supabase secrets set RESEND_API_KEY="$RESEND_API_KEY" STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" STRIPE_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET" && ${LIST} >/dev/null`,
      '',
      NOTHING_SHOWN,
    ],
    [
      'chained after an unset',
      `supabase secrets unset RESEND_API_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET && ${LIST} >/dev/null`,
      '',
      NOTHING_SHOWN,
    ],
  ])(
    'fails a list %s whose call also holds the write that names the expected names',
    (_label, command, output, detail) => {
      expect(check([shell(command, output)])).toEqual({
        name: CONFIRM_CHECK_NAME,
        passed: false,
        notes: `${UNCHECKED}, and ${detail}`,
      });
    }
  );

  it('fails a pipeline whose redirect follows a break after the list', () => {
    expect(
      check([
        shell(SET, SET_DONE),
        shell(`${LIST} -o json | jq -r '.[].name'; echo done > names.txt`, ''),
        shell('cat names.txt', `${SECRET_NAMES.join('\n')}\n`),
      ]).passed
    ).toBe(false);
  });

  it('fails a pipeline saved to a file read back with only two of the names', () => {
    expect(
      check([
        shell(SET, SET_DONE),
        shell(`${LIST} -o json | jq -r '.[].name' > names.txt`, ''),
        shell('cat names.txt', 'RESEND_API_KEY\nSTRIPE_SECRET_KEY\n'),
      ])
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes: `${UNCHECKED}, and didn't show ${allNames}`,
    });
  });

  it('fails a pipeline whose last stage discards its output', () => {
    expect(
      check([
        shell(SET, SET_DONE),
        shell(`${LIST} -o json | jq -r '.[].name' > /dev/null`, ''),
        shell('cat /dev/null', `${SECRET_NAMES.join('\n')}\n`),
      ]).passed
    ).toBe(false);
  });

  it('fails a list redirected to /dev/null followed by a call that prints the names from the production file', () => {
    expect(
      check([
        shell(SET, SET_DONE),
        shell(savedList('> /dev/null 2>&1'), ''),
        shell(
          'cut -d= -f1 supabase/functions/.env.production',
          `${SECRET_NAMES.join('\n')}\n`
        ),
      ])
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes: `${UNCHECKED}, and didn't show ${allNames}`,
    });
  });

  it('fails a list redirected to /dev/null even when a later call mentions /dev/null and shows the names', () => {
    expect(
      check([
        shell(SET, SET_DONE),
        shell(savedList('>/dev/null'), ''),
        shell('cat /dev/null; echo done', listTable()),
      ]).passed
    ).toBe(false);
  });
});

describe('checkListedAfterSet reading ANSI-styled output', () => {
  const styledTable = (open: string) =>
    [
      'NAME | DIGEST',
      ...SECRET_NAMES.map(
        (name) => `${open}${name}\x1b[0m | ${fakeDigest(name)}`
      ),
    ].join('\n');

  it.each([
    ['bold', '\x1b[1m'],
    ['a colour with two parameters', '\x1b[1;32m'],
    ['a 256-colour foreground', '\x1b[38;5;2m'],
  ])(
    'passes a list table whose names are wrapped in %s codes',
    (_label, open) => {
      expect(check(setThenListWith(LIST, styledTable(open))).passed).toBe(true);
    }
  );

  it('reads names that GNU grep --color=always wrapped in SGR and erase-line sequences', () => {
    const gnu = SECRET_NAMES.map(
      (name) => `\x1b[01;31m\x1b[K${name}\x1b[m\x1b[K | ${fakeDigest(name)}`
    ).join('\n');
    expect(
      check([
        shell(SET_FILE, SET_DONE),
        shell(
          `/bin/bash -lc "supabase secrets list | grep --color=always -E 'RESEND_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET'"`,
          undefined,
          gnu
        ),
      ])
    ).toMatchObject({
      passed: true,
      notes: '`supabase secrets list` in tool call 2 showed every secret name',
    });
  });

  it('still fails a name that is only a prefix of a longer styled name', () => {
    expect(
      check([
        shell(SET_FILE, SET_DONE),
        shell(
          LIST,
          undefined,
          `\x1b[1mRESEND_API_KEY\x1b[0m\n\x1b[1mSTRIPE_SECRET_KEY_BACKUP\x1b[0m\n\x1b[1mSTRIPE_WEBHOOK_SECRET\x1b[0m`
        ),
      ])
    ).toMatchObject({
      passed: false,
      notes: showedOnly(
        'RESEND_API_KEY, STRIPE_WEBHOOK_SECRET',
        'STRIPE_SECRET_KEY'
      ),
    });
  });
});

describe('checkListedAfterSet with pre-parsed invocations', () => {
  const calls = setThenList(LIST);
  const parsed = findSupabaseInvocations(extractCommandEntries(calls));

  it('credits the invocations it is given', () => {
    expect(checkListedAfterSet(true, calls, parsed).passed).toBe(true);
  });

  it('reads the invocations it is given rather than parsing the calls again', () => {
    expect(checkListedAfterSet(true, calls, [])).toMatchObject({
      passed: false,
      notes: NO_SET,
    });
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

  it('fails an errored list that did not show one name, naming it and the names it showed', () => {
    expect(
      check([
        shell(SET_FILE, SET_DONE),
        shell(
          LIST,
          undefined,
          listTable(['RESEND_API_KEY', 'STRIPE_SECRET_KEY'])
        ),
      ])
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes: showedOnly(
        'RESEND_API_KEY, STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET'
      ),
    });
  });

  it('names every name an errored list showed and every name it did not', () => {
    const { notes } = check([
      shell(SET_FILE, SET_DONE),
      shell(LIST, undefined, listTable(['RESEND_API_KEY'])),
    ]);
    expect(notes).toBe(
      showedOnly('RESEND_API_KEY', 'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET')
    );
  });

  it('judges the errored list that showed the most names when several came after the set', () => {
    const { notes } = check([
      shell(SET_FILE, SET_DONE),
      shell(
        LIST,
        undefined,
        listTable(['RESEND_API_KEY', 'STRIPE_SECRET_KEY'])
      ),
      shell(LIST, undefined, listTable(['RESEND_API_KEY'])),
    ]);
    expect(notes).toBe(
      "the 2 `supabase secrets list` runs after the last set errored and showed only RESEND_API_KEY, STRIPE_SECRET_KEY and didn't show STRIPE_WEBHOOK_SECRET"
    );
  });

  it('does not credit a list that showed all three names before the last set', () => {
    expect(
      check([
        shell(SET_FILE, SET_DONE),
        shell(LIST, listTable()),
        shell(SET_FILE, SET_DONE),
        shell(LIST, undefined, listTable(['RESEND_API_KEY'])),
      ])
    ).toMatchObject({ passed: false });
  });

  it('counts a name only as a whole word in the list output', () => {
    expect(
      check([
        shell(SET_FILE, SET_DONE),
        shell(
          LIST,
          undefined,
          listTable([
            'RESEND_API_KEY',
            'STRIPE_SECRET_KEY_BACKUP',
            'STRIPE_WEBHOOK_SECRET',
          ])
        ),
      ])
    ).toEqual({
      name: CONFIRM_CHECK_NAME,
      passed: false,
      notes: showedOnly(
        'RESEND_API_KEY, STRIPE_WEBHOOK_SECRET',
        'STRIPE_SECRET_KEY'
      ),
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])(
    'treats an errored list with a result of %s as showing no names',
    (_label, result) => {
      expect(
        check([shell(SET_FILE, SET_DONE), shell(LIST, result, NO_TOKEN)])
      ).toEqual({
        name: CONFIRM_CHECK_NAME,
        passed: false,
        notes: didNotShow(SECRET_NAMES.join(', ')),
      });
    }
  );

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
