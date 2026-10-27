// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-cli-001-plan-gated-branch
import { describe, expect, it } from 'vitest';
import type { PlanGateDenial } from './denial.js';
import {
  BILLING_URL,
  CREATE_COMMAND,
  denial,
  FEATURE,
  productionProbe,
  REF,
} from './fakes.js';
import { describeGroundTruth } from './report.js';
import { BASELINE_COLUMNS, BASELINE_VERSION } from './seed.js';

type Facts = Parameters<typeof describeGroundTruth>[0];

const NO_HOSTED_LINE =
  'hosted project: the harness provisioned none for this run and supplied no access token, so no command could reach a hosted project, create a preview branch or be denied by the plan gate';
const LINKED = `hosted project: linked (production ref ${REF})`;
const DENIED_LINE = `plan-gate denial: \`${CREATE_COMMAND}\` was denied (feature ${FEATURE}, upgrade link ${BILLING_URL})`;
const NO_DENIAL_LINE = 'plan-gate denial: none in any Supabase CLI output';

const facts = (overrides: Partial<Facts> = {}): Facts => ({
  hosted: true,
  hostedRef: REF,
  cliVersion: '2.117.0',
  denial: denial(),
  production: productionProbe(),
  previewBranches: { ok: true, names: [] },
  linkedRef: 'none',
  ...overrides,
});

const text = (lines: string[]) => lines.join('\n');

const lineWith = (lines: string[], fragment: string) =>
  lines.find((line) => line.includes(fragment));

describe('describeGroundTruth', () => {
  it('returns single-line, non-empty strings', () => {
    for (const lines of [
      describeGroundTruth(facts()),
      describeGroundTruth(facts({ hosted: false })),
      describeGroundTruth(facts({ denial: undefined })),
    ]) {
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.length).toBeGreaterThan(0);
        expect(line).not.toContain('\n');
      }
    }
  });
});

describe('describeGroundTruth with a hosted project', () => {
  it('starts by saying the project is linked, with the production ref, not that none was provisioned', () => {
    const lines = describeGroundTruth(facts());
    expect(lines[0]).toContain(LINKED);
    expect(text(lines)).not.toContain('harness provisioned none');
  });

  it('names the ref it was given', () => {
    expect(
      describeGroundTruth(facts({ hostedRef: 'zyxwvutsrqponmlkjihg' }))[0]
    ).toContain('hosted project: linked (production ref zyxwvutsrqponmlkjihg)');
  });

  it('ignores the linked ref when a hosted project exists', () => {
    expect(describeGroundTruth(facts({ linkedRef: 'other' }))[0]).toBe(
      describeGroundTruth(facts({ linkedRef: 'none' }))[0]
    );
  });

  it('states the production facts: the row count of tickets when untouched', () => {
    const lines = describeGroundTruth(facts());
    expect(text(lines)).toMatch(/\b8\b/);
    expect(text(lines)).toMatch(/tickets/);
  });

  it('describes a pushed production differently from an untouched one', () => {
    const untouched = describeGroundTruth(facts());
    const pushed = describeGroundTruth(
      facts({
        production: productionProbe({
          newVersionRecorded: true,
          newTablePresent: true,
        }),
      })
    );
    expect(pushed).not.toEqual(untouched);
  });

  it('states the row count of a tickets table that lost rows', () => {
    const lines = describeGroundTruth(
      facts({ production: productionProbe({ ticketRows: 3 }) })
    );
    expect(text(lines)).toMatch(/\b3\b/);
  });

  it('describes a missing tickets table differently from an empty one', () => {
    expect(
      describeGroundTruth(
        facts({
          production: productionProbe({
            ticketsPresent: false,
            ticketRows: null,
          }),
        })
      )
    ).not.toEqual(
      describeGroundTruth(
        facts({ production: productionProbe({ ticketRows: 0 }) })
      )
    );
  });

  it('lists the migration history versions, or says there is no history table', () => {
    const history = (historyVersions: string[] | null) =>
      text(
        describeGroundTruth(
          facts({ production: productionProbe({ historyVersions }) })
        )
      );
    expect(history([BASELINE_VERSION, '20270101000000'])).toContain(
      `versions: ${BASELINE_VERSION}, 20270101000000`
    );
    expect(history([])).toContain('versions: none');
    expect(history(null)).toContain('versions: no history table');
  });

  it('lists the columns of tickets, and leaves the line out when tickets is missing', () => {
    const columns = (ticketColumns: string[] | null) =>
      text(
        describeGroundTruth(
          facts({
            production: productionProbe({
              ticketColumns,
              ...(ticketColumns === null
                ? { ticketsPresent: false, ticketRows: null }
                : {}),
            }),
          })
        )
      );
    expect(columns([...BASELINE_COLUMNS, 'tags'])).toContain(
      'columns on production: id, subject, status, created_at, tags'
    );
    expect(columns(null)).not.toContain('columns on production');
  });

  it('says the new table is looked for in any schema', () => {
    expect(
      text(
        describeGroundTruth(
          facts({ production: productionProbe({ newTablePresent: true }) })
        )
      )
    ).toContain('ticket_tags relation on production, in any schema: present');
  });

  it('says production could not be read, with the reason, when the probe failed', () => {
    const lines = describeGroundTruth(
      facts({ production: { ok: false, notes: 'connection reset' } })
    );
    expect(text(lines)).toContain('connection reset');
    expect(lines).not.toEqual(describeGroundTruth(facts()));
  });
});

