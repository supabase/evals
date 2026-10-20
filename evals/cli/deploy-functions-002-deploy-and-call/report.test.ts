// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-002-deploy-and-call
import type { TranscriptPart } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import {
  type DeploymentProbe,
  NO_HOSTED_PROJECT,
  readDeployment,
} from './hosted.js';
import type { CliFacts } from './metrics.js';
import { describeGroundTruth, formatReportJudgeInput } from './report.js';
import type { ProbeOutcome, ResponsesProbe } from './responses.js';

const NO_HOSTED_LINE =
  '- hosted project: the harness provisioned none for this run and supplied no access token, so no command could deploy to or call a hosted project, and nothing about a deployed function could have been observed';

const CALL_PREFIX = "- the harness's own call to the deployed function:";

const NO_CLI: CliFacts = { versions: null, cliOverride: [] };

const DEPLOYED: DeploymentProbe = {
  ok: true,
  deployed: { status: 'ACTIVE', verifyJwt: true, version: 3 },
};

const outcome = (
  country: string,
  weightKg: number,
  passed: boolean,
  detail: string
): ProbeOutcome => ({ request: { country, weightKg }, passed, detail });

const ANSWERED: ResponsesProbe = {
  ok: true,
  outcomes: [
    outcome('IE', 2.3, true, 'quote 810 EUR'),
    outcome('US', 0.4, true, 'quote 894 USD'),
  ],
};

const NO_HOSTED: ResponsesProbe = { ok: false, notes: NO_HOSTED_PROJECT };

const facts = (
  overrides: Partial<Parameters<typeof describeGroundTruth>[0]> = {}
) => ({
  hosted: true,
  deployment: DEPLOYED,
  responses: ANSWERED,
  cli: NO_CLI,
  ...overrides,
});

const deployedWith = (
  overrides: Partial<{
    status: string;
    verifyJwt: boolean | undefined;
    version: number | undefined;
  }>
): DeploymentProbe => ({
  ok: true,
  deployed: { status: 'ACTIVE', verifyJwt: true, version: 3, ...overrides },
});

const callLines = (lines: string[]) =>
  lines.filter((line) => line.startsWith(CALL_PREFIX));

describe('describeGroundTruth without a hosted project', () => {
  it('states that nothing about a deployed function could have been observed', () => {
    expect(
      describeGroundTruth(
        facts({
          hosted: false,
          deployment: { ok: false, notes: NO_HOSTED_PROJECT },
          responses: NO_HOSTED,
        })
      )
    ).toEqual([NO_HOSTED_LINE, '- installed CLI: unknown']);
  });

  it('says nothing about the deployment even when probes are present', () => {
    const text = describeGroundTruth(facts({ hosted: false })).join('\n');
    expect(text).toContain(NO_HOSTED_LINE);
    expect(text).not.toContain('hosted project: linked');
    expect(text).not.toContain('deployment:');
    expect(text).not.toContain('JWT verification');
    expect(text).not.toContain(CALL_PREFIX);
  });
});

