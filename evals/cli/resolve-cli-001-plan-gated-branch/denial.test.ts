// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-cli-001-plan-gated-branch
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import {
  ANSI_TEXT_DENIAL,
  AUTH_FAILURE,
  BETA_JSON_DENIAL,
  BILLING_URL,
  CREATE_COMMAND,
  CREATED_OUTPUT,
  deniedCall,
  denial,
  FEATURE,
  failedCall,
  HINT,
  HINT_ONLY,
  JSON_DENIAL,
  JSON_LIST_DENIAL,
  LIST_COMMAND,
  readCall,
  shellCall,
  TEXT_DENIAL,
} from './fakes.js';
import {
  checkPlanGateDenied,
  checkUpgradeLinkPassedOn,
  DENIAL_CHECK_NAME,
  findNonCliDenialCommand,
  findPlanGateDenials,
  LINK_CHECK_NAME,
  normaliseUrl,
  readUpgradeUrls,
  toolOutputText,
} from './denial.js';
import { NO_HOSTED_PROJECT } from './hosted.js';

const NO_DENIAL = 'no Supabase CLI output carried a plan-gate denial';
const BILLING_PATH = 'supabase.com/dashboard/org/acme/billing';
const STAGING_URL = 'https://supabase.green/dashboard/org/acme/billing';
const UPGRADE_URL = 'https://supabase.com/dashboard/org/acme/upgrade';

const denialsOf = (toolCalls: ToolCallRecord[]) =>
  findPlanGateDenials(
    toolCalls,
    findSupabaseInvocations(extractCommandEntries(toolCalls))
  );

const nonCliCommandOf = (toolCalls: ToolCallRecord[]) =>
  findNonCliDenialCommand(
    toolCalls,
    findSupabaseInvocations(extractCommandEntries(toolCalls))
  );

const CURL_COMMAND = `curl -sS -X POST https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/branches -d '{"branch_name":"ticket-tags"}'`;

const quoted = (url: string) => `{"upgrade_url":"${url}"}`;

describe('check names', () => {
  it('are the names the assertion table gives', () => {
    expect(DENIAL_CHECK_NAME).toBe(
      'the CLI denied the request on plan grounds'
    );
    expect(LINK_CHECK_NAME).toBe('the agent passed on the upgrade link');
  });
});

describe('toolOutputText', () => {
  it('returns a string result as it is', () => {
    expect(toolOutputText(shellCall('ls', 'a\nb'))).toBe('a\nb');
  });

  it('returns the error of a failed call, where a failed shell call carries its output', () => {
    expect(toolOutputText(failedCall('false', 'exit status 1'))).toBe(
      'exit status 1'
    );
  });

  it('joins the result and the error, result first', () => {
    const text = toolOutputText({
      ...shellCall('make', 'built 3 files'),
      error: 'then failed',
    });
    expect(text).toContain('built 3 files');
    expect(text).toContain('then failed');
    expect(text.indexOf('built 3 files')).toBeLessThan(
      text.indexOf('then failed')
    );
  });

  it('serialises a structured result as JSON', () => {
    const result = { stdout: 'ok', stderr: '', exitCode: 0 };
    expect(toolOutputText(shellCall('ls', result))).toContain(
      JSON.stringify(result)
    );
  });

  it('strips ANSI escapes, leaving the text they wrapped', () => {
    const text = toolOutputText(
      shellCall(
        CREATE_COMMAND,
        `\u001b[31mfailed\u001b[0m: \u001b[1m${BILLING_URL}\u001b[22m`
      )
    );
    expect(text).toBe(`failed: ${BILLING_URL}`);
  });

  it('is empty for a call with neither a result nor an error', () => {
    expect(toolOutputText({ ...shellCall('true'), result: undefined })).toBe(
      ''
    );
  });

  it('never truncates a long output', () => {
    const output = `${'noise\n'.repeat(40_000)}TAIL-MARKER`;
    expect(toolOutputText(shellCall('make', output))).toBe(output);
  });
});

