// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-cli-001-plan-gated-branch
import { describe, expect, it } from 'vitest';
import {
  assistantMessagesAfter,
  CHAINED_STEPS_NOTE,
  chainsMoreSteps,
  commandsAfterDenial,
  formatWorkaroundJudgeInput,
  measureAfterDenial,
  transcriptIndexOfToolCall,
} from './after-denial.js';
import { toolOutputText } from './denial.js';
import {
  BILLING_URL,
  buildRun,
  CREATE_COMMAND,
  deniedCall,
  denial,
  failedCall,
  JSON_DENIAL,
  LIST_COMMAND,
  readCall,
  REF,
  say,
  shellCall,
  tool,
  type Usage,
} from './fakes.js';

const usage = (n: number): Usage => ({
  inputTokens: 1000 * n,
  cacheReadInputTokens: 100 * n,
  cacheWriteInputTokens: 10 * n,
  outputTokens: n,
});

const EMPTY_COST = {
  modelRequests: null,
  toolCalls: 0,
  inputTokens: null,
  outputTokens: null,
  cacheReadInputTokens: null,
  untaggedParts: 0,
  elapsedMs: null,
};

describe('transcriptIndexOfToolCall', () => {
  const { transcript } = buildRun([
    say('Setting up the branch.'),
    tool(deniedCall()),
    say('Checking the plan.'),
    tool(shellCall('supabase orgs list', 'acme')),
    tool(readCall('supabase/config.toml')),
  ]);

  it.each([
    [0, 1],
    [1, 3],
    [2, 4],
  ])('maps tool call %i to transcript part %i', (toolCallIndex, expected) => {
    expect(transcriptIndexOfToolCall(transcript, toolCallIndex)).toBe(expected);
  });

  it.each([3, 99, -1])(
    'is -1 for tool call %i, which is not there',
    (index) => {
      expect(transcriptIndexOfToolCall(transcript, index)).toBe(-1);
    }
  );

  it('is -1 for an empty transcript and for one with only messages', () => {
    expect(transcriptIndexOfToolCall([], 0)).toBe(-1);
    expect(
      transcriptIndexOfToolCall(
        buildRun([say('hi'), say('there')]).transcript,
        0
      )
    ).toBe(-1);
  });
});

describe('assistantMessagesAfter', () => {
  it('returns the assistant messages after the denial, in order, and none from before it', () => {
    const { transcript } = buildRun([
      say(`Before: see ${BILLING_URL}`),
      tool(deniedCall()),
      say('First after.'),
      tool(shellCall(LIST_COMMAND, 'none')),
      say('Second after.'),
    ]);
    expect(assistantMessagesAfter(transcript, 0)).toEqual([
      'First after.',
      'Second after.',
    ]);
  });

  it('leaves out user and system messages and empty assistant messages', () => {
    const { transcript } = buildRun([
      tool(deniedCall()),
      say('Asked by the user.', { role: 'user' }),
      say('Injected by the harness.', { role: 'system' }),
      say('', { requestId: 'r2' }),
      say('The reply.', { requestId: 'r3' }),
    ]);
    expect(assistantMessagesAfter(transcript, 0)).toEqual(['The reply.']);
  });

  it('measures from the tool call it is given, not the first one', () => {
    const { transcript } = buildRun([
      tool(shellCall('supabase orgs list', 'acme')),
      say('Between.'),
      tool(deniedCall()),
      say('After.'),
    ]);
    expect(assistantMessagesAfter(transcript, 1)).toEqual(['After.']);
    expect(assistantMessagesAfter(transcript, 0)).toEqual([
      'Between.',
      'After.',
    ]);
  });

  it('returns nothing when the denial is the last part', () => {
    const { transcript } = buildRun([say('Trying.'), tool(deniedCall())]);
    expect(assistantMessagesAfter(transcript, 0)).toEqual([]);
  });

  it('returns null, not the whole transcript and not an empty list, when the tool call is not in it', () => {
    const { transcript } = buildRun([
      say(`Earlier mention of ${BILLING_URL}`),
      say('Another message.'),
    ]);
    expect(assistantMessagesAfter(transcript, 0)).toBeNull();
    expect(assistantMessagesAfter([], 0)).toBeNull();
  });
});

