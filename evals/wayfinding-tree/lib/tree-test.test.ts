// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/wayfinding-tree/lib
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import type { DocsTree } from '../../../experiments/docs/lib/docs-tree.js';
import {
  createTreeSession,
  decodeTree,
  encodeTree,
} from '../../../experiments/docs/lib/tree-navigator.mjs';
import { scoreTreeTest } from './tree-test.js';

const TREE: DocsTree = {
  name: 'fixture',
  description: 'A small tree for tests.',
  root: {
    label: 'Docs',
    children: [
      {
        label: 'Products',
        children: [
          {
            label: 'Database',
            route: '/guides/database/overview',
            children: [
              { label: 'Connecting', route: '/guides/database/connecting' },
              { label: 'SSL', route: '/guides/platform/ssl-enforcement' },
            ],
          },
        ],
      },
      {
        label: 'Manage',
        children: [
          {
            label: 'Organization',
            children: [
              { label: 'SSO', route: '/guides/platform/sso' },
              {
                label: 'Audit logs',
                route: '/guides/security/platform-audit-logs',
              },
            ],
          },
        ],
      },
    ],
  },
};

/** Plays moves through a real navigator session and records them as tool calls. */
function play(
  moves: [tool: 'open' | 'choose', id: string][]
): ToolCallRecord[] {
  const session = createTreeSession(decodeTree(encodeTree(TREE)));
  return moves.map(([tool, id]) => {
    const move = session[tool](id);
    return {
      tool: {
        kind: 'mcp',
        server: 'tree-navigator',
        toolName: tool === 'open' ? 'open_section' : 'choose_page',
      },
      body: { id },
      result: [{ type: 'text', text: move.text }],
      ts: 0,
    };
  });
}

const score = (
  calls: ToolCallRecord[],
  targets: string[],
  alternates?: string[]
) => scoreTreeTest(calls, targets, alternates, () => TREE);

describe('tree navigator', () => {
  it('shows labels only, and refuses sections it has not listed', () => {
    const session = createTreeSession(decodeTree(encodeTree(TREE)));
    expect(session.open('2').isError).toBe(true);
    const top = session.open('root');
    expect(top.text).toContain('[2] Manage (a section)');
    expect(top.text).not.toContain('/guides');
    expect(session.open('2').text).toContain('[2.1] Organization');
  });

  it('chooses pages, not headings, and only once', () => {
    const session = createTreeSession(decodeTree(encodeTree(TREE)));
    session.open('root');
    session.open('2');
    expect(session.choose('2.1').isError).toBe(true);
    session.open('2.1');
    expect(session.choose('2.1.1').text).toContain(
      'Route: /guides/platform/sso'
    );
    expect(session.choose('2.1.2').isError).toBe(true);
  });
});

describe('scoreTreeTest', () => {
  it('scores a direct success', () => {
    const run = score(
      play([
        ['open', 'root'],
        ['open', '2'],
        ['open', '2.1'],
        ['choose', '2.1.1'],
      ]),
      ['guides/platform/sso']
    );
    expect(run).toMatchObject({
      tree: 'fixture',
      success: true,
      outcome: 'direct success',
      pathLength: 2,
      backtracks: 0,
      firstClick: { trail: 'Manage', correct: true },
      sawTarget: true,
      severity: 'clean',
    });
  });

  it('counts going back as a backtrack and an extra click', () => {
    const run = score(
      play([
        ['open', 'root'],
        ['open', '1'],
        ['open', '1.1'],
        ['open', 'root'],
        ['open', '2'],
        ['open', '2.1'],
        ['choose', '2.1.1'],
      ]),
      ['guides/platform/sso']
    );
    expect(run).toMatchObject({
      outcome: 'indirect success',
      pathLength: 5,
      backtracks: 1,
      firstClick: { trail: 'Products', correct: false },
      severity: 'friction',
    });
  });

  it('fails a wrong page, and credits a page that is a group too', () => {
    const wrong = score(
      play([
        ['open', 'root'],
        ['open', '1'],
        ['open', '1.1'],
        ['choose', '1.1.1'],
      ]),
      ['guides/platform/ssl-enforcement']
    );
    expect(wrong).toMatchObject({
      success: false,
      outcome: 'direct failure',
      sawTarget: true,
      firstClick: { correct: true },
      severity: 'big failure',
    });

    const alternate = score(
      play([
        ['open', 'root'],
        ['open', '1'],
        ['choose', '1.1'],
      ]),
      ['guides/platform/ssl-enforcement'],
      ['guides/database/overview']
    );
    expect(alternate).toMatchObject({
      success: true,
      viaAlternate: true,
      pathLength: 1,
    });
  });

  it('counts refused moves and a run that never chooses as a skip', () => {
    const run = score(
      play([
        ['open', '2.1'],
        ['open', 'root'],
        ['open', '2'],
      ]),
      ['guides/platform/sso']
    );
    expect(run).toMatchObject({
      outcome: 'skip',
      refused: 1,
      chosen: null,
      severity: 'big failure',
    });
  });
});
