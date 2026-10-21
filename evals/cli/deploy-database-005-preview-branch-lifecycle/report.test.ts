// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-005-preview-branch-lifecycle
import type { TranscriptPart } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import { type BranchesProbe, describeBranches } from './branches.js';
import {
  BRANCH_REF,
  DEFAULT_SUMMARY,
  productionProbe,
  SESSION_START,
  summary,
} from './fakes.js';
import { NO_HOSTED_PROJECT } from './hosted.js';
import type { CliFacts } from './metrics.js';
import { describeProduction, type ProductionProbe } from './production.js';
import { redactSecrets } from './redact.js';
import {
  describeGroundTruth,
  formatReportJudgeInput,
  NO_HOSTED_PROJECT_TRUTH,
} from './report.js';

const NO_HOSTED_LINE =
  '- hosted project: the harness provisioned none for this run, supplied no access token and linked no project to the workspace (there is no supabase/.temp/project-ref), so no command could create, use or delete a preview branch, and nothing about a branch or the production database could have been observed';

const NO_CLI: CliFacts = { versions: null, cliOverride: [] };

const PASSWORD = 'not-a-real-password-123';
const SBP = `sbp_${'e'.repeat(40)}`;
const BRANCH_URL = `postgresql://postgres.${BRANCH_REF}:${PASSWORD}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`;
const REDACTED = '[redacted]';

const CLEAN: BranchesProbe = { ok: true, branches: [DEFAULT_SUMMARY] };
const LEFT_RUNNING: BranchesProbe = {
  ok: true,
  branches: [DEFAULT_SUMMARY, summary({ status: 'RUNNING_MIGRATIONS' })],
};

const facts = (
  overrides: Partial<Parameters<typeof describeGroundTruth>[0]> = {}
) => ({
  hosted: true,
  production: productionProbe(),
  branches: CLEAN,
  sessionStartMs: SESSION_START as number | null,
  cli: NO_CLI,
  ...overrides,
});

const tail = (lines: string[], count: number) =>
  lines.slice(lines.length - count);

describe('NO_HOSTED_PROJECT_TRUTH', () => {
  it('says nothing could have created, used or deleted a branch or observed production', () => {
    expect(NO_HOSTED_PROJECT_TRUTH).toBe(NO_HOSTED_LINE);
  });
});

describe('describeGroundTruth without a hosted project', () => {
  it('starts with the no-hosted-project truth', () => {
    const lines = describeGroundTruth(
      facts({
        hosted: false,
        production: { ok: false, notes: NO_HOSTED_PROJECT },
        branches: { ok: false, notes: NO_HOSTED_PROJECT },
      })
    );
    expect(lines[0]).toBe(NO_HOSTED_LINE);
  });

  it('adds only the CLI line after it', () => {
    const lines = describeGroundTruth(facts({ hosted: false }));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^- installed CLI: unknown/);
  });

  it('says nothing about production or branches even when probes are present', () => {
    const lines = describeGroundTruth(
      facts({
        hosted: false,
        production: productionProbe(),
        branches: LEFT_RUNNING,
      })
    );
    expect(lines).not.toContain('- hosted project: linked');
    for (const line of [
      ...describeProduction(productionProbe()),
      ...describeBranches(LEFT_RUNNING, SESSION_START),
    ]) {
      expect(lines).not.toContain(line);
    }
  });
});

describe('describeGroundTruth with a hosted project', () => {
  it('starts by saying the project is linked and not that none was provisioned', () => {
    const lines = describeGroundTruth(facts());
    expect(lines[0]).toBe('- hosted project: linked');
    expect(lines).not.toContain(NO_HOSTED_LINE);
  });

  it('ends with the production state lines, then the branch lines', () => {
    const production = productionProbe();
    const lines = describeGroundTruth(facts({ production, branches: CLEAN }));
    const expected = [
      ...describeProduction(production),
      ...describeBranches(CLEAN, SESSION_START),
    ];
    expect(tail(lines, expected.length)).toEqual(expected);
  });

  it('carries a pushed production and a branch left running into the lines', () => {
    const production = productionProbe({
      newVersionRecorded: true,
      newTablePresent: true,
    });
    const lines = describeGroundTruth(
      facts({ production, branches: LEFT_RUNNING })
    );
    const expected = [
      ...describeProduction(production),
      ...describeBranches(LEFT_RUNNING, SESSION_START),
    ];
    expect(tail(lines, expected.length)).toEqual(expected);
    expect(expected).not.toEqual([
      ...describeProduction(productionProbe()),
      ...describeBranches(CLEAN, SESSION_START),
    ]);
  });

  it('carries unreadable probes and an unknown session start into the lines', () => {
    const production: ProductionProbe = {
      ok: false,
      notes: 'connection reset',
    };
    const branches: BranchesProbe = {
      ok: false,
      notes: 'could not list branches: status 500 null',
    };
    const lines = describeGroundTruth(
      facts({ production, branches, sessionStartMs: null })
    );
    const expected = [
      ...describeProduction(production),
      ...describeBranches(branches, null),
    ];
    expect(tail(lines, expected.length)).toEqual(expected);
  });

  it('gives lines that each start with a dash', () => {
    for (const line of describeGroundTruth(facts())) {
      expect(line.startsWith('- ')).toBe(true);
    }
  });
});