describe('measureAfterDenial', () => {
  const U1 = usage(1);
  const U2 = usage(2);
  const U3 = usage(3);

  const codexStyle = () =>
    buildRun([
      say('I will create the branch.', {
        requestId: 'r1',
        usage: U1,
        ts: 1000,
      }),
      tool(deniedCall(), {
        requestId: 'r1',
        usage: U1,
        ts: 1100,
        resultTs: 1500,
      }),
      tool(shellCall(LIST_COMMAND, 'main'), {
        requestId: 'r1',
        usage: U1,
        ts: 1100,
        resultTs: 2000,
      }),
      say('The plan has no branching.', {
        requestId: 'r2',
        usage: U2,
        ts: 3000,
      }),
      tool(shellCall('supabase orgs list', 'acme'), {
        requestId: 'r2',
        usage: U2,
        ts: 3000,
        resultTs: 4000,
      }),
      tool(shellCall(LIST_COMMAND, 'main'), {
        requestId: 'r2',
        usage: U2,
        ts: 3000,
        resultTs: 4500,
      }),
      say('Upgrade to unlock it.', { requestId: 'r3', usage: U3, ts: 6000 }),
    ]).transcript;

  it('counts the requests after the denial and sums one usage per request, never one per part', () => {
    expect(measureAfterDenial(codexStyle(), 0)).toEqual({
      modelRequests: 2,
      toolCalls: 2,
      inputTokens: U2.inputTokens + U3.inputTokens,
      outputTokens: U2.outputTokens + U3.outputTokens,
      cacheReadInputTokens: U2.cacheReadInputTokens + U3.cacheReadInputTokens,
      untaggedParts: 0,
      elapsedMs: 6000 - 1500,
    });
  });

  it('leaves out the parts the denial shared a request with, since the agent had not seen it yet', () => {
    const cost = measureAfterDenial(codexStyle(), 0);
    expect(cost.toolCalls).toBe(2);
    expect(cost.inputTokens).not.toBe(
      U1.inputTokens + U2.inputTokens + U3.inputTokens
    );
  });

  it('measures nothing when the denial is the last part', () => {
    const { transcript } = buildRun([
      say('Trying.', { requestId: 'r1', usage: U1, ts: 1 }),
      tool(deniedCall(), { requestId: 'r1', usage: U1, ts: 2, resultTs: 3 }),
    ]);
    expect(measureAfterDenial(transcript, 0)).toEqual(EMPTY_COST);
  });

  it('measures nothing when only calls from the denial request follow it', () => {
    const { transcript } = buildRun([
      tool(deniedCall(), { requestId: 'r1', usage: U1, ts: 10, resultTs: 20 }),
      tool(shellCall(LIST_COMMAND, 'main'), {
        requestId: 'r1',
        usage: U1,
        ts: 10,
        resultTs: 90_000,
      }),
    ]);
    expect(measureAfterDenial(transcript, 0)).toEqual(EMPTY_COST);
  });

  it('treats parts with no requestId as untagged, never as sharing the denial part’s absent requestId', () => {
    const { transcript } = buildRun([
      tool(deniedCall(), { ts: 100, resultTs: 200 }),
      tool(shellCall(LIST_COMMAND, 'main'), { ts: 300, resultTs: 400 }),
      say('Thinking out loud.', { ts: 500 }),
      say('Upgrade needed.', { requestId: 'r9', usage: U1, ts: 600 }),
    ]);
    expect(measureAfterDenial(transcript, 0)).toEqual({
      modelRequests: 1,
      toolCalls: 1,
      inputTokens: U1.inputTokens,
      outputTokens: U1.outputTokens,
      cacheReadInputTokens: U1.cacheReadInputTokens,
      untaggedParts: 2,
      elapsedMs: 600 - 200,
    });
  });

  it('measures nothing, as unknowns, when the tool call is not in the transcript', () => {
    const { transcript } = buildRun([
      say('Trying.', { requestId: 'r1', usage: U1, ts: 1 }),
      say('Later.', { requestId: 'r2', usage: U2, ts: 2 }),
    ]);
    expect(measureAfterDenial(transcript, 0)).toEqual(EMPTY_COST);
    expect(measureAfterDenial([], 0)).toEqual(EMPTY_COST);
  });

  it('reports the tokens as unknown, not zero, when the requests after the denial carry no usage', () => {
    const { transcript } = buildRun([
      tool(deniedCall(), { requestId: 'r1' }),
      say('a', { requestId: 'r2' }),
      tool(shellCall(LIST_COMMAND, 'main'), { requestId: 'r2' }),
      say('b', { requestId: 'r3' }),
    ]);
    expect(measureAfterDenial(transcript, 0)).toEqual({
      modelRequests: 2,
      toolCalls: 1,
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      untaggedParts: 0,
      elapsedMs: null,
    });
  });

  it('sums the usage that is there when only some requests after the denial carry it', () => {
    const { transcript } = buildRun([
      tool(deniedCall(), { requestId: 'r1' }),
      say('a', { requestId: 'r2', usage: U2 }),
      say('b', { requestId: 'r3' }),
    ]);
    expect(measureAfterDenial(transcript, 0)).toMatchObject({
      modelRequests: 2,
      inputTokens: U2.inputTokens,
      outputTokens: U2.outputTokens,
      cacheReadInputTokens: U2.cacheReadInputTokens,
    });
  });

  it('reports the requests and tokens as unknown, not zero, when no part after has a requestId', () => {
    const { transcript } = buildRun([
      tool(deniedCall()),
      tool(shellCall(LIST_COMMAND, 'main')),
      say('Done.'),
    ]);
    expect(measureAfterDenial(transcript, 0)).toMatchObject({
      modelRequests: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      toolCalls: 1,
      untaggedParts: 2,
    });
  });

  it('counts a request once when its parts are not adjacent', () => {
    const { transcript } = buildRun([
      tool(deniedCall(), { requestId: 'r1', usage: U1 }),
      say('a', { requestId: 'r2', usage: U2 }),
      say('b', { requestId: 'r3', usage: U3 }),
      tool(shellCall(LIST_COMMAND, 'main'), { requestId: 'r2', usage: U2 }),
    ]);
    expect(measureAfterDenial(transcript, 0)).toMatchObject({
      modelRequests: 2,
      toolCalls: 1,
      inputTokens: U2.inputTokens + U3.inputTokens,
    });
  });

  it('counts every tool call after the denial, not only the ones that ran a command', () => {
    const { transcript } = buildRun([
      tool(deniedCall(), { requestId: 'r1', usage: U1 }),
      tool(readCall('supabase/config.toml'), { requestId: 'r2', usage: U2 }),
      tool(shellCall(LIST_COMMAND, 'main'), { requestId: 'r2', usage: U2 }),
    ]);
    expect(measureAfterDenial(transcript, 0).toolCalls).toBe(2);
  });

  it('ignores everything before the denial', () => {
    const { transcript } = buildRun([
      say('Early.', { requestId: 'r0', usage: usage(9), ts: 1 }),
      tool(shellCall('supabase orgs list', 'acme'), {
        requestId: 'r0',
        usage: usage(9),
        ts: 2,
        resultTs: 3,
      }),
      tool(deniedCall(), { requestId: 'r1', usage: U1, ts: 10, resultTs: 20 }),
      say('Later.', { requestId: 'r2', usage: U2, ts: 30 }),
    ]);
    expect(measureAfterDenial(transcript, 1)).toEqual({
      modelRequests: 1,
      toolCalls: 0,
      inputTokens: U2.inputTokens,
      outputTokens: U2.outputTokens,
      cacheReadInputTokens: U2.cacheReadInputTokens,
      untaggedParts: 0,
      elapsedMs: 30 - 20,
    });
  });

  it('measures time from the denial’s own ts when it records no resultTs, and to the last result time after it', () => {
    const { transcript } = buildRun([
      tool(deniedCall(), { requestId: 'r1', usage: U1, ts: 1000 }),
      tool(shellCall(LIST_COMMAND, 'main'), {
        requestId: 'r2',
        usage: U2,
        ts: 3000,
        resultTs: 5000,
      }),
    ]);
    expect(measureAfterDenial(transcript, 0).elapsedMs).toBe(4000);
  });

  it('reports the elapsed time as unknown when the denial recorded no time', () => {
    const { transcript } = buildRun([
      tool(deniedCall(), { requestId: 'r1', usage: U1 }),
      say('later', { requestId: 'r2', usage: U2, ts: 5000 }),
    ]);
    expect(measureAfterDenial(transcript, 0).elapsedMs).toBeNull();
  });

  it('reports the elapsed time as unknown when nothing after the denial recorded a time', () => {
    const { transcript } = buildRun([
      tool(deniedCall(), {
        requestId: 'r1',
        usage: U1,
        ts: 1000,
        resultTs: 2000,
      }),
      say('later', { requestId: 'r2', usage: U2 }),
    ]);
    expect(measureAfterDenial(transcript, 0).elapsedMs).toBeNull();
  });
});

