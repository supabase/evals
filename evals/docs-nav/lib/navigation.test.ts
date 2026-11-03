import type {
  JudgeInput,
  JudgeResult,
  ToolCallRecord,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { scoreDocsNav } from './navigation.js';

const DOCS = 'https://supabase.com/docs';
const SSO = 'guides/platform/sso';
const TASK = 'Set up Google Workspace sign-in for our Supabase dashboard.';

function open(url: string, reply: unknown): ToolCallRecord {
  return {
    tool: { kind: 'mcp', server: 'docs-navigator', toolName: 'open_page' },
    body: { url },
    result: reply,
    ts: 0,
  };
}

function opened(url: string, text = 'Page text') {
  return open(url, [{ type: 'text', text: `Opened: ${url}\n\n${text}` }]);
}

function refused(url: string) {
  return open(
    url,
    `Not opened: ${url} isn't linked from any page you've opened.`
  );
}

type Judge = (input: JudgeInput) => Promise<JudgeResult>;

function context(toolCalls: ToolCallRecord[], judge: Judge = rejectAll) {
  return { toolCalls, agentReport: 'Use SAML SSO.', judge };
}

async function rejectAll(): Promise<JudgeResult> {
  return { passed: false };
}

async function navigationOf(
  toolCalls: ToolCallRecord[],
  judge: Judge = rejectAll
) {
  const result = await scoreDocsNav(context(toolCalls, judge), {
    targets: [SSO],
    task: TASK,
  });
  return JSON.parse(result.checks?.[0]?.notes ?? '{}');
}

describe('scoreDocsNav', () => {
  it('counts hops to the target, refused jumps included', async () => {
    const navigation = await navigationOf([
      refused(`${DOCS}/${SSO}`),
      opened(DOCS),
      opened(`${DOCS}/guides/platform`),
      opened(`${DOCS}/${SSO}`),
    ]);
    expect(navigation).toMatchObject({
      hopsToTarget: 3,
      reachedTarget: SSO,
      opened: ['docs', 'guides/platform', SSO],
      blockedJumps: [SSO],
    });
  });

  it('matches targets with the variant parameter', async () => {
    const variant = '?docs-ia-mvp-v1=option-1';
    const navigation = await navigationOf([
      opened(`${DOCS}${variant}`),
      opened(`${DOCS}/${SSO}/${variant}#configure`),
    ]);
    expect(navigation).toMatchObject({
      hopsToTarget: 1,
      reachedTarget: SSO,
      opened: ['docs', SSO],
    });
  });

  it('marks a run direct when it goes straight to a target', async () => {
    const navigation = await navigationOf([
      opened(DOCS),
      opened(`${DOCS}/guides/platform`),
      opened(`${DOCS}/${SSO}`),
    ]);
    expect(navigation.direct).toBe(true);
  });

  it('is not direct when it opens a page twice', async () => {
    const navigation = await navigationOf([
      opened(DOCS),
      opened(`${DOCS}/guides/platform`),
      opened(`${DOCS}/guides/auth`),
      opened(`${DOCS}/guides/platform/`),
      opened(`${DOCS}/${SSO}`),
    ]);
    expect(navigation.direct).toBe(false);
  });

  it('is not direct when it goes back to the docs root', async () => {
    const navigation = await navigationOf([
      opened(`${DOCS}/guides/auth`),
      opened(DOCS),
      opened(`${DOCS}/${SSO}`),
    ]);
    expect(navigation.direct).toBe(false);
  });

  it('is not direct when it never reaches a target', async () => {
    const navigation = await navigationOf([opened(DOCS)]);
    expect(navigation.direct).toBe(false);
  });

  it('ignores detours after the target', async () => {
    const navigation = await navigationOf([
      opened(DOCS),
      opened(`${DOCS}/${SSO}`),
      opened(DOCS),
    ]);
    expect(navigation.direct).toBe(true);
  });

  it('judges opened pages in order when no target matches', async () => {
    const rubrics: string[] = [];
    const judge = async ({ input, rubric }: JudgeInput) => {
      rubrics.push(rubric);
      return { passed: input.includes('SAML for the dashboard') };
    };
    const navigation = await navigationOf(
      [
        opened(DOCS),
        opened(`${DOCS}/guides/auth`, 'Auth for your app'),
        opened(`${DOCS}/guides/platform/sso-moved`, 'SAML for the dashboard'),
      ],
      judge
    );
    expect(navigation).toMatchObject({
      hopsToTarget: 2,
      reachedTarget: 'guides/platform/sso-moved',
      judged: true,
    });
    expect(rubrics[0]).toContain(TASK);
  });

  it('judges page text, skipping the docs root', async () => {
    const inputs: string[] = [];
    const judge = async ({ input }: JudgeInput) => {
      inputs.push(input);
      return { passed: false };
    };
    await navigationOf(
      [opened(DOCS), opened(`${DOCS}/guides/auth`, 'Line one\nLine two')],
      judge
    );
    expect(inputs).toEqual([
      `Opened: ${DOCS}/guides/auth\n\nLine one\nLine two`,
    ]);
  });

  it('reads a refusal recorded as an error', async () => {
    const url = `${DOCS}/${SSO}`;
    const call: ToolCallRecord = {
      ...open(url, undefined),
      error: JSON.stringify([{ type: 'text', text: `Not opened: ${url}` }]),
    };
    const navigation = await navigationOf([call]);
    expect(navigation.blockedJumps).toEqual([SSO]);
  });

  it('reads a page that quotes the refusal wording as opened', async () => {
    const navigation = await navigationOf([
      opened(`${DOCS}/${SSO}`, 'If you see Not opened: start again.'),
    ]);
    expect(navigation).toMatchObject({ reachedTarget: SSO, blockedJumps: [] });
  });

  it('judges no pages when a target matches', async () => {
    const navigation = await navigationOf(
      [opened(DOCS), opened(`${DOCS}/${SSO}`)],
      async () => ({ passed: true })
    );
    expect(navigation).toMatchObject({ reachedTarget: SSO, judged: false });
  });

  it('stops judging after 10 hops', async () => {
    const inputs: string[] = [];
    const judge = async ({ input }: JudgeInput) => {
      inputs.push(input);
      return { passed: false };
    };
    const pages = Array.from({ length: 12 }, (_, hop) =>
      opened(`${DOCS}/guides/page-${hop}`, `Page ${hop}`)
    );
    const navigation = await navigationOf(pages, judge);
    expect(inputs).toHaveLength(10);
    expect(navigation).toMatchObject({ hopsToTarget: null, judged: false });
  });

  it('judges whether the answer is grounded in the reached page', async () => {
    const calls: JudgeInput[] = [];
    const judge = async (input: JudgeInput) => {
      calls.push(input);
      return { passed: false, notes: 'The answer ignores the page.' };
    };
    const result = await scoreDocsNav(
      context(
        [opened(`${DOCS}/${SSO}`, 'Configure SAML in the org settings')],
        judge
      ),
      { targets: [SSO], task: TASK }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toContain('Configure SAML in the org settings');
    expect(calls[0]?.input).toContain('Use SAML SSO.');
    expect(calls[0]?.rubric).toContain(TASK);
    expect(result.checks?.[1]).toMatchObject({
      passed: false,
      judgeNotes: 'The answer ignores the page.',
    });
    expect(result.passed).toBe(true);
  });

  it('fails the grounded check without a judge when no page is reached', async () => {
    let judgeCalls = 0;
    const judge = async () => {
      judgeCalls += 1;
      return { passed: true };
    };
    const result = await scoreDocsNav(
      context([refused(`${DOCS}/${SSO}`)], judge),
      {
        targets: [SSO],
        task: TASK,
      }
    );
    expect(judgeCalls).toBe(0);
    expect(result.checks?.[1]?.passed).toBe(false);
  });

  it('ignores tools other than open_page', async () => {
    const other: ToolCallRecord = {
      tool: { kind: 'other', toolName: 'WebFetch' },
      body: { url: `${DOCS}/${SSO}` },
      result: `Opened: ${DOCS}/${SSO}`,
      ts: 0,
    };
    const navigation = await navigationOf([other]);
    expect(navigation.hopsToTarget).toBeNull();
  });

  it('fails a run that reaches a target on the tenth hop', async () => {
    const detour = Array.from({ length: 10 }, (_, hop) =>
      opened(`${DOCS}/guides/page-${hop}`)
    );
    const navigation = await navigationOf([
      ...detour,
      opened(`${DOCS}/${SSO}`),
    ]);
    expect(navigation).toMatchObject({ hopsToTarget: 10, reached: false });
  });

  it('fails a run that never reaches a target', async () => {
    const result = await scoreDocsNav(context([opened(DOCS)]), {
      targets: [SSO],
      task: TASK,
    });
    expect(result.passed).toBe(false);
    expect(JSON.parse(result.checks?.[0]?.notes ?? '')).toMatchObject({
      hopsToTarget: null,
      reached: false,
    });
  });

  it('passes a run that reaches a target in under 10 hops', async () => {
    const result = await scoreDocsNav(context([opened(`${DOCS}/${SSO}`)]), {
      targets: [SSO],
      task: TASK,
    });
    expect(result.passed).toBe(true);
  });
});