describe('describeGroundTruth CLI facts', () => {
  const cliLines = (lines: string[]) =>
    lines.filter((line) => /^- (installed CLI|agent ran)/.test(line));

  it('states the installed CLI version', () => {
    const lines = describeGroundTruth(
      facts({ cli: { versions: { cliVersion: '2.117.0' }, cliOverride: [] } })
    );
    expect(lines).toContain('- installed CLI: 2.117.0');
    expect(lines.join('\n')).not.toContain('agent ran');
  });

  it('says unknown when the version could not be read', () => {
    expect(
      describeGroundTruth(
        facts({ cli: { versions: { cliVersion: null }, cliOverride: [] } })
      )
    ).toContain('- installed CLI: unknown');
  });

  it('says unknown when no versions were read at all', () => {
    expect(describeGroundTruth(facts())).toContain('- installed CLI: unknown');
  });

  it('notes a PATH version that moved during the run', () => {
    const [line] = cliLines(
      describeGroundTruth(
        facts({
          cli: {
            versions: { cliVersion: '2.117.0', cliVersionAfterRun: '2.120.0' },
            cliOverride: [],
          },
        })
      )
    );
    expect(line).toMatch(/^- installed CLI: 2\.117\.0/);
    expect(line).toContain('2.120.0');
  });

  it('lists the CLI override runner the agent used', () => {
    const lines = describeGroundTruth(
      facts({
        cli: {
          versions: { cliVersion: '2.117.0' },
          cliOverride: ['npx --yes supabase@2.120.0'],
        },
      })
    );
    expect(lines).toContain('- installed CLI: 2.117.0');
    expect(lines.find((line) => line.startsWith('- agent ran'))).toMatch(
      /^- agent ran npx --yes supabase@2\.120\.0/
    );
  });

  it('states the CLI facts whether or not a hosted project was linked', () => {
    const lines = describeGroundTruth(
      facts({
        hosted: false,
        cli: {
          versions: { cliVersion: '2.117.0' },
          cliOverride: ['npx --yes supabase@2.120.0'],
        },
      })
    );
    expect(lines[0]).toBe(NO_HOSTED_LINE);
    expect(lines[1]).toBe('- installed CLI: 2.117.0');
    expect(lines[2]).toMatch(/^- agent ran npx --yes supabase@2\.120\.0/);
  });

  it('puts the CLI lines before the production and branch lines', () => {
    const lines = describeGroundTruth(
      facts({ cli: { versions: { cliVersion: '2.117.0' }, cliOverride: [] } })
    );
    expect(lines.indexOf('- installed CLI: 2.117.0')).toBe(1);
  });
});

describe('formatReportJudgeInput', () => {
  const transcript: TranscriptPart[] = [
    {
      type: 'tool_call',
      name: 'shell',
      input: { command: 'supabase branches create preview-shipments' },
      output: 'Access token not provided. Supply an access token.',
    },
    {
      type: 'tool_call',
      name: 'shell',
      input: { command: 'supabase db push --linked' },
      error: 'Cannot find project ref. Have you run supabase link?',
    },
  ];

  it('puts the ground truth ahead of the transcript', () => {
    const input = formatReportJudgeInput(
      ['- hosted project: linked'],
      transcript
    );
    expect(
      input.startsWith(
        'Ground truth observed by the harness after the run:\n- hosted project: linked\n\nTranscript:\n'
      )
    ).toBe(true);
  });

  it('includes the tool inputs and the tool outputs and errors', () => {
    const input = formatReportJudgeInput([], transcript);
    expect(input).toContain('supabase branches create preview-shipments');
    expect(input).toContain('Access token not provided');
    expect(input).toContain('Cannot find project ref');
  });

  it('includes the assistant report', () => {
    expect(
      formatReportJudgeInput(
        [],
        [
          {
            type: 'message',
            role: 'assistant',
            content: 'I could not create a branch.',
          },
        ]
      )
    ).toContain('I could not create a branch.');
  });

  it('matches the shared ground-truth format with tool outputs when nothing needs redacting', () => {
    const lines = describeGroundTruth(facts());
    expect(formatReportJudgeInput(lines, transcript)).toBe(
      formatGroundTruthJudgeInput(lines, transcript, {
        includeToolCallOutputs: true,
      })
    );
  });

  it('keeps a long tool output whole', () => {
    const output = `${'noise '.repeat(1_200)}TAIL-MARKER`;
    expect(output.indexOf('TAIL-MARKER')).toBeGreaterThan(5_000);
    expect(
      formatReportJudgeInput(
        [],
        [
          {
            type: 'tool_call',
            name: 'shell',
            input: { command: 'supabase branches list' },
            output,
          },
        ]
      )
    ).toContain('TAIL-MARKER');
  });

  it('redacts secrets in tool inputs, outputs, errors and the report itself', () => {
    const input = formatReportJudgeInput(describeGroundTruth(facts()), [
      {
        type: 'tool_call',
        name: 'shell',
        input: { command: `supabase login --token ${SBP}` },
        output: `POSTGRES_URL=${BRANCH_URL}`,
      },
      {
        type: 'tool_call',
        name: 'shell',
        input: { command: `PGPASSWORD=${PASSWORD} psql -c 'select 1'` },
        error: `failed for ${BRANCH_URL}`,
      },
      {
        type: 'message',
        role: 'assistant',
        content: `I connected with ${BRANCH_URL}`,
      },
    ]);
    expect(input).not.toContain(PASSWORD);
    expect(input).not.toContain(SBP);
    expect(input).toContain(`postgres.${BRANCH_REF}:${REDACTED}@`);
  });

  it('is the redacted shared format', () => {
    const withSecrets: TranscriptPart[] = [
      {
        type: 'tool_call',
        name: 'shell',
        input: { command: `supabase login --token ${SBP}` },
        output: BRANCH_URL,
      },
    ];
    expect(
      formatReportJudgeInput(['- hosted project: linked'], withSecrets)
    ).toBe(
      redactSecrets(
        formatGroundTruthJudgeInput(['- hosted project: linked'], withSecrets, {
          includeToolCallOutputs: true,
        })
      )
    );
  });
});
