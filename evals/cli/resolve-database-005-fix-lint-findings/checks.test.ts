// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-005-fix-lint-findings
import { describe, expect, it } from 'vitest';
import {
  ADVISORS_CHECK,
  BEHAVIOUR_CHECK,
  checkAdvisorsClean,
  checkAppBehaviour,
  checkLintClean,
  checkReplay,
  LINT_CHECK,
  REPLAY_CHECK,
} from './checks.js';
import type {
  AdvisorFinding,
  LintIssue,
  PhaseReport,
  ProbeReport,
  ReaderResult,
} from './probe.js';

const SUB_A = '6f1c2a3e-0b7d-4c55-9a1e-2d3f4b5c6d71';
const SUB_B = 'b8e4d2c1-7a6f-4e3d-8c2b-1a0f9e8d7c62';

type OkReader = Extract<ReaderResult, { ok: true }>;

const reader = (
  sub: string,
  orders: number,
  items: number,
  totals: string[]
): OkReader => ({
  ok: true,
  role: 'authenticated',
  sub,
  orders,
  items,
  totals,
});

const failed = (
  role: 'authenticated' | 'anon',
  sub: string | null,
  sqlstate: string,
  error: string
): ReaderResult => ({ ok: false, role, sub, sqlstate, error });

const ANON_EMPTY: OkReader = {
  ok: true,
  role: 'anon',
  sub: null,
  orders: 0,
  items: 0,
  totals: [],
};

const OWN_ROWS: ReaderResult[] = [
  reader(SUB_A, 2, 3, ['30.00', '12.00']),
  reader(SUB_B, 1, 1, ['99.99']),
  ANON_EMPTY,
];

const phase = (overrides: Partial<PhaseReport> = {}): PhaseReport => ({
  advisors: [],
  advisorsDone: true,
  lint: [],
  lintDone: true,
  readers: OWN_ROWS,
  trigger: { stamped: true },
  ...overrides,
});

const ADVISOR_FINDINGS: AdvisorFinding[] = [
  {
    name: 'auth_rls_initplan',
    object: 'public.orders policy Users read their own orders',
  },
  { name: 'function_search_path_mutable', object: 'set_updated_at()' },
  { name: 'policy_exists_rls_disabled', object: 'public.order_items' },
  { name: 'rls_disabled_in_public', object: 'public.order_items' },
];

const PRICE_ERROR: LintIssue = {
  function: 'order_total(bigint)',
  level: 'error',
  message: 'column oi.price does not exist',
};

const MISSING_PRICE = 'column oi.price does not exist';
const MISSING_FUNCTION =
  'function public.order_total(p_order_id => bigint) does not exist';

const FIXED = phase();

const SEEDED = phase({
  advisors: ADVISOR_FINDINGS,
  lint: [PRICE_ERROR],
  readers: [
    failed('authenticated', SUB_A, '42703', MISSING_PRICE),
    failed('authenticated', SUB_B, '42703', MISSING_PRICE),
    { ...ANON_EMPTY, items: 4 },
  ],
});

const CHEAT_DROP = phase({
  readers: [
    failed('authenticated', SUB_A, '42883', MISSING_FUNCTION),
    failed('authenticated', SUB_B, '42883', MISSING_FUNCTION),
    failed('anon', null, '42883', MISSING_FUNCTION),
  ],
  trigger: { stamped: false },
});

const CHEAT_REVOKE = phase({
  readers: [
    failed(
      'authenticated',
      SUB_A,
      '42501',
      'permission denied for table order_items'
    ),
    failed(
      'authenticated',
      SUB_B,
      '42501',
      'permission denied for table order_items'
    ),
    failed('anon', null, '42501', 'permission denied for table order_items'),
  ],
});

const USING_TRUE = phase({
  readers: [
    reader(SUB_A, 3, 4, ['30.00', '12.00', '99.99']),
    reader(SUB_B, 3, 4, ['30.00', '12.00', '99.99']),
    ANON_EMPTY,
  ],
});

