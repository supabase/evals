// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-005-preview-branch-lifecycle
import type { TranscriptPart } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import { describeBranches, type BranchesProbe } from './branches.js';
import {
  BRANCH_REF,
  DEFAULT_SUMMARY,
  iso,
  productionProbe,
  REF,
  SESSION_START,
  summary,
} from './fakes.js';
import {
  describeLifecycleFacts,
  formatLifecycleJudgeInput,
} from './lifecycle.js';
import { describeProduction, type ProductionProbe } from './production.js';
import { redactSecrets } from './redact.js';

const PASSWORD = 'not-a-real-password-123';
const SBP = `sbp_${'e'.repeat(40)}`;
const HOST = 'aws-0-eu-west-1.pooler.supabase.com';
const BRANCH_URL = `postgresql://postgres.${BRANCH_REF}:${PASSWORD}@${HOST}:5432/postgres`;
const REDACTED = '[redacted]';

const NEW_MIGRATION_FACT =
  '- the new migration: supabase/migrations/20261020120000_add_order_shipments.sql (version 20261020120000), which creates public.shipments';
const BASELINE_FACT =
  '- the migration already on production: 20260301090000 (creates public.orders)';

const clean: BranchesProbe = { ok: true, branches: [DEFAULT_SUMMARY] };

const shell = (
  command: string,
  extra: { output?: unknown; error?: string } = {}
): TranscriptPart => ({
  type: 'tool_call',
  name: 'shell',
  input: { command },
  ...extra,
});

describe('describeLifecycleFacts', () => {
  const factsFor = (
    production: ProductionProbe,
    branches: BranchesProbe,
    sessionStartMs: number | null = SESSION_START,
    refs: string[] = []
  ) =>
    describeLifecycleFacts({
      ref: REF,
      production,
      branches,
      sessionStartMs,
      refs,
    });

  it('starts with the production ref, the new migration and the migration already on production', () => {
    const lines = factsFor(productionProbe(), clean);
    expect(lines.slice(0, 3)).toEqual([
      `- production project ref: ${REF}`,
      NEW_MIGRATION_FACT,
      BASELINE_FACT,
    ]);
  });

  it('ends with the production state lines, then the branch lines', () => {
    const production = productionProbe();
    expect(factsFor(production, clean).slice(3)).toEqual([
      ...describeProduction(production),
      ...describeBranches(clean, SESSION_START, []),
    ]);
  });

  it('carries a touched production and a branch left running into the facts', () => {
    const production = productionProbe({
      newVersionRecorded: true,
      newTablePresent: true,
    });
    const branches: BranchesProbe = {
      ok: true,
      branches: [DEFAULT_SUMMARY, summary({ status: 'RUNNING_MIGRATIONS' })],
    };
    const lines = factsFor(production, branches);
    expect(lines.slice(3)).toEqual([
      ...describeProduction(production),
      ...describeBranches(branches, SESSION_START, []),
    ]);
    expect(lines.slice(3)).not.toEqual([
      ...describeProduction(productionProbe()),
      ...describeBranches(clean, SESSION_START, []),
    ]);
  });

  it('carries unreadable probes and an unknown session start into the facts', () => {
    const production: ProductionProbe = {
      ok: false,
      notes: 'connection reset',
    };
    const branches: BranchesProbe = {
      ok: false,
      notes: 'could not list branches: status 500 null',
    };
    expect(factsFor(production, branches, null).slice(3)).toEqual([
      ...describeProduction(production),
      ...describeBranches(branches, null, []),
    ]);
  });

  it('lists a branch older than the session start when a create printed its ref', () => {
    const skewed: BranchesProbe = {
      ok: true,
      branches: [summary({ createdAtMs: SESSION_START - 1_000 })],
    };
    expect(
      factsFor(productionProbe(), skewed, SESSION_START, [BRANCH_REF]).slice(3)
    ).toEqual([
      ...describeProduction(productionProbe()),
      ...describeBranches(skewed, SESSION_START, [BRANCH_REF]),
    ]);
    expect(describeBranches(skewed, SESSION_START, [BRANCH_REF])[0]).toContain(
      'preview-shipments'
    );
  });

  it('gives lines that each start with a dash', () => {
    for (const line of factsFor(productionProbe(), clean)) {
      expect(line.startsWith('- ')).toBe(true);
    }
  });

  it('names the ref it was given, not a fixed one', () => {
    expect(
      describeLifecycleFacts({
        ref: BRANCH_REF,
        production: productionProbe(),
        branches: clean,
        sessionStartMs: SESSION_START,
        refs: [],
      })[0]
    ).toBe(`- production project ref: ${BRANCH_REF}`);
  });
});

