// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-004-download-edit-redeploy
import type { TranscriptPart } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import {
  type DeploymentProbe,
  describeDeployment,
  NO_HOSTED_PROJECT,
  readDeployment,
} from './hosted.js';
import type { CliFacts } from './metrics.js';
import { describeGroundTruth, formatReportJudgeInput } from './report.js';
import type { ProbeOutcome, ResponsesProbe } from './responses.js';
import { PROMO_PROBES } from './seed.js';

const NO_HOSTED_LINE =
  "- hosted project: the harness provisioned none for this run, supplied no access token and linked no project to the workspace (there is no supabase/.temp/project-ref), so no command could list, download, deploy or call the project's functions. The promo-code function's source exists only on the hosted project, so it could not have been downloaded, and nothing about the live function could have been observed";

const CALL_PREFIX = "- the harness's own call to the live function:";
const LOCAL_SOURCE_PREFIX =
  '- supabase/functions/apply-promo/index.ts in the workspace after the run:';

const NO_CLI: CliFacts = { versions: null, cliOverride: [] };

const SESSION_START = 1_700_000_000_000;
const REDEPLOYED_AT = SESSION_START + 60_000;

const REDEPLOYED: DeploymentProbe = {
  ok: true,
  deployed: {
    status: 'ACTIVE',
    verifyJwt: true,
    version: 2,
    updatedAtMs: REDEPLOYED_AT,
  },
};

const outcome = (
  index: number,
  passed: boolean,
  detail: string
): ProbeOutcome => ({
  group: PROMO_PROBES[index].group,
  request: PROMO_PROBES[index].request,
  passed,
  detail,
});

const ANSWERED: ResponsesProbe = {
  ok: true,
  outcomes: [
    outcome(0, true, 'discount 600'),
    outcome(1, true, 'discount 495'),
    outcome(2, true, 'discount 900'),
    outcome(3, true, 'discount 900'),
    outcome(4, true, 'rejected'),
    outcome(5, true, 'rejected'),
  ],
};

const NO_HOSTED: ResponsesProbe = { ok: false, notes: NO_HOSTED_PROJECT };

const facts = (
  overrides: Partial<Parameters<typeof describeGroundTruth>[0]> = {}
) => ({
  hosted: true,
  deployment: REDEPLOYED,
  sessionStartMs: SESSION_START as number | null,
  responses: ANSWERED,
  cli: NO_CLI,
  localSource: false as boolean | null,
  ...overrides,
});

const noHostedFacts = (
  overrides: Partial<Parameters<typeof describeGroundTruth>[0]> = {}
) =>
  facts({
    hosted: false,
    deployment: { ok: false, notes: NO_HOSTED_PROJECT },
    responses: NO_HOSTED,
    ...overrides,
  });

const deployedWith = (
  overrides: Partial<{
    status: string;
    verifyJwt: boolean | undefined;
    version: number | undefined;
    updatedAtMs: number | undefined;
  }>
): DeploymentProbe => ({
  ok: true,
  deployed: {
    status: 'ACTIVE',
    verifyJwt: true,
    version: 2,
    updatedAtMs: REDEPLOYED_AT,
    ...overrides,
  },
});

const callLines = (lines: string[]) =>
  lines.filter((line) => line.startsWith(CALL_PREFIX));

describe('describeGroundTruth without a hosted project', () => {
  it('states that the function source exists only on the hosted project and nothing about the live function could have been observed', () => {
    const lines = describeGroundTruth(noHostedFacts());
    expect(lines[0]).toBe(NO_HOSTED_LINE);
    expect(lines).toHaveLength(2);
    expect(lines).toContain('- installed CLI: unknown');
  });

  it('says nothing about the deployment even when probes are present', () => {
    const text = describeGroundTruth(facts({ hosted: false })).join('\n');
    expect(text).toContain(NO_HOSTED_LINE);
    expect(text).not.toContain('hosted project: linked');
    expect(text).not.toContain('deployment:');
    expect(text).not.toContain('JWT verification');
    expect(text).not.toContain(CALL_PREFIX);
  });

  it.each([true, false, null])(
    'leaves out the workspace source line, since the agent cannot know the slug without a project (%s)',
    (localSource) => {
      const lines = describeGroundTruth(noHostedFacts({ localSource }));
      expect(lines.join('\n')).not.toContain('apply-promo');
      expect(
        lines.filter((line) => line.startsWith(LOCAL_SOURCE_PREFIX))
      ).toEqual([]);
    }
  );
});

