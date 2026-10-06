// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/wayfinding/lib
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { docsPath, scoreNavigation, severityOf } from './wayfinding.js';

const DOCS = 'https://supabase.com/docs';
const SSO = 'guides/platform/sso';

function open(url: string, reply: unknown): ToolCallRecord {
  return {
    tool: { kind: 'mcp', server: 'docs-navigator', toolName: 'open_page' },
    body: { url },
    result: reply,
    ts: 0,
  };
}

const opened = (url: string) => [
  { type: 'text', text: `Opened: ${url}\n\nPage text` },
];
const refused = (url: string) => `Not opened: ${url} isn't linked`;

describe('docsPath', () => {
  it('drops the docs prefix, .md, and trailing slashes', () => {
    expect(docsPath(`${DOCS}/${SSO}.md`)).toBe(SSO);
    expect(docsPath(`${DOCS}/${SSO}/`)).toBe(SSO);
    expect(docsPath(DOCS)).toBe('docs');
  });
});

describe('scoreNavigation', () => {
  it('counts hops to the target, refused memory jumps included', () => {
    const navigation = scoreNavigation(
      [
        open(`${DOCS}/${SSO}`, refused(`${DOCS}/${SSO}`)),
        open(DOCS, opened(DOCS)),
        open(`${DOCS}/guides/platform`, opened(`${DOCS}/guides/platform`)),
        open(`${DOCS}/${SSO}`, opened(`${DOCS}/${SSO}`)),
      ],
      [SSO]
    );
    expect(navigation).toEqual({
      hopsToTarget: 3,
      reachedTarget: SSO,
      viaAlternate: false,
      opened: ['docs', 'guides/platform', SSO],
      blockedJumps: [SSO],
      severity: 'clean',
    });
  });

  it('scores the page a redirect landed on', () => {
    const navigation = scoreNavigation(
      [
        open(
          `${DOCS}/guides/platform/going-into-prod`,
          JSON.stringify(opened(`${DOCS}/guides/deployment/going-into-prod`))
        ),
      ],
      ['guides/deployment/going-into-prod']
    );
    expect(navigation.hopsToTarget).toBe(0);
  });

  it('records an alternate', () => {
    const navigation = scoreNavigation(
      [open(`${DOCS}/guides/cron`, opened(`${DOCS}/guides/cron`))],
      ['guides/functions/schedule-functions'],
      ['guides/cron']
    );
    expect(navigation).toMatchObject({
      reachedTarget: 'guides/cron',
      viaAlternate: true,
    });
  });

  it('is a big failure when the agent never reaches a target', () => {
    const navigation = scoreNavigation([open(DOCS, opened(DOCS))], [SSO]);
    expect(navigation).toMatchObject({
      hopsToTarget: null,
      severity: 'big failure',
    });
  });

  it('ignores tools other than open_page', () => {
    const other: ToolCallRecord = {
      tool: { kind: 'other', toolName: 'WebFetch' },
      body: { url: `${DOCS}/${SSO}` },
      result: `Opened: ${DOCS}/${SSO}`,
      ts: 0,
    };
    expect(scoreNavigation([other], [SSO]).hopsToTarget).toBeNull();
  });
});

describe('severityOf', () => {
  it('bands hops, with ten or more and never reached as big failures', () => {
    expect(
      [0, 3, 4, 6, 7, 9, 10, null].map((hops) => severityOf(hops))
    ).toEqual([
      'clean',
      'clean',
      'friction',
      'friction',
      'failure',
      'failure',
      'big failure',
      'big failure',
    ]);
  });
});
