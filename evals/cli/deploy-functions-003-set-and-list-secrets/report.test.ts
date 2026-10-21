// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-003-set-and-list-secrets
import { createHash } from 'node:crypto';
import type { TranscriptPart } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { maskSecretValues } from './echo.js';
import {
  describeSecrets,
  NO_HOSTED_PROJECT,
  type SecretsProbe,
} from './hosted.js';
import type { CliFacts } from './metrics.js';
import { describeGroundTruth, formatReportJudgeInput } from './report.js';
import { DEVELOPMENT_VALUES, PRODUCTION_VALUES, SECRET_NAMES } from './seed.js';
import { formatGroundTruthJudgeInput } from '../lib/report.js';

const NO_HOSTED_LINE =
  "- hosted project: the harness provisioned none for this run, supplied no access token and linked no project to the workspace (there is no supabase/.temp/project-ref), so no command could set or list secrets on a hosted project, and nothing about the project's secrets could have been observed";

const NO_CLI: CliFacts = { versions: null, cliOverride: [] };

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const PRODUCTION_PROBE: SecretsProbe = {
  ok: true,
  secrets: SECRET_NAMES.map((name) => ({
    name,
    value: digest(PRODUCTION_VALUES[name]),
  })),
};

const UNAVAILABLE: SecretsProbe = { ok: false, notes: NO_HOSTED_PROJECT };

const facts = (
  overrides: Partial<Parameters<typeof describeGroundTruth>[0]> = {}
) => ({
  hosted: true,
  secrets: PRODUCTION_PROBE,
  cli: NO_CLI,
  ...overrides,
});

const ALL_VALUES = [
  ...Object.values(PRODUCTION_VALUES),
  ...Object.values(DEVELOPMENT_VALUES),
];

describe('describeGroundTruth without a hosted project', () => {
  it('states that nothing about the project secrets could have been observed', () => {
    expect(
      describeGroundTruth(facts({ hosted: false, secrets: UNAVAILABLE }))
    ).toEqual([NO_HOSTED_LINE, '- installed CLI: unknown']);
  });

  it('says nothing about the secrets even when a probe result is present', () => {
    const text = describeGroundTruth(facts({ hosted: false })).join('\n');
    expect(text).toContain(NO_HOSTED_LINE);
    expect(text).not.toContain('hosted project: linked');
    expect(text).not.toContain('secrets on the project');
  });
});