describe('describeGroundTruth with a hosted project', () => {
  it('starts by saying the project is linked and describes the deployment', () => {
    const lines = describeGroundTruth(facts());
    expect(lines[0]).toBe('- hosted project: linked');
    expect(lines).toContain('- deployment: ACTIVE v2');
    expect(lines).toContain('- JWT verification on the deployed function: on');
    expect(lines).not.toContain(NO_HOSTED_LINE);
  });

  it('uses the shared deployment description, so the judge sees what the checks see', () => {
    const lines = describeGroundTruth(facts());
    for (const line of describeDeployment(REDEPLOYED, SESSION_START)) {
      expect(lines).toContain(line);
    }
  });

  it('describes each of the harness own calls to the live function with the code, the cart and the outcome', () => {
    const lines = callLines(describeGroundTruth(facts()));
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe(
      `${CALL_PREFIX} welcome10 @6000 passed: discount 600`
    );
    expect(lines[1]).toBe(`${CALL_PREFIX} freeship @6000 passed: discount 495`);
    expect(lines[2]).toBe(`${CALL_PREFIX} loyal15 @6000 passed: discount 900`);
    expect(lines[3]).toBe(`${CALL_PREFIX} LOYAL15 @6000 passed: discount 900`);
    expect(lines[4]).toContain('FREESHIP @2000 passed');
    expect(lines[5]).toContain('SPRING50 @6000 passed');
  });

  it('shows what a failing call came back with', () => {
    const lines = callLines(
      describeGroundTruth(
        facts({
          responses: {
            ok: true,
            outcomes: [
              outcome(0, false, 'status 401: Missing authorization header'),
              outcome(1, false, 'error: edge function not found'),
              outcome(2, false, 'status 503: boot (after 3 attempts)'),
              outcome(3, true, 'discount 900'),
              outcome(4, true, 'rejected'),
              outcome(5, true, 'rejected'),
            ],
          },
        })
      )
    );
    expect(lines[0]).toBe(
      `${CALL_PREFIX} welcome10 @6000 failed: status 401: Missing authorization header`
    );
    expect(lines[1]).toBe(
      `${CALL_PREFIX} freeship @6000 failed: error: edge function not found`
    );
    expect(lines[2]).toBe(
      `${CALL_PREFIX} loyal15 @6000 failed: status 503: boot (after 3 attempts)`
    );
    expect(lines[3]).toContain('LOYAL15 @6000 passed');
  });

  it('says the call could not be made, and why, when the probe did not run', () => {
    const lines = callLines(
      describeGroundTruth(
        facts({
          responses: {
            ok: false,
            notes: 'not probed: still the seeded deployment (version 1)',
          },
        })
      )
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('could not be made (');
    expect(lines[0]).toContain('still the seeded deployment (version 1)');
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
        facts({ deployment: deployedWith({ status: 'THROTTLED', version: 3 }) })
      )
    ).toContain('- deployment: THROTTLED v3');
  });

  it('says the function is not deployed, with JWT verification n/a, when the project has none', () => {
    const lines = describeGroundTruth(
      facts({ deployment: { ok: true, deployed: null } })
    );
    expect(lines).toContain('- deployment: not deployed');
    expect(lines).toContain(
      '- JWT verification on the deployed function: n/a (not deployed)'
    );
    expect(lines).not.toContain('- deployment: ACTIVE v2');
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

  it('says the untouched seeded deployment is still the seeded one, so the report judge does not credit a redeploy', () => {
    const lines = describeGroundTruth(
      facts({
        deployment: deployedWith({ version: 1, updatedAtMs: SESSION_START }),
      })
    );
    const [expected] = describeDeployment(
      deployedWith({ version: 1, updatedAtMs: SESSION_START }),
      SESSION_START
    );
    expect(lines).toContain(expected);
    expect(expected).toContain('ACTIVE v1; ');
    expect(expected).toContain('seeded');
  });

  it('says the deployment predates the run when it was updated before the session started', () => {
    const lines = describeGroundTruth(
      facts({
        deployment: deployedWith({ updatedAtMs: SESSION_START - 1 }),
      })
    );
    const line = lines.find((candidate) =>
      candidate.startsWith('- deployment: ACTIVE v2; ')
    );
    expect(line).toContain('before this run');
    expect(lines).not.toContain('- deployment: ACTIVE v2');
  });

  it('says the deployment cannot be tied to the run when the session start is unknown', () => {
    const line = describeGroundTruth(facts({ sessionStartMs: null })).find(
      (candidate) => candidate.startsWith('- deployment: ACTIVE v2; ')
    );
    expect(line).toContain('session start time unavailable');
  });

  it('says the deployment cannot be tied to the run when the API reported no update time', () => {
    const line = describeGroundTruth(
      facts({ deployment: deployedWith({ updatedAtMs: undefined }) })
    ).find((candidate) => candidate.startsWith('- deployment: ACTIVE v2; '));
    expect(line).toContain('updated_at missing');
  });

  it('adds no not-redeployed remark for a function redeployed this run', () => {
    expect(describeGroundTruth(facts()).join('\n')).not.toContain('this run');
  });

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

describe('describeGroundTruth local source', () => {
  it.each([
    [true, 'present'],
    [false, 'absent'],
    [null, 'unknown'],
  ])('says %s is %s', (localSource, word) => {
    const lines = describeGroundTruth(facts({ localSource }));
    expect(lines).toContain(`${LOCAL_SOURCE_PREFIX} ${word}`);
    expect(
      lines.filter((line) => line.startsWith(LOCAL_SOURCE_PREFIX))
    ).toHaveLength(1);
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
      noHostedFacts({
        cli: {
          versions: { cliVersion: '2.117.0' },
          cliOverride: ['npx --yes supabase@2.120.0'],
        },
      })
    );
    expect(lines[0]).toBe(NO_HOSTED_LINE);
    expect(lines).toContain('- installed CLI: 2.117.0');
    expect(lines.find((line) => line.startsWith('- agent ran'))).toMatch(
      /^- agent ran npx --yes supabase@2\.120\.0/
    );
  });
});

describe('formatReportJudgeInput', () => {
  const transcript: TranscriptPart[] = [
    {
      type: 'tool_call',
      name: 'shell',
      input: { command: 'supabase functions download apply-promo' },
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
    expect(input).toContain('supabase functions download apply-promo');
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
          input: { command: 'supabase functions download apply-promo' },
          output,
        },
      ]
    );
    expect(input).toContain('TAIL-MARKER');
  });
});
