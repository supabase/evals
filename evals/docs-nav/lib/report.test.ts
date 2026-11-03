import { describe, expect, it } from 'vitest';
import type { Navigation } from './navigation.js';
import { buildReport, type CaseRun } from './report.js';

function run(overrides: Partial<Navigation> = {}, grounded = true): CaseRun {
  return {
    grounded,
    navigation: {
      variant: null,
      maxHops: 5,
      hopsToTarget: 2,
      reachedTarget: 'guides/platform/sso',
      wrongTurns: [],
      noWrongTurns: true,
      judged: false,
      opened: ['docs', 'guides/platform', 'guides/platform/sso'],
      blockedJumps: [],
      reached: true,
      ...overrides,
    },
  };
}

const missed = run(
  {
    hopsToTarget: null,
    reachedTarget: null,
    noWrongTurns: false,
    reached: false,
  },
  false
);

describe('buildReport', () => {
  it('counts a case as reached or with no wrong turns when most of its runs are', () => {
    const { totals } = buildReport({
      control: {
        'deploy-nav-001': [
          run(),
          run({ wrongTurns: ['guides/auth'], noWrongTurns: false }),
          missed,
        ],
        'deploy-nav-002': [run(), missed, missed],
      },
    });
    expect(totals).toEqual({
      control: { cases: 2, noWrongTurns: 0, reached: 1 },
    });
  });

  it('renders a row per case and a totals row', () => {
    const { table } = buildReport({
      control: {
        'deploy-nav-002': [missed],
        'deploy-nav-001': [
          run({ hopsToTarget: 1 }),
          run(
            {
              hopsToTarget: 5,
              wrongTurns: ['guides/auth'],
              noWrongTurns: false,
              judged: true,
            },
            false
          ),
          run({ blockedJumps: ['guides/platform/sso'] }),
        ],
      },
      'option-1': {
        'deploy-nav-001': [run()],
      },
    });
    expect(table).toBe(
      [
        '| Case | control | option-1 |',
        '| --- | --- | --- |',
        '| deploy-nav-001 | no wrong turns 2/3, reached 3/3, 2 hops, 1 judged, 1 blocked, grounded 2/3 | no wrong turns 1/1, reached 1/1, 2 hops, 0 judged, 0 blocked, grounded 1/1 |',
        '| deploy-nav-002 | no wrong turns 0/1, reached 0/1, – hops, 0 judged, 0 blocked, grounded 0/1 | no runs |',
        '| Cases with no wrong turns, reached | 1/2, 1/2 | 1/1, 1/1 |',
      ].join('\n')
    );
  });
});