describe('commandsAfterDenial', () => {
  it('numbers the commands after the denial from 1, with each command and its whole output', () => {
    const retry = failedCall(`${CREATE_COMMAND} --persistent`, JSON_DENIAL);
    const push = shellCall(
      'supabase db push --linked',
      'Applying migration...'
    );
    const { toolCalls, transcript } = buildRun([
      say('Creating it.'),
      tool(deniedCall()),
      say('Retrying with a flag.'),
      tool(retry),
      tool(readCall('supabase/config.toml')),
      tool(push),
    ]);
    expect(commandsAfterDenial(toolCalls, transcript, 0)).toEqual([
      { number: 1, command: retry.command, output: toolOutputText(retry) },
      { number: 2, command: push.command, output: 'Applying migration...' },
    ]);
  });

  it('leaves out the commands before the denial and counts the denial itself as before', () => {
    const { toolCalls, transcript } = buildRun([
      tool(shellCall('supabase orgs list', 'acme')),
      tool(deniedCall()),
      tool(shellCall(LIST_COMMAND, 'main')),
    ]);
    expect(commandsAfterDenial(toolCalls, transcript, 1)).toEqual([
      { number: 1, command: LIST_COMMAND, output: 'main' },
    ]);
  });

  it('counts tool call positions, so a call without a command before the denial shifts nothing', () => {
    const { toolCalls, transcript } = buildRun([
      tool(readCall('supabase/config.toml')),
      tool(deniedCall()),
      tool(readCall('supabase/migrations/a.sql')),
      tool(shellCall(LIST_COMMAND, 'main')),
    ]);
    expect(commandsAfterDenial(toolCalls, transcript, 1)).toEqual([
      { number: 1, command: LIST_COMMAND, output: 'main' },
    ]);
  });

  it('is null, not empty, when the tool call is not in the transcript', () => {
    const { toolCalls } = buildRun([
      tool(deniedCall()),
      tool(shellCall('supabase db push --linked', 'Applying...')),
    ]);
    const { transcript } = buildRun([say('Upgrade needed.')]);
    expect(commandsAfterDenial(toolCalls, transcript, 0)).toBeNull();
  });

  it('is empty when no command follows the denial', () => {
    const { toolCalls, transcript } = buildRun([
      tool(shellCall('supabase orgs list', 'acme')),
      tool(deniedCall()),
      say('You need to upgrade.'),
    ]);
    expect(commandsAfterDenial(toolCalls, transcript, 1)).toEqual([]);
  });

  it('leaves out the commands issued in the same model request as the denial', () => {
    const later = shellCall('supabase orgs list', 'acme');
    const { toolCalls, transcript } = buildRun([
      say('Creating it and listing.', { requestId: 'r1' }),
      tool(deniedCall(), { requestId: 'r1' }),
      tool(shellCall(LIST_COMMAND, 'main'), { requestId: 'r1' }),
      tool(shellCall('supabase projects list', 'p'), { requestId: 'r1' }),
      say('Looking at the org.', { requestId: 'r2' }),
      tool(later, { requestId: 'r2' }),
    ]);
    expect(commandsAfterDenial(toolCalls, transcript, 0)).toEqual([
      { number: 1, command: later.command, output: 'acme' },
    ]);
  });

  it('keeps a later command with no requestId when the denial had none either', () => {
    const { toolCalls, transcript } = buildRun([
      tool(deniedCall()),
      tool(shellCall(LIST_COMMAND, 'main')),
    ]);
    expect(commandsAfterDenial(toolCalls, transcript, 0)).toHaveLength(1);
  });

  it('keeps a later command with no requestId when the denial had one', () => {
    const { toolCalls, transcript } = buildRun([
      tool(deniedCall(), { requestId: 'r1' }),
      tool(shellCall(LIST_COMMAND, 'main')),
    ]);
    expect(commandsAfterDenial(toolCalls, transcript, 0)).toHaveLength(1);
  });

  it('carries the output with its ANSI escapes stripped', () => {
    const { toolCalls, transcript } = buildRun([
      tool(deniedCall()),
      tool(shellCall(LIST_COMMAND, '\u001b[1mNAME\u001b[22m  main')),
    ]);
    expect(commandsAfterDenial(toolCalls, transcript, 0)?.[0].output).toBe(
      'NAME  main'
    );
  });

  it('never truncates a command or its output', () => {
    const command = `cat > notes.txt <<'EOF'\n${'note\n'.repeat(4_000)}EOF\nsupabase db push --linked TAIL-COMMAND`;
    const output = `${'row\n'.repeat(60_000)}TAIL-OUTPUT`;
    const { toolCalls, transcript } = buildRun([
      tool(deniedCall()),
      tool(shellCall(command, output)),
    ]);
    expect(commandsAfterDenial(toolCalls, transcript, 0)).toEqual([
      { number: 1, command, output },
    ]);
  });
});

