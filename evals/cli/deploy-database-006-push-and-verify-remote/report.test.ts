// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-006-push-and-verify-remote
import { describe, expect, it } from 'vitest';
import { BASE_VERSION, HOSTED_REF, PLANS_VERSION } from './fixtures.js';
import {
  NO_HOSTED_PROJECT,
  type Probe,
  type RemoteData,
  type RemoteSchema,
} from './remote.js';
import { describeGroundTruth } from './report.js';

type Facts = Parameters<typeof describeGroundTruth>[0];

const ok = <T>(value: T): Probe<T> => ({ ok: true, value });
const down = (notes: string): { ok: false; notes: string } => ({
  ok: false,
  notes,
});

const GOOD_SCHEMA: RemoteSchema = {
  plansColumns: ['id', 'name', 'monthly_price_cents'],
  planId: { nullable: false, referencesPlans: true },
};

const GOOD_DATA: RemoteData = {
  plansTable: true,
  planIds: ['free', 'pro'],
  profiles: 24,
  seededProfiles: 24,
  paid: 6,
  onPro: 6,
  onFree: 18,
  misassigned: 0,
};

const GOOD: Facts = {
  hostedRef: HOSTED_REF,
  history: ok([BASE_VERSION, PLANS_VERSION]),
  schema: ok(GOOD_SCHEMA),
  data: ok(GOOD_DATA),
  link: { ok: true, ref: null },
};

const facts = (overrides: Partial<Facts>): Facts => ({ ...GOOD, ...overrides });
const dataWith = (overrides: Partial<RemoteData>) =>
  ok({ ...GOOD_DATA, ...overrides });

const HOSTED = '- hosted project available:';
const HISTORY = '- hosted migration history includes 20261020120000_add_plans:';
const PLANS = '- hosted public.plans:';
const PLAN_ID = '- hosted public.profiles.plan_id:';
const PROFILES = '- hosted public.profiles:';
const LINK = '- repo linked to a project (supabase/.temp/project-ref):';

const lineFor = (overrides: Partial<Facts>, prefix: string) =>
  describeGroundTruth(facts(overrides)).find((line) =>
    line.startsWith(prefix)
  ) ?? '';

