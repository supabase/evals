import { describe, expect, it } from 'vitest';
import type { Navigation } from './navigation.js';
import { buildReport, type CaseRun } from './report.js';

function run(overrides: Partial<Navigation> = {}, grounded = true): CaseRun {
  return {
    grounded,
    navigation: {
      hopsToTarget: 2,
      reachedTarget: 'guides/platform/sso',
      direct: true,
      judged: false,
      opened: ['docs', 'guides/platform', 'guides/platform/sso'],
      blockedJumps: [],
      severity: 'clean',
      ...overrides,
    },
  };
}

const missed = run(
  {
    hopsToTarget: null,
    reachedTarget: null,
    direct: false,
    severity: 'big failure',
  },
  false
);

describe('buildReport', () => {
  it('counts a case as reached or direct when most of its runs are', () => {
    const { totals } = buildReport({
      control: {
        'deploy-nav-001': [run(), run({ direct: false }), missed],
        'deploy-nav-002': [run(), missed, missed],
      },
    });
    expect(totals).toEqual({ control: { cases: 2, reached: 1, direct: 0 } });
  });

  it('renders a row per case and a totals row', () => {
    const { table } = buildReport({
      control: {
        'deploy-nav-002': [missed],
        'deploy-nav-001': [
          run({ hopsToTarget: 1 }),
          run({ hopsToTarget: 5, direct: false, judged: true }, false),
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
        '| deploy-nav-001 | reached 3/3, direct 2/3, 2 hops, 1 judged, 1 blocked, grounded 2/3 | reached 1/1, direct 1/1, 2 hops, 0 judged, 0 blocked, grounded 1/1 |',
        '| deploy-nav-002 | reached 0/1, direct 0/1, – hops, 0 judged, 0 blocked, grounded 0/1 | no runs |',
        '| Cases reached, direct | 1/2, 1/2 | 1/1, 1/1 |',
      ].join('\n')
    );
  });
});