describe('describeGroundTruth without a hosted project', () => {
  it('starts by saying none was provisioned, no token was supplied and nothing could be denied by the plan gate, when there was no denial', () => {
    const lines = describeGroundTruth(
      facts({ hosted: false, linkedRef: null, denial: undefined })
    );
    expect(lines[0]).toContain(NO_HOSTED_LINE);
    expect(text(lines)).not.toContain('linked (production ref');
  });

  it('does not say no command could be denied when one was, but that it reached a project outside the harness', () => {
    const [line] = describeGroundTruth(
      facts({ hosted: false, linkedRef: null })
    );
    expect(line).toContain('the harness provisioned none for this run');
    expect(line).toContain(
      'a Supabase CLI command was nevertheless denied by the plan gate'
    );
    expect(line).toContain('reached a hosted project outside the harness');
    expect(line).not.toContain('no command could reach');
    expect(line).not.toContain('project-ref');
  });

  it.each(['none', 'production', 'other'] as const)(
    'keeps the project-ref clause on the denied variant when the workspace ended %s',
    (linkedRef) => {
      const [line] = describeGroundTruth(facts({ hosted: false, linkedRef }));
      expect(line).toContain('supabase/.temp/project-ref');
      expect(line).toContain('nevertheless denied');
    }
  );

  it('says nothing about production even when a probe is present', () => {
    const lines = describeGroundTruth(
      facts({ hosted: false, production: productionProbe() })
    );
    expect(text(lines)).not.toMatch(/tickets/);
    for (const line of lines) {
      expect(line).toMatch(/hosted project|plan-gate denial|installed CLI/);
    }
  });

  it('leaves out the project-ref clause when the link state is unknown', () => {
    const [line] = describeGroundTruth(
      facts({ hosted: false, linkedRef: null })
    );
    expect(line).not.toContain('project-ref');
  });

  it.each(['none', 'production', 'other'] as const)(
    'adds a project-ref clause when the workspace ended %s',
    (linkedRef) => {
      const [line] = describeGroundTruth(facts({ hosted: false, linkedRef }));
      expect(line).toContain('supabase/.temp/project-ref');
      expect(line).toContain('the harness provisioned none for this run');
    }
  );

  it('says differently that the workspace holds no ref and that it holds one', () => {
    const none = describeGroundTruth(
      facts({ hosted: false, linkedRef: 'none' })
    )[0];
    const held = describeGroundTruth(
      facts({ hosted: false, linkedRef: 'production' })
    )[0];
    expect(none).not.toBe(held);
  });
});