describe('describeGroundTruth', () => {
  it('lists the six facts in order when the hosted project is correct', () => {
    const lines = describeGroundTruth(GOOD);

    expect(lines).toHaveLength(6);
    expect(
      [HOSTED, HISTORY, PLANS, PLAN_ID, PROFILES, LINK].map((prefix, index) =>
        lines[index]?.startsWith(prefix)
      )
    ).toEqual([true, true, true, true, true, true]);
  });

  it('puts the link line last', () => {
    const lines = describeGroundTruth(GOOD);

    expect(lines[5]?.startsWith(LINK)).toBe(true);
  });

  describe('hosted project line', () => {
    it('names the hosted ref', () => {
      expect(lineFor({}, HOSTED)).toBe(`${HOSTED} ${HOSTED_REF}`);
    });

    it('says none, with the reason, when the run has no hosted project', () => {
      expect(lineFor({ hostedRef: undefined }, HOSTED)).toBe(
        `${HOSTED} none (${NO_HOSTED_PROJECT})`
      );
    });

    it('never names the hosted ref anywhere when the run has no hosted project', () => {
      const lines = describeGroundTruth(
        facts({
          hostedRef: undefined,
          history: down(NO_HOSTED_PROJECT),
          schema: down(NO_HOSTED_PROJECT),
          data: down(NO_HOSTED_PROJECT),
        })
      );

      expect(lines.join('\n')).not.toContain(HOSTED_REF);
    });
  });

  describe('migration history line', () => {
    it('says yes when the plans migration is recorded', () => {
      expect(lineFor({}, HISTORY)).toBe(`${HISTORY} yes`);
    });

    it('says yes when unrelated versions are recorded too', () => {
      expect(
        lineFor(
          { history: ok([BASE_VERSION, '20261101000000', PLANS_VERSION]) },
          HISTORY
        )
      ).toBe(`${HISTORY} yes`);
    });

    it('says no, listing the versions it found, when the migration is not recorded', () => {
      const line = lineFor({ history: ok([BASE_VERSION]) }, HISTORY);

      expect(line.startsWith(`${HISTORY} no (versions:`)).toBe(true);
      expect(line).toContain(BASE_VERSION);
      expect(line.slice(HISTORY.length)).not.toContain(PLANS_VERSION);
    });

    it('says no for an empty history', () => {
      expect(
        lineFor({ history: ok([]) }, HISTORY).startsWith(`${HISTORY} no`)
      ).toBe(true);
    });

    it('says unavailable, with the reason, when the history could not be read', () => {
      expect(lineFor({ history: down('connection refused') }, HISTORY)).toBe(
        `${HISTORY} unavailable (connection refused)`
      );
    });
  });

  describe('plans table line', () => {
    it('lists the columns and the plan ids', () => {
      const line = lineFor({}, PLANS);

      expect(line.startsWith(`${PLANS} columns`)).toBe(true);
      for (const word of [
        'id',
        'name',
        'monthly_price_cents',
        'plan ids',
        'free',
        'pro',
      ]) {
        expect(line).toContain(word);
      }
      expect(line).not.toMatch(/missing|unavailable/);
    });

    it('shows an extra plan row the judge could otherwise miss', () => {
      const line = lineFor(
        { data: dataWith({ planIds: ['enterprise', 'free', 'pro'] }) },
        PLANS
      );

      expect(line).toContain('enterprise');
    });

    it('says missing when the table does not exist', () => {
      expect(
        lineFor(
          {
            schema: ok({ ...GOOD_SCHEMA, plansColumns: [] }),
            data: dataWith({ plansTable: false, planIds: [] }),
          },
          PLANS
        )
      ).toBe(`${PLANS} missing`);
    });

    it('says unavailable, with the reason, when the schema could not be read', () => {
      expect(lineFor({ schema: down('connection refused') }, PLANS)).toBe(
        `${PLANS} unavailable (connection refused)`
      );
    });
  });

  describe('plan_id line', () => {
    it('says present, not null and referencing plans for the migrated column', () => {
      expect(lineFor({}, PLAN_ID)).toBe(
        `${PLAN_ID} present, not null, references plans`
      );
    });

    it('says present but nullable for a column that allows nulls', () => {
      const line = lineFor(
        {
          schema: ok({
            ...GOOD_SCHEMA,
            planId: { nullable: true, referencesPlans: true },
          }),
        },
        PLAN_ID
      );

      expect(line.startsWith(`${PLAN_ID} present`)).toBe(true);
      expect(line).toMatch(/nullable/);
      expect(line).not.toContain('not null');
    });

    it('does not say the column references plans when it has no foreign key', () => {
      const line = lineFor(
        {
          schema: ok({
            ...GOOD_SCHEMA,
            planId: { nullable: false, referencesPlans: false },
          }),
        },
        PLAN_ID
      );

      expect(line.startsWith(`${PLAN_ID} present`)).toBe(true);
      expect(line).not.toContain('references plans');
    });

    it('says missing when the column does not exist', () => {
      expect(
        lineFor({ schema: ok({ ...GOOD_SCHEMA, planId: null }) }, PLAN_ID)
      ).toBe(`${PLAN_ID} missing`);
    });

    it('says unavailable, with the reason, when the schema could not be read', () => {
      expect(lineFor({ schema: down('connection refused') }, PLAN_ID)).toBe(
        `${PLAN_ID} unavailable (connection refused)`
      );
    });
  });

  describe('profiles line', () => {
    it('gives the counts of the correctly migrated data', () => {
      expect(lineFor({}, PROFILES)).toBe(
        `${PROFILES} 24 rows (24 of the 24 seeded users), 6 paid, 6 on pro, 18 on free, 0 on the wrong plan`
      );
    });

    it('shows everyone on free and six on the wrong plan when the backfill was dropped', () => {
      expect(
        lineFor(
          { data: dataWith({ onPro: 0, onFree: 24, misassigned: 6 }) },
          PROFILES
        )
      ).toBe(
        `${PROFILES} 24 rows (24 of the 24 seeded users), 6 paid, 0 on pro, 24 on free, 6 on the wrong plan`
      );
    });

    it('shows zeros for a remote that lost its rows', () => {
      expect(
        lineFor(
          {
            data: dataWith({
              profiles: 0,
              seededProfiles: 0,
              paid: 0,
              onPro: 0,
              onFree: 0,
              misassigned: 0,
            }),
          },
          PROFILES
        )
      ).toBe(
        `${PROFILES} 0 rows (0 of the 24 seeded users), 0 paid, 0 on pro, 0 on free, 0 on the wrong plan`
      );
    });

    it('shows how many seeded users are left when some were renamed or removed', () => {
      const line = lineFor(
        { data: dataWith({ profiles: 25, seededProfiles: 23 }) },
        PROFILES
      );

      expect(line).toContain('25 rows (23 of the 24 seeded users)');
    });

    it('does not turn unknown plan counts into zeros for the unmigrated remote', () => {
      const line = lineFor(
        {
          data: dataWith({
            plansTable: false,
            planIds: [],
            onPro: null,
            onFree: null,
            misassigned: null,
          }),
        },
        PROFILES
      );

      expect(line).toContain('24 rows (24 of the 24 seeded users), 6 paid');
      expect(line).not.toMatch(/(?<!\d)0 (on|paid)/);
      expect(line).not.toMatch(/undefined|NaN/);
    });

    it('does not turn an unknown paid count into zero when is_paid was dropped', () => {
      const line = lineFor(
        { data: dataWith({ paid: null, misassigned: null }) },
        PROFILES
      );

      expect(line).toContain('24 rows (24 of the 24 seeded users)');
      expect(line).toContain('6 on pro, 18 on free');
      expect(line).not.toMatch(/(?<!\d)0 (paid|on the wrong plan)/);
      expect(line).not.toMatch(/undefined|NaN/);
    });

    it('says unavailable, with the reason, when the data could not be read', () => {
      expect(lineFor({ data: down('connection refused') }, PROFILES)).toBe(
        `${PROFILES} unavailable (connection refused)`
      );
    });
  });

  describe('link line', () => {
    it('names the linked ref', () => {
      expect(lineFor({ link: { ok: true, ref: HOSTED_REF } }, LINK)).toBe(
        `${LINK} ${HOSTED_REF}`
      );
    });

    it('says none when the repo has no linked ref', () => {
      expect(lineFor({ link: { ok: true, ref: null } }, LINK)).toBe(
        `${LINK} none`
      );
    });

    it('says unknown, with the reason, when the link file could not be read', () => {
      expect(
        lineFor(
          {
            link: {
              ok: false,
              notes:
                'could not read supabase/.temp/project-ref (exit 2: Permission denied)',
            },
          },
          LINK
        )
      ).toBe(
        `${LINK} unknown (could not read supabase/.temp/project-ref (exit 2: Permission denied))`
      );
    });
  });

  it('marks all four remote lines unavailable when every probe failed', () => {
    const lines = describeGroundTruth(
      facts({
        history: down('boom'),
        schema: down('boom'),
        data: down('boom'),
      })
    );

    expect(
      lines.filter((line) => line.includes('unavailable (boom)'))
    ).toHaveLength(4);
  });

  it('keeps each probe on its own lines when only one failed', () => {
    const lines = describeGroundTruth(facts({ history: down('boom') }));

    expect(lines.filter((line) => line.includes('unavailable'))).toHaveLength(
      1
    );
    expect(lines.join('\n')).toContain('24 rows');
  });
});