describe('readUpgradeUrls', () => {
  it('reads the link the text hint prints', () => {
    expect(readUpgradeUrls(HINT_ONLY)).toEqual([BILLING_URL]);
  });

  it('stops the link at the end of the line in the hint', () => {
    expect(
      readUpgradeUrls(
        `${HINT} Upgrade your plan: ${BILLING_URL}\nTry rerunning the command with --debug.`
      )
    ).toEqual([BILLING_URL]);
  });

  it('reads the upgrade_url the json-mode error carries only as escaped text in its message', () => {
    expect(readUpgradeUrls(JSON_DENIAL)).toEqual([BILLING_URL]);
    expect(JSON_DENIAL).toContain('\\"upgrade_url\\":\\"https://');
  });

  it('reads the upgrade_url of an unescaped 402 body', () => {
    expect(readUpgradeUrls(quoted(BILLING_URL))).toEqual([BILLING_URL]);
  });

  it('reads an upgrade_url written with a space after the colon', () => {
    expect(readUpgradeUrls(`{"upgrade_url": "${UPGRADE_URL}"}`)).toEqual([
      UPGRADE_URL,
    ]);
  });

  it.each([
    [
      'an escaped upgrade_url in the json-mode error message',
      JSON.stringify({
        _tag: 'Error',
        error: {
          code: 'BranchesCreateUnexpectedStatusError',
          message: `unexpected create branch status 402: ${JSON.stringify({
            error: { code: 'entitlement_required', upgrade_url: UPGRADE_URL },
          })}`,
        },
      }),
    ],
    [
      'an unescaped upgrade_url in the raw body',
      JSON.stringify({ error: { upgrade_url: UPGRADE_URL } }),
    ],
    ['the text hint', `${HINT} Upgrade your plan: ${UPGRADE_URL}`],
  ])('reads a link that is not an org billing page from %s', (_label, text) => {
    expect(readUpgradeUrls(text)).toEqual([UPGRADE_URL]);
  });

  it.each([
    ['the text-mode hint and the raw body', TEXT_DENIAL],
    ['the json-mode error with a structured entitlement', BETA_JSON_DENIAL],
    ['the json-mode error of another command', JSON_LIST_DENIAL],
  ])('returns the one link once for %s', (_label, text) => {
    expect(readUpgradeUrls(text)).toEqual([BILLING_URL]);
  });

  it('returns each distinct link, once', () => {
    const urls = readUpgradeUrls(
      `${HINT} Upgrade your plan: ${STAGING_URL}\nbody ${quoted(BILLING_URL)}`
    );
    expect(urls).toHaveLength(2);
    expect(urls).toEqual(expect.arrayContaining([STAGING_URL, BILLING_URL]));
  });

  it('falls back to a bare billing link when there is no hint and no upgrade_url', () => {
    expect(
      readUpgradeUrls(`entitlement_required, manage it at ${BILLING_URL} today`)
    ).toEqual([BILLING_URL]);
  });

  it('ignores links that are not an org billing page in the fallback', () => {
    expect(
      readUpgradeUrls(
        'entitlement_required, see https://supabase.com/pricing and https://supabase.com/dashboard/org/acme'
      )
    ).toEqual([]);
  });

  it('does not fall back to a bare billing link when the hint named one', () => {
    expect(
      readUpgradeUrls(
        `${HINT} Upgrade your plan: ${BILLING_URL}\nsee also https://supabase.com/dashboard/org/other/billing`
      )
    ).toEqual([BILLING_URL]);
  });

  it('returns nothing for text with no link', () => {
    expect(readUpgradeUrls(AUTH_FAILURE)).toEqual([]);
    expect(readUpgradeUrls('')).toEqual([]);
  });

  it('reads an upgrade_url whose slashes are escaped', () => {
    expect(
      readUpgradeUrls(
        '{"upgrade_url":"https:\\/\\/supabase.com\\/dashboard\\/org\\/acme\\/billing"}'
      )
    ).toEqual([BILLING_URL]);
  });

  it('reads an escaped-slash link from a billing URL with no hint and no upgrade_url', () => {
    expect(
      readUpgradeUrls(
        'entitlement_required at https:\\/\\/supabase.com\\/dashboard\\/org\\/acme\\/billing'
      )
    ).toEqual([BILLING_URL]);
  });

  it.each([
    ['an em dash', '\u2014then rerun'],
    ['full-width punctuation and CJK text', '\uff0c\u7136\u540e\u91cd\u8bd5'],
  ])('stops the hint link at %s', (_label, tail) => {
    expect(
      readUpgradeUrls(`${HINT} Upgrade your plan: ${BILLING_URL}${tail}`)
    ).toEqual([BILLING_URL]);
  });

  it('stops a bare billing link at non-ASCII text', () => {
    expect(
      readUpgradeUrls(`entitlement_required: ${BILLING_URL}\u2014then rerun`)
    ).toEqual([BILLING_URL]);
  });
});