describe('the plan-gate denial line', () => {
  it.each([true, false])(
    'says there was none when no CLI output carried one (hosted: %s)',
    (hosted) => {
      const lines = describeGroundTruth(facts({ hosted, denial: undefined }));
      expect(text(lines)).toContain(NO_DENIAL_LINE);
      expect(text(lines)).not.toContain('was denied');
    }
  );

  it('names the denied command, its feature and its upgrade link', () => {
    const lines = describeGroundTruth(facts());
    expect(lineWith(lines, 'plan-gate denial:')).toContain(DENIED_LINE);
    expect(text(lines)).not.toContain(NO_DENIAL_LINE);
  });

  it('names a denied command other than the create', () => {
    const lines = describeGroundTruth(
      facts({ denial: denial({ command: 'supabase branches list' }) })
    );
    expect(text(lines)).toContain('`supabase branches list` was denied');
  });

  it('keeps the denial line without printing null or undefined for a denial with no feature or link', () => {
    const lines = describeGroundTruth(
      facts({ denial: denial({ feature: null, upgradeUrls: [] }) })
    );
    const line = lineWith(lines, 'plan-gate denial:') ?? '';
    expect(line).toContain(`\`${CREATE_COMMAND}\` was denied`);
    expect(line).not.toMatch(/null|undefined/);
  });

  it('is the same whether or not a hosted project exists', () => {
    const denied = (hosted: boolean) =>
      lineWith(
        describeGroundTruth(facts({ hosted, denial: denial() })),
        'plan-gate denial:'
      );
    expect(denied(false)).toBe(denied(true));
  });

  it('takes the denial it is given, not a fixed one', () => {
    const other: PlanGateDenial = denial({ feature: 'custom_domain' });
    expect(text(describeGroundTruth(facts({ denial: other })))).toContain(
      'feature custom_domain'
    );
  });
});

describe('the preview branches line', () => {
  const BRANCHES = '- preview branches on production at the end of the run:';
  const line = (overrides: Partial<Facts>) =>
    lineWith(describeGroundTruth(facts(overrides)), 'preview branches');

  it('says none when no preview branch is left', () => {
    expect(line({})).toBe(`${BRANCHES} none`);
  });

  it('names the preview branches left', () => {
    expect(
      line({ previewBranches: { ok: true, names: ['ticket-tags', 'extra'] } })
    ).toBe(`${BRANCHES} ticket-tags, extra`);
  });

  it('says they could not be read, with the reason, when the listing failed', () => {
    expect(
      line({
        previewBranches: { ok: false, notes: 'status 500 {"message":"boom"}' },
      })
    ).toBe(`${BRANCHES} could not be read (status 500 {"message":"boom"})`);
  });

  it('is left out without a hosted project, whatever the probe holds', () => {
    for (const previewBranches of [
      { ok: true as const, names: ['ticket-tags'] },
      { ok: false as const, notes: 'no hosted project' },
    ]) {
      expect(line({ hosted: false, linkedRef: null, previewBranches })).toBe(
        undefined
      );
    }
  });

  it('sits between the production facts and the CLI version', () => {
    const lines = describeGroundTruth(facts());
    const at = lines.findIndex((entry) => entry.includes('preview branches'));
    expect(lines[at - 1]).toContain('columns on production');
    expect(lines[at + 1]).toContain('installed CLI version');
  });
});

describe('the CLI version line', () => {
  it('states the installed version', () => {
    expect(text(describeGroundTruth(facts()))).toContain(
      'installed CLI version: 2.117.0'
    );
  });

  it('says unknown when the version could not be read', () => {
    expect(text(describeGroundTruth(facts({ cliVersion: null })))).toContain(
      'installed CLI version: unknown'
    );
  });

  it('is stated whether or not a hosted project was linked', () => {
    expect(
      text(describeGroundTruth(facts({ hosted: false, cliVersion: '2.122.0' })))
    ).toContain('installed CLI version: 2.122.0');
  });
});