describe('formatLifecycleJudgeInput', () => {
  const facts = ['- production project ref: abcdefghijklmnopqrst'];

  const transcript: TranscriptPart[] = [
    shell('supabase branches create preview-shipments', {
      output: 'Created preview branch preview-shipments',
    }),
    shell(
      'supabase db push --db-url postgresql://branch.example.com/postgres',
      {
        error: 'connection refused',
      }
    ),
  ];

  it('puts the facts ahead of the transcript', () => {
    const input = formatLifecycleJudgeInput(facts, transcript);
    expect(
      input.startsWith(
        'Ground truth observed by the harness after the run:\n- production project ref: abcdefghijklmnopqrst\n\nTranscript:\n'
      )
    ).toBe(true);
  });

  it('includes each tool call input and its output or error', () => {
    const input = formatLifecycleJudgeInput(facts, transcript);
    expect(input).toContain('supabase branches create preview-shipments');
    expect(input).toContain('Created preview branch preview-shipments');
    expect(input).toContain(
      'supabase db push --db-url postgresql://branch.example.com/postgres'
    );
    expect(input).toContain('connection refused');
  });

  it('includes the assistant messages too', () => {
    const input = formatLifecycleJudgeInput(facts, [
      {
        type: 'message',
        role: 'assistant',
        content: 'I cleaned the branch up.',
      },
    ]);
    expect(input).toContain('I cleaned the branch up.');
  });

  it('matches the shared ground-truth format with tool outputs when nothing needs redacting', () => {
    expect(formatLifecycleJudgeInput(facts, transcript)).toBe(
      formatGroundTruthJudgeInput(facts, transcript, {
        includeToolCallOutputs: true,
      })
    );
  });

  it('keeps a long tool output whole, tail included', () => {
    const output = `${'noise '.repeat(1_200)}TAIL-MARKER`;
    expect(output.indexOf('TAIL-MARKER')).toBeGreaterThan(5_000);
    expect(
      formatLifecycleJudgeInput(facts, [
        shell(
          'supabase migration list --db-url postgresql://branch.example.com/postgres',
          {
            output,
          }
        ),
      ])
    ).toContain('TAIL-MARKER');
  });

  it('keeps a long tool call input whole, tail included', () => {
    const command = `cat > notes.txt <<'EOF'\n${'note\n'.repeat(1_200)}EOF\nsupabase branches delete TAIL-MARKER`;
    expect(
      formatLifecycleJudgeInput(facts, [shell(command, { output: 'ok' })])
    ).toContain('TAIL-MARKER');
  });

  it('redacts a Postgres URL password in a tool output but keeps the branch ref in the user name', () => {
    const input = formatLifecycleJudgeInput(facts, [
      shell('supabase branches get preview-shipments -o env', {
        output: `POSTGRES_URL=${BRANCH_URL}`,
      }),
    ]);
    expect(input).not.toContain(PASSWORD);
    expect(input).toContain(`postgres.${BRANCH_REF}:${REDACTED}@${HOST}`);
  });

  it('redacts secrets in tool call inputs, outputs and errors and in messages', () => {
    const input = formatLifecycleJudgeInput(facts, [
      shell(`supabase login --token ${SBP}`, {
        output: `token ${SBP} saved`,
      }),
      shell(`PGPASSWORD=${PASSWORD} psql "${BRANCH_URL}" -c 'select 1'`, {
        error: `password authentication failed for ${BRANCH_URL}`,
      }),
      {
        type: 'message',
        role: 'assistant',
        content: `connect with ${BRANCH_URL}`,
      },
    ]);
    expect(input).not.toContain(SBP);
    expect(input).not.toContain(PASSWORD);
    expect(input).toContain(REDACTED);
  });

  it('redacts a double-quoted password assignment in a command', () => {
    const input = formatLifecycleJudgeInput(facts, [
      shell(`export SUPABASE_DB_PASSWORD="${PASSWORD}"`, { output: '' }),
    ]);
    expect(input).not.toContain(PASSWORD);
    expect(input).toContain(REDACTED);
  });

  it('redacts a secret that sits in the facts', () => {
    const input = formatLifecycleJudgeInput(
      [...facts, `- note: ${BRANCH_URL}`],
      []
    );
    expect(input).not.toContain(PASSWORD);
  });

  it('is the redacted shared format', () => {
    const withSecrets: TranscriptPart[] = [
      shell(`supabase login --token ${SBP}`, { output: BRANCH_URL }),
    ];
    expect(formatLifecycleJudgeInput(facts, withSecrets)).toBe(
      redactSecrets(
        formatGroundTruthJudgeInput(facts, withSecrets, {
          includeToolCallOutputs: true,
        })
      )
    );
  });

  it('leaves a run that held no secrets readable: refs, versions and branch names survive', () => {
    const input = formatLifecycleJudgeInput(facts, [
      shell(`supabase link --project-ref ${REF}`, {
        output: `Applying migration 20261020120000_add_order_shipments.sql on ${iso(SESSION_START)}`,
      }),
    ]);
    expect(input).toContain(`--project-ref ${REF}`);
    expect(input).toContain('20261020120000_add_order_shipments.sql');
    expect(input).not.toContain(REDACTED);
  });
});