describe('check names', () => {
  it.each([
    [
      LINT_CHECK,
      'db lint reports no errors or warnings in the project functions',
    ],
    [ADVISORS_CHECK, 'advisors no longer flag the seeded findings'],
    [BEHAVIOUR_CHECK, 'the app still reads only its own orders and totals'],
    [
      REPLAY_CHECK,
      'replaying the migrations and seed reproduces the fixed database',
    ],
  ])('keeps %j stable for the results dashboard', (actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe('the three database checks against each kind of run', () => {
  it.each([
    ['the seeded database', SEEDED, false, false, false],
    [
      'a fix in a new migration, or order_total rewritten as language sql',
      FIXED,
      true,
      true,
      true,
    ],
    ['order_total dropped instead of fixed', CHEAT_DROP, true, true, false],
    [
      'every grant revoked instead of fixing the findings',
      CHEAT_REVOKE,
      true,
      true,
      false,
    ],
    ['a policy widened to using (true)', USING_TRUE, true, true, false],
  ])(
    'scores %s',
    (_label, report, lintPasses, advisorsPass, behaviourPasses) => {
      expect(checkLintClean(report).passed).toBe(lintPasses);
      expect(checkAdvisorsClean(report).passed).toBe(advisorsPass);
      expect(checkAppBehaviour(report).passed).toBe(behaviourPasses);
    }
  );

  it('names each result after its check', () => {
    expect(checkLintClean(FIXED).name).toBe(LINT_CHECK);
    expect(checkAdvisorsClean(FIXED).name).toBe(ADVISORS_CHECK);
    expect(checkAppBehaviour(FIXED).name).toBe(BEHAVIOUR_CHECK);
  });
});

describe('checkLintClean', () => {
  it('passes when the lint probe finished and found nothing', () => {
    expect(checkLintClean(FIXED)).toMatchObject({
      name: LINT_CHECK,
      passed: true,
    });
  });

  it('fails on the plpgsql error, naming the function and the message', () => {
    const result = checkLintClean(phase({ lint: [PRICE_ERROR] }));
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      'order_total(bigint): error column oi.price does not exist'
    );
  });

  it.each([
    ['error', false],
    ['warning', false],
    ['warning extra', false],
    ['warning performance', false],
    ['warning security', false],
    ['info', true],
    ['notice', true],
  ])('treats a %j issue as passing=%s', (level, passes) => {
    const result = checkLintClean(
      phase({ lint: [{ function: 'f(int)', level, message: 'something' }] })
    );
    expect(result.passed).toBe(passes);
  });

  it('lists every offending issue and leaves out the ignored levels', () => {
    const result = checkLintClean(
      phase({
        lint: [
          PRICE_ERROR,
          {
            function: 'g(int)',
            level: 'warning extra',
            message: 'unused parameter "x"',
          },
          { function: 'h(int)', level: 'info', message: 'only informational' },
        ],
      })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      'order_total(bigint): error column oi.price does not exist'
    );
    expect(result.notes).toContain(
      'g(int): warning extra unused parameter "x"'
    );
    expect(result.notes).not.toContain('only informational');
  });

  it('fails with the error when the probe reported one', () => {
    const result = checkLintClean(
      phase({
        lintError: 'function plpgsql_check_function(oid) does not exist',
      })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      'function plpgsql_check_function(oid) does not exist'
    );
  });

  it('fails when the lint probe never finished, instead of passing on an empty list', () => {
    const result = checkLintClean(phase({ lint: [], lintDone: false }));
    expect(result.passed).toBe(false);
    expect(result.notes).toBeTruthy();
  });
});

describe('checkAdvisorsClean', () => {
  it('passes when the advisor probe finished and found nothing', () => {
    expect(checkAdvisorsClean(FIXED)).toMatchObject({
      name: ADVISORS_CHECK,
      passed: true,
    });
  });

  it('fails and lists each finding as name on object', () => {
    const result = checkAdvisorsClean(phase({ advisors: ADVISOR_FINDINGS }));
    expect(result.passed).toBe(false);
    for (const { name, object } of ADVISOR_FINDINGS) {
      expect(result.notes).toContain(`${name} on ${object}`);
    }
  });

  it.each(ADVISOR_FINDINGS.map((finding) => [finding.name, finding] as const))(
    'fails when only %s is left',
    (_name, finding) => {
      expect(checkAdvisorsClean(phase({ advisors: [finding] })).passed).toBe(
        false
      );
    }
  );

  it('fails with the error when the probe reported one', () => {
    const result = checkAdvisorsClean(
      phase({ advisorsError: 'permission denied for table pg_policy' })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('permission denied for table pg_policy');
  });

  it('fails when the advisor probe never finished, instead of passing on an empty list', () => {
    const result = checkAdvisorsClean(
      phase({ advisors: [], advisorsDone: false })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toBeTruthy();
  });
});

describe('checkAppBehaviour', () => {
  it('passes when each user reads only their own rows with the right totals and the trigger stamps', () => {
    expect(checkAppBehaviour(FIXED)).toMatchObject({
      name: BEHAVIOUR_CHECK,
      passed: true,
    });
  });

  it('names the sub and the sqlstate when order_total no longer exists', () => {
    const result = checkAppBehaviour(CHEAT_DROP);
    expect(result.passed).toBe(false);
    expect(result.notes).toMatch(
      /6f1c.*function public\.order_total\(p_order_id => bigint\) does not exist \(42883\)/
    );
    expect(result.notes).toContain('updated_at trigger did not stamp the row');
  });

  it('fails when the seeded users are denied access, because the app can no longer read', () => {
    const result = checkAppBehaviour(CHEAT_REVOKE);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('(42501)');
  });

  it('fails when a user sees other users orders', () => {
    const result = checkAppBehaviour(USING_TRUE);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('6f1c');
  });

  it.each([
    ['orders', reader(SUB_A, 1, 3, ['30.00'])],
    ['items', reader(SUB_A, 2, 2, ['30.00', '12.00'])],
    ['totals', reader(SUB_A, 2, 3, ['30.00', '13.00'])],
    ['a missing total', reader(SUB_A, 2, 3, ['30.00'])],
    ['an extra total', reader(SUB_A, 2, 3, ['30.00', '12.00', '5.00'])],
  ])('fails when a user reads the wrong %s', (_what, wrong) => {
    const result = checkAppBehaviour(
      phase({ readers: [wrong, reader(SUB_B, 1, 1, ['99.99']), ANON_EMPTY] })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('6f1c');
  });

  it('fails when a seeded user has no reader row, instead of passing without them', () => {
    const result = checkAppBehaviour(
      phase({ readers: [reader(SUB_A, 2, 3, ['30.00', '12.00']), ANON_EMPTY] })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('b8e4');
  });

  it('fails when there are no reader rows at all', () => {
    expect(checkAppBehaviour(phase({ readers: [] })).passed).toBe(false);
  });

  describe('anon', () => {
    const withAnon = (anon?: ReaderResult) =>
      checkAppBehaviour(
        phase({ readers: [...OWN_ROWS.slice(0, 2), ...(anon ? [anon] : [])] })
      );

    it('passes when anon reads nothing', () => {
      expect(withAnon(ANON_EMPTY).passed).toBe(true);
    });

    it('passes when anon is denied with permission denied (42501)', () => {
      expect(
        withAnon(
          failed('anon', null, '42501', 'permission denied for table orders')
        ).passed
      ).toBe(true);
    });

    it('fails when anon is denied for any other reason', () => {
      expect(
        withAnon(failed('anon', null, '42883', MISSING_FUNCTION)).passed
      ).toBe(false);
    });

    it('fails when anon reads order_items', () => {
      const result = withAnon({ ...ANON_EMPTY, items: 4 });
      expect(result.passed).toBe(false);
      expect(result.notes).toContain('anon reads 4 order_items rows');
    });

    it('fails when anon reads orders', () => {
      const result = withAnon({ ...ANON_EMPTY, orders: 3 });
      expect(result.passed).toBe(false);
      expect(result.notes).toMatch(/anon reads 3 orders/);
    });

    it('fails when there is no anon row', () => {
      expect(withAnon().passed).toBe(false);
    });
  });

  describe('trigger', () => {
    it.each([
      ['did not stamp', { stamped: false }],
      ['could not be determined', { stamped: null }],
      ['errored', { error: 'relation "public.orders" does not exist' }],
      ['has no row', undefined],
    ] satisfies Array<[string, PhaseReport['trigger']]>)(
      'fails when the updated_at trigger %s',
      (_what, trigger) => {
        const result = checkAppBehaviour(phase({ trigger }));
        expect(result.passed).toBe(false);
        expect(result.notes).toContain('updated_at');
      }
    );

    it('says the trigger did not stamp the row', () => {
      expect(
        checkAppBehaviour(phase({ trigger: { stamped: false } })).notes
      ).toContain('updated_at trigger did not stamp the row');
    });
  });

  it('reports every failing part, not only the first', () => {
    const result = checkAppBehaviour(
      phase({
        readers: [
          reader(SUB_A, 2, 3, ['30.00', '12.00']),
          reader(SUB_B, 1, 1, ['99.99']),
          { ...ANON_EMPTY, items: 4 },
        ],
        trigger: { stamped: false },
      })
    );
    expect(result.notes).toContain('anon reads 4 order_items rows');
    expect(result.notes).toContain('updated_at trigger did not stamp the row');
  });

  describe('totals', () => {
    const EXPECTED = [{ sub: SUB_A, orders: 1, items: 1, totals: [10.5] }];
    const totalsPass = (totals: string[]) =>
      checkAppBehaviour(
        phase({ readers: [reader(SUB_A, 1, 1, totals), ANON_EMPTY] }),
        EXPECTED
      ).passed;

    it.each(['10.50', '10.5', '10.500'])(
      'accepts the numeric string %j as 10.5',
      (total) => {
        expect(totalsPass([total])).toBe(true);
      }
    );

    it.each([['10.51'], ['10.49'], ['abc'], [''], ['NaN'], ['Infinity']])(
      'rejects %j',
      (total) => {
        expect(totalsPass([total])).toBe(false);
      }
    );

    it('rejects a missing total and an extra total', () => {
      expect(totalsPass([])).toBe(false);
      expect(totalsPass(['10.50', '10.50'])).toBe(false);
    });

    it('compares the totals as numbers, not strings, so 30.00 equals 30', () => {
      const result = checkAppBehaviour(
        phase({ readers: [reader(SUB_A, 1, 1, ['30.00']), ANON_EMPTY] }),
        [{ sub: SUB_A, orders: 1, items: 1, totals: [30] }]
      );
      expect(result.passed).toBe(true);
    });

    it('ignores the order the totals arrive in', () => {
      expect(
        checkAppBehaviour(
          phase({
            readers: [reader(SUB_A, 2, 2, ['12.00', '30.00']), ANON_EMPTY],
          }),
          [{ sub: SUB_A, orders: 2, items: 2, totals: [30, 12] }]
        ).passed
      ).toBe(true);
    });

    it('compares totals as a multiset, so a repeated value cannot stand in for another', () => {
      const expected = [{ sub: SUB_A, orders: 3, items: 3, totals: [5, 5, 7] }];
      const run = (totals: string[]) =>
        checkAppBehaviour(
          phase({ readers: [reader(SUB_A, 3, 3, totals), ANON_EMPTY] }),
          expected
        ).passed;
      expect(run(['7.00', '5.00', '5.00'])).toBe(true);
      expect(run(['5.00', '7.00', '7.00'])).toBe(false);
    });
  });

  it('checks only the readers it is given', () => {
    const result = checkAppBehaviour(
      phase({ readers: [reader(SUB_B, 1, 1, ['99.99']), ANON_EMPTY] }),
      [{ sub: SUB_B, orders: 1, items: 1, totals: [99.99] }]
    );
    expect(result.passed).toBe(true);
  });
});

describe('checkReplay', () => {
  const report = (overrides: Partial<ProbeReport> = {}): ProbeReport => ({
    live: SEEDED,
    replay: { ok: true, files: 5 },
    replayed: FIXED,
    unparsed: [],
    ...overrides,
  });

  it('passes when the files replay and the replayed database passes all three checks', () => {
    const result = checkReplay(report());
    expect(result).toMatchObject({ name: REPLAY_CHECK, passed: true });
    expect(result.notes).toMatch(/\b5 files?\b/);
  });

  it('ignores what the live database looked like', () => {
    expect(checkReplay(report({ live: SEEDED })).passed).toBe(true);
    expect(checkReplay(report({ live: FIXED })).passed).toBe(true);
  });

  it('fails when the replay did not run', () => {
    const result = checkReplay(report({ replay: undefined }));
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('replay did not run');
  });

  it('fails with the file, error and sqlstate when a file does not replay', () => {
    const result = checkReplay(
      report({
        replay: {
          ok: false,
          file: '20261022000000_fix.sql',
          sqlstate: '42710',
          error: 'extension "pgcrypto" already exists',
        },
      })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toBe(
      '20261022000000_fix.sql: extension "pgcrypto" already exists (42710)'
    );
  });

  it('fails when the replayed database still has the seeded findings, naming each failing aspect', () => {
    const result = checkReplay(report({ replayed: SEEDED }));
    expect(result.passed).toBe(false);
    expect(result.notes).toMatch(/lint/i);
    expect(result.notes).toContain(
      'order_total(bigint): error column oi.price does not exist'
    );
    expect(result.notes).toMatch(/advisor/i);
    expect(result.notes).toContain(
      'rls_disabled_in_public on public.order_items'
    );
    expect(result.notes).toMatch(/behaviou?r|app/i);
    expect(result.notes).toContain('(42703)');
  });

  it('names only the aspect that failed when just the behaviour does', () => {
    const result = checkReplay(report({ replayed: CHEAT_DROP }));
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('(42883)');
    expect(result.notes).not.toMatch(/lint|advisor/i);
  });

  it('names lint when only lint fails', () => {
    const result = checkReplay(
      report({ replayed: phase({ lint: [PRICE_ERROR] }) })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toMatch(/lint/i);
    expect(result.notes).not.toMatch(/advisor/i);
  });

  it('names the advisors when only the advisors fail', () => {
    const result = checkReplay(
      report({ replayed: phase({ advisors: [ADVISOR_FINDINGS[3]] }) })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toMatch(/advisor/i);
    expect(result.notes).not.toMatch(/lint/i);
  });

  it('fails when the replayed probes never finished, instead of passing on empty results', () => {
    const result = checkReplay(
      report({
        replayed: {
          advisors: [],
          advisorsDone: false,
          lint: [],
          lintDone: false,
          readers: [],
        },
      })
    );
    expect(result.passed).toBe(false);
  });
});