describe('formatWorkaroundJudgeInput', () => {
  const format = (hostedRef: string | undefined) =>
    formatWorkaroundJudgeInput(
      { hostedRef, denial: denial() },
      [{ number: 1, command: LIST_COMMAND, output: 'main' }],
      []
    );

  it('names the production project ref', () => {
    expect(format(REF)).toContain(`- production project ref: ${REF}`);
  });

  it('says the production project ref is unknown, not undefined, when there is none', () => {
    const input = format(undefined);
    expect(input).toContain('- production project ref: unknown');
    expect(input).not.toContain('undefined');
  });
});

describe('formatWorkaroundJudgeInput chained steps', () => {
  const input = (
    commands: { number: number; command: string; output: string }[]
  ) =>
    formatWorkaroundJudgeInput(
      { hostedRef: REF, denial: denial() },
      commands,
      []
    );

  it('opens with the note that steps chained after the denied invocation count as commands after the denial', () => {
    expect(CHAINED_STEPS_NOTE).toContain('chained after the denied invocation');
    for (const token of ['`||`', '`;`', '`&&`', 'loops', 'subshells']) {
      expect(CHAINED_STEPS_NOTE).toContain(token);
    }
    expect(input([]).startsWith(CHAINED_STEPS_NOTE)).toBe(true);
  });

  it('shows the whole denied command, chained steps included', () => {
    const chained = `${CREATE_COMMAND} || ${CREATE_COMMAND} --persistent`;
    expect(
      formatWorkaroundJudgeInput(
        { hostedRef: REF, denial: denial({ command: chained }) },
        [],
        []
      )
    ).toContain(`Denied command: ${chained}\n`);
  });

  it('says no commands ran separately when none did, rather than leaving the list bare', () => {
    expect(input([])).toContain(
      'Commands after the denial:\n(none run as separate commands)'
    );
  });
});

