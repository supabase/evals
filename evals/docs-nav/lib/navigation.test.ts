import type {
  JudgeInput,
  JudgeResult,
  ToolCallRecord,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { type NavTree, scoreDocsNav } from './navigation.js';

const DOCS = 'https://supabase.com/docs';
const VARIANT = '?docs-ia-mvp-v1=option-1';
const SSO = 'guides/platform/sso';
const API_KEYS = 'guides/getting-started/api-keys';
const ROTATE = 'guides/security/rotate-leaked-api-keys';
const TASK = 'Set up Google Workspace sign-in for our Supabase dashboard.';

const TODAY: NavTree = {
  name: 'today',
  root: {
    label: 'Supabase Docs',
    children: [
      {
        label: 'Start',
        route: '/guides/getting-started',
        children: [{ label: 'API Keys', route: `/${API_KEYS}` }],
      },
      {
        label: 'Manage',
        route: '/guides/platform',
        children: [
          {
            label: 'Platform Management',
            children: [{ label: 'SSO', route: `/${SSO}` }],
          },
        ],
      },
      {
        label: 'Products',
        children: [{ label: 'Auth', route: '/guides/auth' }],
      },
    ],
  },
};

const OPTION_1: NavTree = {
  name: 'option-1',
  root: {
    label: 'Supabase Docs',
    children: [
      {
        label: 'Run and manage',
        children: [
          {
            label: 'Team',
            route: '/guides/platform/team',
            children: [{ label: 'SSO', route: `/${SSO}` }],
          },
          {
            label: 'Security',
            route: '/guides/security',
            children: [{ label: 'Rotate a leaked key', route: `/${ROTATE}` }],
          },
        ],
      },
    ],
  },
};

function fakeTrees() {
  const requested: string[] = [];
  async function fetchTree(url: string) {
    requested.push(url);
    return url.includes('option-1') ? OPTION_1 : TODAY;
  }
  return { fetchTree, requested };
}

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

function pages(...paths: string[]) {
  return paths.map((path) => opened(path ? `${DOCS}/${path}` : DOCS));
}

type Judge = (input: JudgeInput) => Promise<JudgeResult>;

function context(toolCalls: ToolCallRecord[], judge: Judge = rejectAll) {
  return { toolCalls, agentReport: 'Use SAML SSO.', judge };
}

async function rejectAll(): Promise<JudgeResult> {
  return { passed: false };
}

async function score(
  toolCalls: ToolCallRecord[],
  {
    judge = rejectAll,
    targets = [SSO],
    controlTargets,
  }: { judge?: Judge; targets?: string[]; controlTargets?: string[] } = {}
) {
  return scoreDocsNav(context(toolCalls, judge), {
    targets,
    controlTargets,
    task: TASK,
    fetchTree: fakeTrees().fetchTree,
  });
}

async function navigationOf(
  toolCalls: ToolCallRecord[],
  options?: Parameters<typeof score>[1]
) {
  const result = await score(toolCalls, options);
  return JSON.parse(result.checks?.[0]?.notes ?? '{}');
}

describe('scoreDocsNav', () => {
  it('counts hops to the target, refused jumps included', async () => {
    const navigation = await navigationOf([
      refused(`${DOCS}/${SSO}`),
      ...pages('', 'guides/platform', SSO),
    ]);
    expect(navigation).toMatchObject({
      hopsToTarget: 3,
      reachedTarget: SSO,
      opened: ['docs', 'guides/platform', SSO],
      blockedJumps: [SSO],
    });
  });

  it("loads the tree for the run's variant from the docs it opened", async () => {
    const preview = 'https://docs-git-ia-nav-supabase.vercel.app/docs';
    const trees = fakeTrees();
    const run = async (variant: string) =>
      scoreDocsNav(
        context([
          opened(`${preview}${variant}`),
          opened(`${preview}/${SSO}${variant}#configure`),
        ]),
        { targets: [SSO], task: TASK, fetchTree: trees.fetchTree }
      );
    const option1 = await run(VARIANT);
    await run('');
    expect(trees.requested).toEqual([
      'https://docs-git-ia-nav-supabase.vercel.app/docs/nav-tree.json?docs-ia-mvp-v1=option-1',
      'https://docs-git-ia-nav-supabase.vercel.app/docs/nav-tree.json',
    ]);
    expect(JSON.parse(option1.checks?.[0]?.notes ?? '')).toMatchObject({
      variant: 'option-1',
      reachedTarget: SSO,
      maxHops: 3,
    });
  });

  it("records the case's group", async () => {
    const result = await scoreDocsNav(context(pages('', SSO)), {
      targets: [SSO],
      group: 'set-aside',
      task: TASK,
      fetchTree: fakeTrees().fetchTree,
    });
    expect(JSON.parse(result.checks?.[0]?.notes ?? '')).toMatchObject({
      group: 'set-aside',
    });
  });

  it('has no wrong turns when every page leads to the target', async () => {
    const navigation = await navigationOf(pages('', 'guides/platform', SSO));
    expect(navigation).toMatchObject({ wrongTurns: [], noWrongTurns: true });
  });

  it('allows skipping levels of the tree', async () => {
    const navigation = await navigationOf(pages('', SSO));
    expect(navigation.noWrongTurns).toBe(true);
  });

  it('counts a page off the path to the target as a wrong turn', async () => {
    const navigation = await navigationOf(
      pages('', 'guides/auth', 'guides/platform', SSO)
    );
    expect(navigation).toMatchObject({
      reached: true,
      wrongTurns: ['guides/auth'],
      noWrongTurns: false,
    });
  });

  it('counts a page outside the tree as a wrong turn', async () => {
    const navigation = await navigationOf(
      pages('', 'guides/somewhere-else', SSO)
    );
    expect(navigation.wrongTurns).toEqual(['guides/somewhere-else']);
  });

  it("judges wrong turns against the variant's tree", async () => {
    const viaManage = await navigationOf([
      opened(`${DOCS}${VARIANT}`),
      opened(`${DOCS}/guides/platform${VARIANT}`),
      opened(`${DOCS}/${SSO}${VARIANT}`),
    ]);
    const viaTeam = await navigationOf([
      opened(`${DOCS}${VARIANT}`),
      opened(`${DOCS}/guides/platform/team${VARIANT}`),
      opened(`${DOCS}/${SSO}${VARIANT}`),
    ]);
    expect(viaManage.wrongTurns).toEqual(['guides/platform']);
    expect(viaTeam.noWrongTurns).toBe(true);
  });

  it('ignores pages opened after the target', async () => {
    const navigation = await navigationOf(pages('', SSO, 'guides/auth'));
    expect(navigation.noWrongTurns).toBe(true);
  });

  it('has wrong turns when it never reaches a target', async () => {
    const navigation = await navigationOf(pages(''));
    expect(navigation.noWrongTurns).toBe(false);
  });

  it('accepts control targets only on control runs', async () => {
    const options = { targets: [ROTATE], controlTargets: [API_KEYS] };
    const control = await navigationOf(pages('', API_KEYS), options);
    const option1 = await navigationOf(
      [opened(`${DOCS}${VARIANT}`), opened(`${DOCS}/${API_KEYS}${VARIANT}`)],
      options
    );
    expect(control).toMatchObject({ reached: true, noWrongTurns: true });
    expect(option1.reached).toBe(false);
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
      { judge }
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
      { judge }
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
    const navigation = await navigationOf(pages('', SSO), {
      judge: async () => ({ passed: true }),
    });
    expect(navigation).toMatchObject({ reachedTarget: SSO, judged: false });
  });

  it('stops judging past the tree depth', async () => {
    const inputs: string[] = [];
    const judge = async ({ input }: JudgeInput) => {
      inputs.push(input);
      return { passed: false };
    };
    const detour = Array.from({ length: 8 }, (_, hop) =>
      opened(`${DOCS}/guides/page-${hop}`, `Page ${hop}`)
    );
    const navigation = await navigationOf(detour, { judge });
    expect(inputs).toHaveLength(4);
    expect(navigation).toMatchObject({ hopsToTarget: null, judged: false });
  });

  it('loads no tree when no page opened', async () => {
    const trees = fakeTrees();
    const result = await scoreDocsNav(context([refused(`${DOCS}/${SSO}`)]), {
      targets: [SSO],
      task: TASK,
      fetchTree: trees.fetchTree,
    });
    expect(trees.requested).toEqual([]);
    expect(JSON.parse(result.checks?.[0]?.notes ?? '')).toMatchObject({
      maxHops: null,
      reached: false,
    });
  });

  it('judges whether the answer is grounded in the reached page', async () => {
    const calls: JudgeInput[] = [];
    const judge = async (input: JudgeInput) => {
      calls.push(input);
      return { passed: false, notes: 'The answer ignores the page.' };
    };
    const result = await score(
      [opened(`${DOCS}/${SSO}`, 'Configure SAML in the org settings')],
      { judge }
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
    const result = await score([refused(`${DOCS}/${SSO}`)], { judge });
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

  it('fails a run that takes more hops than the tree is deep', async () => {
    const detour = Array.from({ length: 4 }, (_, hop) =>
      opened(`${DOCS}/guides/page-${hop}`)
    );
    const navigation = await navigationOf([
      ...detour,
      opened(`${DOCS}/${SSO}`),
    ]);
    expect(navigation).toMatchObject({
      hopsToTarget: 4,
      maxHops: 3,
      reached: false,
    });
  });

  it('fails a run that never reaches a target', async () => {
    const result = await score(pages(''));
    expect(result.passed).toBe(false);
    expect(JSON.parse(result.checks?.[0]?.notes ?? '')).toMatchObject({
      hopsToTarget: null,
      reached: false,
    });
  });

  it('passes a run that reaches a target within the tree depth', async () => {
    const result = await score(
      pages('', 'guides/platform', 'guides/auth', SSO)
    );
    expect(result.passed).toBe(true);
  });
});

const TREE_URL = 'https://supabase.com/docs/nav-tree.json';

function treeCall(toolName: string, id: string, text: string): ToolCallRecord {
  return {
    tool: { kind: 'mcp', server: 'docs-tree-navigator', toolName },
    body: { id },
    result: [{ type: 'text', text }],
    ts: 0,
  };
}

function openSection(id: string, url = TREE_URL) {
  const tree = id === 'root' ? `\nTree: ${url}` : '';
  return treeCall(
    'open_section',
    id,
    `Opened: [${id}]${tree}\n\nIn this section:`
  );
}

function refusedSection(id: string) {
  return treeCall('open_section', id, `Not allowed: ${id} isn't listed.`);
}

function choosePage(id: string, url = TREE_URL) {
  return treeCall('choose_page', id, `Chosen: [${id}]\nTree: ${url}`);
}

async function treeNavigationOf(
  toolCalls: ToolCallRecord[],
  options: { targets?: string[]; controlTargets?: string[] } = {}
) {
  const result = await score(toolCalls, options);
  return { result, navigation: JSON.parse(result.checks?.[0]?.notes ?? '{}') };
}

describe('scoreDocsNav on a tree test', () => {
  it('passes a direct choice of a target', async () => {
    const { result, navigation } = await treeNavigationOf([
      openSection('root'),
      openSection('2'),
      openSection('2.1'),
      choosePage('2.1.1'),
    ]);
    expect(navigation).toMatchObject({
      reached: true,
      hopsToTarget: 2,
      chosen: SSO,
      wrongTurns: [],
      noWrongTurns: true,
      maxHops: 3,
    });
    expect(result.checks).toHaveLength(1);
  });

  it('counts a section off the path, and going back from it, as wrong turns', async () => {
    const { navigation } = await treeNavigationOf([
      openSection('root'),
      openSection('3'),
      openSection('2'),
      openSection('2.1'),
      choosePage('2.1.1'),
    ]);
    expect(navigation).toMatchObject({
      reached: true,
      wrongTurns: ['3 Products', '2 Manage'],
      noWrongTurns: false,
    });
  });

  it('allows opening a second-level section straight from the top', async () => {
    const { navigation } = await treeNavigationOf([
      openSection('root'),
      openSection('2.1'),
      choosePage('2.1.1'),
    ]);
    expect(navigation).toMatchObject({ reached: true, noWrongTurns: true });
  });

  it('counts going back up the path as a wrong turn', async () => {
    const { navigation } = await treeNavigationOf([
      openSection('root'),
      openSection('2'),
      openSection('2.1'),
      openSection('2'),
      openSection('2.1'),
      choosePage('2.1.1'),
    ]);
    expect(navigation.wrongTurns).toEqual(['2 Manage']);
  });

  it('fails a choice of a page that is not a target', async () => {
    const { navigation } = await treeNavigationOf([
      openSection('root'),
      openSection('3'),
      choosePage('3.1'),
    ]);
    expect(navigation).toMatchObject({
      reached: false,
      chosen: 'guides/auth',
      reachedTarget: null,
    });
  });

  it("loads the variant's tree from the url the navigator reports", async () => {
    const url = `${TREE_URL}?docs-ia-mvp-v1=option-1`;
    const trees = fakeTrees();
    const result = await scoreDocsNav(
      context([
        openSection('root', url),
        openSection('1'),
        openSection('1.1'),
        choosePage('1.1.1', url),
      ]),
      { targets: [SSO], task: TASK, fetchTree: trees.fetchTree }
    );
    expect(trees.requested).toEqual([url]);
    expect(JSON.parse(result.checks?.[0]?.notes ?? '')).toMatchObject({
      variant: 'option-1',
      reached: true,
      noWrongTurns: true,
    });
  });

  it('accepts control targets only on control runs', async () => {
    const options = { targets: [ROTATE], controlTargets: [API_KEYS] };
    const { navigation } = await treeNavigationOf(
      [openSection('root'), openSection('1'), choosePage('1.1')],
      options
    );
    expect(navigation).toMatchObject({ reached: true, noWrongTurns: true });
  });

  it('counts a refused open as a click', async () => {
    const { navigation } = await treeNavigationOf([
      openSection('root'),
      refusedSection('2.1'),
      openSection('2'),
      openSection('2.1'),
      choosePage('2.1.1'),
    ]);
    expect(navigation).toMatchObject({
      hopsToTarget: 3,
      blockedJumps: ['2.1'],
      noWrongTurns: true,
    });
  });

  it('fails a choice that takes more clicks than the tree is deep', async () => {
    const { navigation } = await treeNavigationOf([
      openSection('root'),
      openSection('1'),
      openSection('3'),
      openSection('2'),
      openSection('2.1'),
      choosePage('2.1.1'),
    ]);
    expect(navigation).toMatchObject({ hopsToTarget: 4, reached: false });
  });
});