describe('describeGroundTruth with a hosted project', () => {
  it('starts by saying the project is linked and describes the deployment', () => {
    const lines = describeGroundTruth(facts());
    expect(lines[0]).toBe('- hosted project: linked');
    expect(lines).toContain('- deployment: ACTIVE v3');
    expect(lines).toContain('- JWT verification on the deployed function: on');
    expect(lines).not.toContain(NO_HOSTED_LINE);
  });

  it('describes each of the harness own calls to the deployed function', () => {
    const lines = callLines(describeGroundTruth(facts()));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('IE 2.3kg');
    expect(lines[0]).toContain('quote 810 EUR');
    expect(lines[1]).toContain('US 0.4kg');
    expect(lines[1]).toContain('quote 894 USD');
  });

  it('shows what a failing call came back with', () => {
    const lines = callLines(
      describeGroundTruth(
        facts({
          responses: {
            ok: true,
            outcomes: [
              outcome(
                'IE',
                2.3,
                false,
                'status 401: Missing authorization header'
              ),
              outcome('US', 0.4, false, 'error: edge function not found'),
            ],
          },
        })
      )
    );
    expect(lines[0]).toContain('IE 2.3kg');
    expect(lines[0]).toContain('status 401: Missing authorization header');
    expect(lines[1]).toContain('US 0.4kg');
    expect(lines[1]).toContain('error: edge function not found');
  });

  it('says the call could not be made, and why, when the probe did not run', () => {
    const lines = callLines(
      describeGroundTruth(
        facts({
          responses: {
            ok: false,
            notes: 'no hosted function invoker on the scoring context',
          },
        })
      )
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      'no hosted function invoker on the scoring context'
    );
  });

  it('says JWT verification is off when the deployed function has it off', () => {
    expect(
      describeGroundTruth(
        facts({ deployment: deployedWith({ verifyJwt: false }) })
      )
    ).toContain('- JWT verification on the deployed function: off');
  });

  it('says JWT verification is unknown when the API did not report it', () => {
    expect(
      describeGroundTruth(
        facts({ deployment: deployedWith({ verifyJwt: undefined }) })
      )
    ).toContain('- JWT verification on the deployed function: unknown');
  });

  it('reports the status and version of a function that is not ACTIVE', () => {
    expect(
      describeGroundTruth(
        facts({ deployment: deployedWith({ status: 'THROTTLED', version: 2 }) })
      )
    ).toContain('- deployment: THROTTLED v2');
  });

  it('leaves the version out when the API did not report one', () => {
    expect(
      describeGroundTruth(
        facts({ deployment: deployedWith({ version: undefined }) })
      )
    ).toContain('- deployment: ACTIVE');
  });

  it('says the function is not deployed, with JWT verification n/a, when the project has none', () => {
    const lines = describeGroundTruth(
      facts({ deployment: { ok: true, deployed: null } })
    );
    expect(lines).toContain('- deployment: not deployed');
    expect(lines).toContain(
      '- JWT verification on the deployed function: n/a (not deployed)'
    );
    expect(lines).not.toContain('- deployment: ACTIVE v3');
  });

  it.each([
    ['function', 'Function not found'],
    ['project', 'Project not found'],
  ])(
    'carries the Management API 404 for a missing %s into the deployment line',
    async (_label, message) => {
      const deployment = await readDeployment({
        hostedRef: 'abcdefghijklmnopqrst',
        hostedMgmt: {
          GET: async () => ({
            data: undefined,
            error: { message },
            response: { status: 404 },
          }),
        } as never,
      });
      const lines = describeGroundTruth(facts({ deployment }));
      expect(lines).toContain(`- deployment: not deployed (404: ${message})`);
      expect(lines).toContain(
        '- JWT verification on the deployed function: n/a (not deployed)'
      );
    }
  );

  it('says the deployment is unavailable and why when the probe failed', () => {
    const lines = describeGroundTruth(
      facts({ deployment: { ok: false, notes: 'connection reset' } })
    );
    expect(lines).toContain('- deployment: unavailable (connection reset)');
    expect(lines).toContain(
      '- JWT verification on the deployed function: n/a (deployment unavailable)'
    );
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

  it('says unknown when no versions were read at all', () => {
    expect(describeGroundTruth(facts())).toContain('- installed CLI: unknown');
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
        deployment: { ok: false, notes: NO_HOSTED_PROJECT },
        responses: NO_HOSTED,
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
      input: { command: 'supabase functions deploy' },
      output: 'Access token not provided. Supply an access token.',
    },
    {
      type: 'tool_call',
      name: 'shell',
      input: { command: 'supabase functions list' },
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
    expect(input).toContain('supabase functions deploy');
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
    const input = formatReportJudgeInput(
      [],
      [
        {
          type: 'tool_call',
          name: 'shell',
          input: { command: 'supabase functions deploy' },
          output,
        },
      ]
    );
    expect(input).toContain('TAIL-MARKER');
  });
});