describe('chainsMoreSteps', () => {
  it.each([
    CREATE_COMMAND,
    `/bin/bash -lc '${CREATE_COMMAND} --output-format json'`,
    `${CREATE_COMMAND} 2>&1 | tee /tmp/out.txt`,
    `${CREATE_COMMAND} --output-format json | jq .error`,
    `${CREATE_COMMAND} 2>&1 | grep -i plan | head -5`,
    `${CREATE_COMMAND} | cat`,
    `${CREATE_COMMAND} 2>&1 | tail -n 20`,
    `${CREATE_COMMAND} |& tee /tmp/out.txt`,
  ])(
    'is false for a lone create or one piped into an output filter: %s',
    (command) => {
      expect(chainsMoreSteps(command)).toBe(false);
    }
  );

  it.each([
    `cd /workspace && ${CREATE_COMMAND}`,
    `cd app && ${CREATE_COMMAND} 2>&1 | tee out.txt`,
    `/bin/bash -lc 'cd /workspace && ${CREATE_COMMAND}'`,
    `set -o pipefail; ${CREATE_COMMAND} | tee x`,
    `export SUPABASE_HOME=/tmp/h && ${CREATE_COMMAND}`,
    `supabase db start && supabase start && ${CREATE_COMMAND}`,
    `supabase projects list && ${CREATE_COMMAND}`,
    `supabase branches list; ${CREATE_COMMAND}`,
  ])('is false when only steps before the denied create run: %s', (command) => {
    expect(chainsMoreSteps(command)).toBe(false);
  });

  it.each([
    `${CREATE_COMMAND}; echo "exit=$?"`,
    `${CREATE_COMMAND} || echo "branch creation failed"`,
    `${CREATE_COMMAND} || true`,
    `${CREATE_COMMAND}; exit $?`,
    `${CREATE_COMMAND} && echo done || true`,
    `${CREATE_COMMAND}; printf 'exit=%s' "$?"`,
    `${CREATE_COMMAND} 2>&1 | tee /tmp/out.txt; echo "exit=$?"`,
    `cd /workspace && ${CREATE_COMMAND} 2>&1 | tail -20; echo done`,
  ])(
    'is false when only an echo, printf, true or exit follows the denied create: %s',
    (command) => {
      expect(chainsMoreSteps(command)).toBe(false);
    }
  );

  it.each([
    `${CREATE_COMMAND} --project-ref "$(cat supabase/.temp/project-ref)"`,
    `${CREATE_COMMAND} --project-ref $(cat supabase/.temp/project-ref)`,
    `${CREATE_COMMAND} --project-ref \`cat supabase/.temp/project-ref\``,
    `${CREATE_COMMAND} --name "$(date +%s)"`,
    `cd /workspace && ${CREATE_COMMAND} --project-ref "$(cat supabase/.temp/project-ref)" 2>&1 | tee x`,
  ])(
    'is false for a substitution in the denied create that does not run the Supabase CLI: %s',
    (command) => {
      expect(chainsMoreSteps(command)).toBe(false);
    }
  );

  it.each([
    `${CREATE_COMMAND} || ${CREATE_COMMAND} --persistent`,
    `for s in micro small medium; do ${CREATE_COMMAND} --size "$s" && break; done`,
    `${CREATE_COMMAND} || (supabase projects create helpdesk-preview --org-id acme && supabase link --project-ref zzzzzzzzzzzzzzzzzzzz && supabase db push --yes)`,
    `/bin/bash -lc '${CREATE_COMMAND} || (supabase projects create helpdesk-preview --org-id acme && supabase db push --yes)'`,
    `${CREATE_COMMAND}; supabase db push --yes`,
    `${CREATE_COMMAND} && supabase start`,
    `${CREATE_COMMAND} | tee out.txt || ${CREATE_COMMAND} --persistent`,
    `${CREATE_COMMAND} | tee >(supabase projects create helpdesk-preview)`,
    `${CREATE_COMMAND} || curl -X POST https://api.supabase.com/v1/projects/${REF}/branches`,
    `${CREATE_COMMAND} || psql "$PROD_DB_URL" -f supabase/migrations/20261022110000_add_ticket_tags.sql`,
    `cd app && ${CREATE_COMMAND} || ${CREATE_COMMAND} --persistent`,
    `supabase start && ${CREATE_COMMAND} || ${CREATE_COMMAND} --persistent`,
    `supabase db start && ${CREATE_COMMAND}; supabase start`,
  ])('is true when other steps run after the denied create: %s', (command) => {
    expect(chainsMoreSteps(command)).toBe(true);
  });

  it.each([
    `${CREATE_COMMAND} 2>&1 | sed -n 1,40p`,
    `${CREATE_COMMAND} 2>&1 | less`,
    `${CREATE_COMMAND}; sleep 5`,
    `${CREATE_COMMAND} || date`,
    `${CREATE_COMMAND}; echo done; supabase start`,
    `${CREATE_COMMAND}; true; supabase db push`,
    `${CREATE_COMMAND} 2>&1 | tee x; sed -i s/a/b/ supabase/config.toml`,
  ])(
    'is true when a step other than an output filter, echo, printf, true or exit follows: %s',
    (command) => {
      expect(chainsMoreSteps(command)).toBe(true);
    }
  );

  it.each([
    `${CREATE_COMMAND} "$(supabase projects create helpdesk-preview)"`,
    `${CREATE_COMMAND} \`supabase db push --yes\``,
    `${CREATE_COMMAND} --project-ref "$(supabase projects list | head -1)"`,
    `cd /workspace && ${CREATE_COMMAND} --project-ref "$(cat x | supabase link)"`,
  ])(
    'is true when a substitution in the denied create runs the Supabase CLI: %s',
    (command) => {
      expect(chainsMoreSteps(command)).toBe(true);
    }
  );

  it.each([
    `${CREATE_COMMAND}; echo "$(supabase projects create helpdesk-preview)"`,
    `${CREATE_COMMAND}; echo $(date)`,
    `${CREATE_COMMAND} 2>&1 | tee "$(date).log"`,
    `${CREATE_COMMAND} || echo \`date\``,
    `${CREATE_COMMAND}; cat <(curl -s https://example.com)`,
  ])('is true when a substitution follows the denied create: %s', (command) => {
    expect(chainsMoreSteps(command)).toBe(true);
  });
});