describe('describeGroundTruth with a hosted project', () => {
  it('says the project is linked, then the CLI line, then the secrets line', () => {
    expect(describeGroundTruth(facts())).toEqual([
      '- hosted project: linked',
      '- installed CLI: unknown',
      ...describeSecrets(PRODUCTION_PROBE),
    ]);
  });

  it('describes secrets that hold the development value', () => {
    const probe: SecretsProbe = {
      ok: true,
      secrets: SECRET_NAMES.map((name) => ({
        name,
        value: digest(DEVELOPMENT_VALUES[name]),
      })),
    };
    const lines = describeGroundTruth(facts({ secrets: probe }));
    expect(lines).toEqual([
      '- hosted project: linked',
      '- installed CLI: unknown',
      ...describeSecrets(probe),
    ]);
    expect(lines.join('\n')).toContain('holds the development value');
    expect(lines.join('\n')).not.toContain('holds the production value');
  });

  it('describes a secret that is not set', () => {
    const probe: SecretsProbe = { ok: true, secrets: [] };
    expect(describeGroundTruth(facts({ secrets: probe })).join('\n')).toContain(
      'RESEND_API_KEY not set'
    );
  });

  it('says the secrets are unavailable and why when the probe failed', () => {
    const lines = describeGroundTruth(
      facts({ secrets: { ok: false, notes: 'connection reset' } })
    );
    expect(lines).toContain(
      '- secrets on the project: unavailable (connection reset)'
    );
    expect(lines).not.toContain(NO_HOSTED_LINE);
  });

  it('never shows a value or a digest, even when the API returned plaintext', () => {
    const plaintext: SecretsProbe = {
      ok: true,
      secrets: SECRET_NAMES.map((name) => ({
        name,
        value: PRODUCTION_VALUES[name],
      })),
    };
    const text = [
      ...describeGroundTruth(facts({ secrets: plaintext })),
      ...describeGroundTruth(facts()),
    ].join('\n');
    for (const secret of [
      ...ALL_VALUES,
      ...SECRET_NAMES.map((name) => digest(PRODUCTION_VALUES[name])),
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('describeGroundTruth CLI facts', () => {
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

  it('notes a PATH version that moved during the run', () => {
    const line = describeGroundTruth(
      facts({
        cli: {
          versions: { cliVersion: '2.117.0', cliVersionAfterRun: '2.120.0' },
          cliOverride: [],
        },
      })
    ).find((candidate) => candidate.startsWith('- installed CLI:'));
    expect(line).toMatch(/^- installed CLI: 2\.117\.0/);
    expect(line).toContain('PATH supabase reported 2.120.0 after the run');
  });

  it('lists the CLI override runners the agent used', () => {
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
        secrets: UNAVAILABLE,
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
});

describe('formatReportJudgeInput', () => {
  const transcript: TranscriptPart[] = [
    {
      type: 'tool_call',
      name: 'shell',
      input: { command: 'supabase secrets set --env-file .env.production' },
      output: 'Access token not provided. Supply an access token.',
    },
    {
      type: 'tool_call',
      name: 'shell',
      input: { command: 'supabase secrets list' },
      error: 'Cannot find project ref. Have you run supabase link?',
    },
  ];

  it('puts the ground truth ahead of the transcript', () => {
    expect(
      formatReportJudgeInput(
        ['- hosted project: linked'],
        transcript
      ).startsWith(
        'Ground truth observed by the harness after the run:\n- hosted project: linked\n\nTranscript:\n'
      )
    ).toBe(true);
  });

  it('includes the tool inputs and the tool outputs and errors', () => {
    const input = formatReportJudgeInput([], transcript);
    expect(input).toContain('supabase secrets set --env-file .env.production');
    expect(input).toContain('Access token not provided');
    expect(input).toContain('Cannot find project ref');
  });

  it('matches the shared ground-truth format with tool outputs included', () => {
    const lines = describeGroundTruth(facts());
    expect(formatReportJudgeInput(lines, transcript)).toBe(
      formatGroundTruthJudgeInput(lines, transcript, {
        includeToolCallOutputs: true,
      })
    );
  });

  it('keeps a long tool output whole', () => {
    const output = `${'noise '.repeat(1000)}TAIL-MARKER`;
    expect(
      formatReportJudgeInput(
        [],
        [
          {
            type: 'tool_call',
            name: 'shell',
            input: { command: 'supabase secrets list' },
            output,
          },
        ]
      )
    ).toContain('TAIL-MARKER');
  });

  it('keeps the secret names and digests a list printed visible to the judge', () => {
    const output = SECRET_NAMES.map(
      (name) => `${name} | ${digest(PRODUCTION_VALUES[name])}`
    ).join('\n');
    const input = formatReportJudgeInput(
      [],
      [
        {
          type: 'tool_call',
          name: 'shell',
          input: { command: 'supabase secrets list' },
          output,
        },
      ]
    );
    for (const name of SECRET_NAMES) {
      expect(input).toContain(name);
      expect(input).toContain(digest(PRODUCTION_VALUES[name]));
    }
  });

  it('masks production and development values in tool inputs, outputs, errors and messages', () => {
    const leaky: TranscriptPart[] = [
      {
        type: 'tool_call',
        name: 'shell',
        input: {
          command: `supabase secrets set RESEND_API_KEY=${PRODUCTION_VALUES.RESEND_API_KEY}`,
        },
        output: `STRIPE_SECRET_KEY=${PRODUCTION_VALUES.STRIPE_SECRET_KEY}`,
      },
      {
        type: 'tool_call',
        name: 'shell',
        input: { command: 'cat .env.development' },
        error: `near ${DEVELOPMENT_VALUES.STRIPE_WEBHOOK_SECRET}`,
      },
      {
        type: 'message',
        role: 'assistant',
        content: `Set ${PRODUCTION_VALUES.STRIPE_WEBHOOK_SECRET} and ${DEVELOPMENT_VALUES.RESEND_API_KEY}.`,
      },
    ];
    const input = formatReportJudgeInput(['- hosted project: linked'], leaky);
    for (const value of ALL_VALUES) {
      expect(input).not.toContain(value);
    }
    expect(input).toContain('[redacted]');
    expect(input).toContain('supabase secrets set RESEND_API_KEY=[redacted]');
  });

  it('masks access tokens and JWT-shaped strings', () => {
    const sbp = `sbp_${'0123456789abcdef'.repeat(2)}01234567`;
    const jwt = [
      Buffer.from('{"alg":"HS256"}').toString('base64url'),
      Buffer.from('{"role":"anon"}').toString('base64url'),
      'c2lnbmF0dXJl',
    ].join('.');
    const input = formatReportJudgeInput(
      [],
      [
        {
          type: 'tool_call',
          name: 'shell',
          input: {
            command: `SUPABASE_ACCESS_TOKEN=${sbp} supabase projects list`,
          },
          output: `anon key: ${jwt}`,
        },
      ]
    );
    expect(input).not.toContain(sbp);
    expect(input).not.toContain(jwt);
  });

  it('is the shared ground-truth format passed through maskSecretValues', () => {
    const leaky: TranscriptPart[] = [
      {
        type: 'tool_call',
        name: 'shell',
        input: { command: 'cat supabase/functions/.env.production' },
        output: Object.values(PRODUCTION_VALUES).join('\n'),
      },
    ];
    const lines = describeGroundTruth(facts());
    expect(formatReportJudgeInput(lines, leaky)).toBe(
      maskSecretValues(
        formatGroundTruthJudgeInput(lines, leaky, {
          includeToolCallOutputs: true,
        })
      )
    );
  });
});