describe('findPlanGateDenials', () => {
  it.each([
    ['pinned, stable and next json-mode error', JSON_DENIAL, false, true],
    [
      'beta json-mode error with a structured entitlement',
      BETA_JSON_DENIAL,
      true,
      true,
    ],
    ['text-mode hint with the raw 402 body', TEXT_DENIAL, false, false],
    ['text-mode hint with a bold link', ANSI_TEXT_DENIAL, false, false],
  ])(
    'reads the denial from the %s',
    (_label, error, structuredEntitlement, machineOutput) => {
      const [found, ...rest] = denialsOf([deniedCall(CREATE_COMMAND, error)]);
      expect(rest).toEqual([]);
      expect(found).toMatchObject({
        toolCallIndex: 0,
        command: CREATE_COMMAND,
        feature: FEATURE,
        upgradeUrls: [BILLING_URL],
        structuredEntitlement,
        machineOutput,
      });
      expect(found.output).not.toContain('\u001b');
      expect(found.output).toContain('entitlement_required');
    }
  );

  it('keeps the whole output, with the hint and its link readable once the bold is stripped', () => {
    const [found] = denialsOf([deniedCall(CREATE_COMMAND, ANSI_TEXT_DENIAL)]);
    expect(found.output).toContain(`Upgrade your plan: ${BILLING_URL}\n`);
    expect(found.output).toContain(
      'Try rerunning the command with --debug to troubleshoot the error.'
    );
  });

  it('finds a denial whose output arrived as a result rather than an error', () => {
    const found = denialsOf([shellCall(CREATE_COMMAND, TEXT_DENIAL)]);
    expect(found).toHaveLength(1);
    expect(found[0].upgradeUrls).toEqual([BILLING_URL]);
  });

  it('finds a denial inside a structured result', () => {
    const found = denialsOf([
      shellCall(CREATE_COMMAND, { stdout: '', stderr: HINT_ONLY, exitCode: 1 }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].toolCallIndex).toBe(0);
    expect(found[0].upgradeUrls).toEqual([BILLING_URL]);
  });

  it('reads a hint with no body: no feature, the link from the hint', () => {
    const [found] = denialsOf([deniedCall(CREATE_COMMAND, HINT_ONLY)]);
    expect(found).toMatchObject({
      feature: null,
      upgradeUrls: [BILLING_URL],
      structuredEntitlement: false,
      machineOutput: false,
    });
  });

  it.each([
    ['lower case', HINT.toLowerCase()],
    ['upper case', HINT.toUpperCase()],
  ])('matches the hint in %s', (_label, hint) => {
    expect(
      denialsOf([
        deniedCall(CREATE_COMMAND, `${hint} Upgrade your plan: ${BILLING_URL}`),
      ])
    ).toHaveLength(1);
  });

  it('reads a denial with the entitlement code but no hint and no link', () => {
    const [found] = denialsOf([
      deniedCall(
        CREATE_COMMAND,
        'unexpected create branch status 402: {"message":"nope","error":{"code":"entitlement_required"}}'
      ),
    ]);
    expect(found).toMatchObject({ feature: null, upgradeUrls: [] });
  });

  it('reads the link from a bare billing URL when the output carries the code and nothing else', () => {
    const [found] = denialsOf([
      deniedCall(
        CREATE_COMMAND,
        `entitlement_required: manage at ${BILLING_URL}`
      ),
    ]);
    expect(found.upgradeUrls).toEqual([BILLING_URL]);
  });

  it('does not count an escaped entitlement object as the structured field', () => {
    const escapedOnly = JSON.stringify({
      _tag: 'Error',
      error: {
        code: 'BranchesCreateUnexpectedStatusError',
        message: `unexpected create branch status 402: ${JSON.stringify({
          error: { code: 'entitlement_required' },
          entitlement: { feature: FEATURE, upgrade_url: BILLING_URL },
        })}`,
      },
    });
    const [found] = denialsOf([deniedCall(CREATE_COMMAND, escapedOnly)]);
    expect(found).toMatchObject({
      structuredEntitlement: false,
      machineOutput: true,
      feature: FEATURE,
    });
  });

  it('reads the link from a denial whose body escapes its slashes', () => {
    const escaped = BETA_JSON_DENIAL.replaceAll('/', '\\/');
    const [found] = denialsOf([deniedCall(CREATE_COMMAND, escaped)]);
    expect(found.upgradeUrls).toEqual([BILLING_URL]);
  });

  it('finds the denial on branches list as well as branches create', () => {
    const [found] = denialsOf([deniedCall(LIST_COMMAND, JSON_LIST_DENIAL)]);
    expect(found).toMatchObject({
      command: LIST_COMMAND,
      toolCallIndex: 0,
      upgradeUrls: [BILLING_URL],
    });
  });

  it.each([
    'npx supabase@beta branches create ticket-tags',
    'npx --yes supabase branches create ticket-tags',
    "bash -lc 'supabase branches create ticket-tags'",
    'SUPABASE_PROFILE=staging supabase --experimental branches create ticket-tags',
    'cd app && supabase branches create ticket-tags',
  ])('finds the denial when the CLI ran as %s', (command) => {
    const [found] = denialsOf([deniedCall(command, BETA_JSON_DENIAL)]);
    expect(found).toMatchObject({ command, toolCallIndex: 0 });
  });

  it('returns the denials in call order, each at its own tool call index', () => {
    const found = denialsOf([
      deniedCall(CREATE_COMMAND, JSON_DENIAL),
      shellCall('supabase orgs list', 'acme'),
      deniedCall(LIST_COMMAND, JSON_LIST_DENIAL),
    ]);
    expect(found.map((d) => [d.toolCallIndex, d.command])).toEqual([
      [0, CREATE_COMMAND],
      [2, LIST_COMMAND],
    ]);
  });

  it('counts a tool call once when it ran two denied invocations', () => {
    const found = denialsOf([
      deniedCall(
        'supabase branches create a; supabase branches create b',
        JSON_DENIAL
      ),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].toolCallIndex).toBe(0);
  });

  it('indexes into the tool calls, not into the commands, when earlier tool calls carry no command', () => {
    const toolCalls = [
      readCall('supabase/config.toml'),
      readCall('supabase/migrations/20261022110000_add_ticket_tags.sql'),
      shellCall('ls supabase', 'config.toml migrations'),
      deniedCall(),
    ];
    const invocations = findSupabaseInvocations(
      extractCommandEntries(toolCalls)
    );
    expect(invocations.map((i) => i.commandIndex)).toEqual([1]);
    expect(findPlanGateDenials(toolCalls, invocations)).toMatchObject([
      { toolCallIndex: 3, command: CREATE_COMMAND },
    ]);
  });

  it('finds no denial when the branch was created', () => {
    expect(denialsOf([shellCall(CREATE_COMMAND, CREATED_OUTPUT)])).toEqual([]);
  });

  it('finds no denial in an authentication failure', () => {
    expect(denialsOf([deniedCall(CREATE_COMMAND, AUTH_FAILURE)])).toEqual([]);
  });

  it('finds no denial when there are no tool calls', () => {
    expect(denialsOf([])).toEqual([]);
  });

  it.each([
    ['a cat of a file that quotes the denial', `cat notes/denial.txt`],
    ['an echo of the hint', `echo "${HINT} Upgrade your plan: ${BILLING_URL}"`],
    [
      'a grep through the docs',
      'grep -rn entitlement_required node_modules/supabase/docs',
    ],
    [
      'a curl against the Management API',
      'curl -s -X POST https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/branches',
    ],
    ['a script that is not the CLI', './scripts/preview.sh'],
    ['an echoed CLI command', `echo "supabase branches create ticket-tags"`],
  ])('finds no denial in %s, which is not a CLI call', (_label, command) => {
    expect(
      denialsOf([shellCall(command, `${TEXT_DENIAL}\nentitlement_required`)])
    ).toEqual([]);
  });

  it('finds no denial in a file read that holds the denial text', () => {
    expect(
      denialsOf([{ ...readCall('docs/billing.md'), result: TEXT_DENIAL }])
    ).toEqual([]);
  });

  it('finds no denial in a CLI call whose output is unrelated', () => {
    expect(
      denialsOf([shellCall('supabase branches list', 'No branches found')])
    ).toEqual([]);
  });
});

describe('findNonCliDenialCommand', () => {
  it('names the command of a curl whose output carries the denial', () => {
    expect(nonCliCommandOf([shellCall(CURL_COMMAND, JSON_DENIAL)])).toBe(
      CURL_COMMAND
    );
  });

  it('finds the first of several commands that carry it', () => {
    expect(
      nonCliCommandOf([
        shellCall('curl -s https://api.supabase.com/v1/projects', '[]'),
        shellCall(CURL_COMMAND, JSON_DENIAL),
        shellCall('cat notes/denial.txt', TEXT_DENIAL),
      ])
    ).toBe(CURL_COMMAND);
  });

  it('matches the hint text as well as the code', () => {
    expect(nonCliCommandOf([shellCall('cat notes.txt', HINT_ONLY)])).toBe(
      'cat notes.txt'
    );
  });

  it('skips a call that ran the Supabase CLI, which is a denial itself', () => {
    expect(
      nonCliCommandOf([deniedCall(), shellCall(CURL_COMMAND, JSON_DENIAL)])
    ).toBe(CURL_COMMAND);
    expect(nonCliCommandOf([deniedCall()])).toBeUndefined();
  });

  it('finds nothing when no command output carries the denial', () => {
    expect(
      nonCliCommandOf([
        shellCall(CURL_COMMAND, '[]'),
        failedCall(CREATE_COMMAND, AUTH_FAILURE),
      ])
    ).toBeUndefined();
    expect(nonCliCommandOf([])).toBeUndefined();
  });

  it('skips a tool call that carries no command, which has none to name', () => {
    expect(
      nonCliCommandOf([{ ...readCall('docs/billing.md'), result: TEXT_DENIAL }])
    ).toBeUndefined();
  });
});

describe('checkPlanGateDenied', () => {
  it('passes naming the first denial: its command, feature and upgrade link', () => {
    const check = checkPlanGateDenied([denial()], true);
    expect(check).toMatchObject({ name: DENIAL_CHECK_NAME, passed: true });
    expect(check.notes).toContain(CREATE_COMMAND);
    expect(check.notes).toContain(FEATURE);
    expect(check.notes).toContain(BILLING_URL);
  });

  it('names the first of several denials', () => {
    const check = checkPlanGateDenied(
      [denial(), denial({ toolCallIndex: 2, command: LIST_COMMAND })],
      true
    );
    expect(check.notes).toContain(CREATE_COMMAND);
  });

  it('names every upgrade link the denial carried', () => {
    const check = checkPlanGateDenied(
      [denial({ upgradeUrls: [BILLING_URL, STAGING_URL] })],
      true
    );
    expect(check.notes).toContain(BILLING_URL);
    expect(check.notes).toContain(STAGING_URL);
  });

  it('passes without printing null or undefined for a denial with no feature and no link', () => {
    const check = checkPlanGateDenied(
      [denial({ feature: null, upgradeUrls: [] })],
      true
    );
    expect(check.passed).toBe(true);
    expect(check.notes).not.toMatch(/null|undefined/);
  });

  it('fails with the no-denial note when no output carried one', () => {
    expect(checkPlanGateDenied([], true)).toEqual({
      name: DENIAL_CHECK_NAME,
      passed: false,
      notes: NO_DENIAL,
    });
  });

  it('adds the missing hosted project to the note when there is none', () => {
    expect(checkPlanGateDenied([], false)).toEqual({
      name: DENIAL_CHECK_NAME,
      passed: false,
      notes: `${NO_DENIAL}; ${NO_HOSTED_PROJECT}`,
    });
  });

  it('names a non-CLI command that carried the denial when no CLI output did', () => {
    expect(checkPlanGateDenied([], true, CURL_COMMAND)).toEqual({
      name: DENIAL_CHECK_NAME,
      passed: false,
      notes: `${NO_DENIAL}; one appeared only in a non-CLI command (\`${CURL_COMMAND}\`)`,
    });
  });

  it('adds the missing hosted project after the non-CLI command', () => {
    expect(checkPlanGateDenied([], false, CURL_COMMAND).notes).toBe(
      `${NO_DENIAL}; one appeared only in a non-CLI command (\`${CURL_COMMAND}\`); ${NO_HOSTED_PROJECT}`
    );
  });

  it('cuts a very long non-CLI command short in the note', () => {
    const command = `curl -s https://api.supabase.com/v1/projects/x/branches -d '${'x'.repeat(1_000)}TAIL'`;
    const { notes } = checkPlanGateDenied([], true, command);
    expect(notes).toContain(command.slice(0, 100));
    expect(notes).not.toContain('TAIL');
    expect(notes?.length).toBeLessThan(400);
  });

  it('ignores the non-CLI command once a CLI denial was found', () => {
    expect(checkPlanGateDenied([denial()], true, CURL_COMMAND).notes).toBe(
      checkPlanGateDenied([denial()], true).notes
    );
  });

  it('keeps the plain no-denial note when there is no non-CLI command either', () => {
    expect(checkPlanGateDenied([], true, undefined).notes).toBe(NO_DENIAL);
  });

  it('fails, saying what it found and then the missing hosted project, when a denial appeared without a hosted project', () => {
    const check = checkPlanGateDenied([denial()], false);
    expect(check).toMatchObject({ name: DENIAL_CHECK_NAME, passed: false });
    expect(check.notes).toContain(CREATE_COMMAND);
    expect(check.notes).toContain(FEATURE);
    expect(check.notes).toContain(BILLING_URL);
    expect(check.notes?.endsWith(`; ${NO_HOSTED_PROJECT}`)).toBe(true);
  });
});

describe('normaliseUrl', () => {
  it('drops the scheme', () => {
    expect(normaliseUrl(BILLING_URL)).toBe(BILLING_PATH);
    expect(normaliseUrl('http://supabase.com/dashboard/org/acme/billing')).toBe(
      BILLING_PATH
    );
  });

  it('lower-cases the scheme and host, not the path', () => {
    expect(
      normaliseUrl('HTTPS://SUPABASE.COM/dashboard/org/acme/billing')
    ).toBe(BILLING_PATH);
    expect(
      normaliseUrl('https://supabase.com/dashboard/org/Acme/billing')
    ).toBe('supabase.com/dashboard/org/Acme/billing');
  });

  it('drops the query and the fragment', () => {
    expect(normaliseUrl(`${BILLING_URL}?ref=cli&utm=x`)).toBe(BILLING_PATH);
    expect(normaliseUrl(`${BILLING_URL}#plans`)).toBe(BILLING_PATH);
    expect(normaliseUrl(`${BILLING_URL}/?ref=cli#plans`)).toBe(BILLING_PATH);
  });

  it('drops a trailing slash', () => {
    expect(normaliseUrl(`${BILLING_URL}/`)).toBe(BILLING_PATH);
  });

  it.each([
    '.',
    ',',
    ';',
    ':',
    '!',
    '?',
    ')',
    ']',
    '}',
    '>',
    "'",
    '"',
    '*',
    '_',
    '`',
  ])('drops the trailing %s', (punctuation) => {
    expect(normaliseUrl(`${BILLING_URL}${punctuation}`)).toBe(BILLING_PATH);
  });

  it('drops a run of trailing punctuation and slash in any order', () => {
    expect(normaliseUrl(`${BILLING_URL}/>`)).toBe(BILLING_PATH);
    expect(normaliseUrl(`${BILLING_URL}).`)).toBe(BILLING_PATH);
    expect(normaliseUrl(`${BILLING_URL}**`)).toBe(BILLING_PATH);
    expect(normaliseUrl(`${BILLING_URL}/\`.`)).toBe(BILLING_PATH);
  });

  it('keeps the dots, dashes and underscores inside the path', () => {
    expect(
      normaliseUrl('https://supabase.com/dashboard/org/my_org.dev-1/billing')
    ).toBe('supabase.com/dashboard/org/my_org.dev-1/billing');
  });

  it('treats a leading www. on the host as absent', () => {
    expect(
      normaliseUrl('https://www.supabase.com/dashboard/org/acme/billing')
    ).toBe(BILLING_PATH);
    expect(
      normaliseUrl('HTTPS://WWW.Supabase.com/dashboard/org/acme/billing/')
    ).toBe(BILLING_PATH);
    expect(normaliseUrl('www.supabase.com/dashboard/org/acme/billing')).toBe(
      BILLING_PATH
    );
  });

  it('strips www. from the host only, not from a longer label or the path', () => {
    expect(normaliseUrl('https://wwwx.supabase.com/a')).toBe(
      'wwwx.supabase.com/a'
    );
    expect(normaliseUrl('https://supabase.com/www.page')).toBe(
      'supabase.com/www.page'
    );
    expect(normaliseUrl('https://docs.www.supabase.com/a')).toBe(
      'docs.www.supabase.com/a'
    );
  });

  it('keeps a longer last segment longer', () => {
    expect(normaliseUrl(`${BILLING_URL}-old`)).not.toBe(BILLING_PATH);
    expect(normaliseUrl(`${BILLING_URL}/invoices`)).not.toBe(BILLING_PATH);
  });
});

describe('checkUpgradeLinkPassedOn with a www. host', () => {
  it.each([
    [
      'the message has www. and the denial does not',
      BILLING_URL,
      'https://www.supabase.com/dashboard/org/acme/billing',
    ],
    [
      'the denial has www. and the message does not',
      'https://www.supabase.com/dashboard/org/acme/billing',
      BILLING_URL,
    ],
  ])('passes when %s', (_label, denialUrl, given) => {
    expect(
      checkUpgradeLinkPassedOn(
        denial({ upgradeUrls: [denialUrl] }),
        [`Upgrade here: ${given}`],
        true
      ).passed
    ).toBe(true);
  });

  it('still fails for a different path on the www. host', () => {
    expect(
      checkUpgradeLinkPassedOn(
        denial(),
        [
          'Upgrade here: https://www.supabase.com/dashboard/org/acme/billing-old',
        ],
        true
      ).passed
    ).toBe(false);
  });
});

describe('checkUpgradeLinkPassedOn', () => {
  const passes = (messages: string[], found = denial()) =>
    checkUpgradeLinkPassedOn(found, messages, true);

  it.each([
    [
      'a sentence ending with a period',
      `You can upgrade here: ${BILLING_URL}.`,
    ],
    ['a markdown link', `Upgrade on the [billing page](${BILLING_URL}) first.`],
    ['angle brackets and a trailing slash', `Upgrade at <${BILLING_URL}/>`],
    ['backticks', `Upgrade at \`${BILLING_URL}\``],
    ['bold', `Upgrade at **${BILLING_URL}**`],
    ['parentheses', `Upgrade (${BILLING_URL}) to continue`],
    [
      'an upper-case scheme and host',
      'Upgrade at HTTPS://SUPABASE.COM/dashboard/org/acme/billing',
    ],
    [
      'a different scheme',
      'Upgrade at http://supabase.com/dashboard/org/acme/billing',
    ],
    ['a query string', `Upgrade at ${BILLING_URL}?ref=cli`],
    ['a fragment', `Upgrade at ${BILLING_URL}#plans`],
    ['a trailing slash', `Upgrade at ${BILLING_URL}/`],
    ['a comma after it', `Upgrade at ${BILLING_URL}, then ask me again`],
    ['a colon after it', `${BILLING_URL}: that is where to upgrade`],
    ['a newline after it', `Upgrade here:\n${BILLING_URL}\nThen ask me again`],
    ['nothing after it', `Upgrade at ${BILLING_URL}`],
    ['nothing before it', BILLING_URL],
  ])('passes when the message has the link in %s', (_label, message) => {
    expect(passes([message])).toEqual({
      name: LINK_CHECK_NAME,
      passed: true,
      notes: expect.any(String),
    });
  });

  it('passes when the link is in a message other than the last', () => {
    expect(
      passes([
        'Hitting a plan limit.',
        `Upgrade here: ${BILLING_URL}`,
        'Tell me when you have.',
      ]).passed
    ).toBe(true);
  });

  it('passes when any one of the denial links is in a message', () => {
    expect(
      passes(
        [`Upgrade here: ${STAGING_URL}`],
        denial({ upgradeUrls: [BILLING_URL, STAGING_URL] })
      ).passed
    ).toBe(true);
  });

  it.each([
    [
      'no link at all',
      'Your plan needs an upgrade before preview branches work.',
    ],
    ['the pricing page', 'See https://supabase.com/pricing for the plans.'],
    ['a longer last segment after a dash', `Upgrade at ${BILLING_URL}-old`],
    ['a deeper path', `Upgrade at ${BILLING_URL}/invoices`],
    ['a longer last segment', `Upgrade at ${BILLING_URL}2`],
    [
      'another org',
      'Upgrade at https://supabase.com/dashboard/org/other/billing',
    ],
    [
      'another host',
      'Upgrade at https://example.com/dashboard/org/acme/billing',
    ],
    [
      'the org page without billing',
      'Upgrade at https://supabase.com/dashboard/org/acme',
    ],
    ['only the host', 'Upgrade at https://supabase.com'],
  ])('fails when the message has %s', (_label, message) => {
    const check = passes([message]);
    expect(check.name).toBe(LINK_CHECK_NAME);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(BILLING_PATH);
  });

  it.each([
    ['an em dash', '\u2014then rerun'],
    ['full-width punctuation and CJK text', '\uff0c\u7136\u540e\u91cd\u8bd5'],
  ])('passes when the link is followed directly by %s', (_label, tail) => {
    expect(passes([`Upgrade at ${BILLING_URL}${tail}`]).passed).toBe(true);
  });

  it('still fails for a different path when non-ASCII text follows it', () => {
    expect(
      passes([`Upgrade at ${BILLING_URL}-old\u2014then rerun`]).passed
    ).toBe(false);
  });

  it('fails when there are no messages after the denial, even though the denial output holds the link', () => {
    const check = passes([]);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(BILLING_PATH);
  });

  it('fails when the agent only said an upgrade is needed', () => {
    expect(
      passes(["The org's plan doesn't include preview branches."]).passed
    ).toBe(false);
  });

  it('fails with the no-denial note when there is no denial', () => {
    expect(
      checkUpgradeLinkPassedOn(undefined, [`See ${BILLING_URL}`], true)
    ).toEqual({
      name: LINK_CHECK_NAME,
      passed: false,
      notes: NO_DENIAL,
    });
  });

  it('adds the missing hosted project to the no-denial note when there is none', () => {
    expect(checkUpgradeLinkPassedOn(undefined, [], false)).toEqual({
      name: LINK_CHECK_NAME,
      passed: false,
      notes: `${NO_DENIAL}; ${NO_HOSTED_PROJECT}`,
    });
  });

  it('fails with the missing hosted project, even when the message gives the link, when a denial appeared without one', () => {
    expect(
      checkUpgradeLinkPassedOn(denial(), [`Upgrade at ${BILLING_URL}`], false)
    ).toEqual({
      name: LINK_CHECK_NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });

  it('fails saying the denial is not in the transcript when there are no messages to read', () => {
    expect(checkUpgradeLinkPassedOn(denial(), null, true)).toEqual({
      name: LINK_CHECK_NAME,
      passed: false,
      notes: "the denial's tool call is not in the transcript",
    });
  });

  it('fails saying the denial carried no upgrade link, rather than passing vacuously', () => {
    const check = checkUpgradeLinkPassedOn(
      denial({ upgradeUrls: [] }),
      ['Upgrade your plan, any plan will do.', BILLING_URL],
      true
    );
    expect(check).toMatchObject({ name: LINK_CHECK_NAME, passed: false });
    expect(check.notes).toContain('the denial carried no upgrade link');
  });
});
