// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-002-deploy-and-call
import type { TranscriptPart } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import { type DeploymentProbe, NO_HOSTED_PROJECT } from './hosted.js';
import {
  describeVerificationFacts,
  formatVerificationJudgeInput,
} from './verification.js';

const REF = 'abcdefghijklmnopqrst';

const deployed = (
  overrides: Partial<{
    status: string;
    verifyJwt: boolean | undefined;
    version: number | undefined;
  }> = {}
): DeploymentProbe => ({
  ok: true,
  deployed: { status: 'ACTIVE', verifyJwt: true, version: 3, ...overrides },
});

const REF_LINE = `- hosted project ref: ${REF}`;
const URL_LINE =
  "- the deployed function's path on the project's host is /functions/v1/shipping-quote";

describe('describeVerificationFacts', () => {
  it('states the ref, where the function lives, the deployment and the JWT setting', () => {
    expect(
      describeVerificationFacts({ ref: REF, deployment: deployed() })
    ).toEqual([
      REF_LINE,
      URL_LINE,
      '- deployment: ACTIVE v3',
      '- JWT verification on the deployed function: on',
    ]);
  });

  it('states the function path without claiming the harness checked reachability', () => {
    const lines = describeVerificationFacts({
      ref: REF,
      deployment: deployed(),
    });
    expect(lines[1]).toBe(URL_LINE);
    expect(lines.join('\n')).not.toContain('reachable');
  });

  it('says JWT verification is off when the deployed function has it off', () => {
    const lines = describeVerificationFacts({
      ref: REF,
      deployment: deployed({ verifyJwt: false }),
    });
    expect(lines[3]).toBe('- JWT verification on the deployed function: off');
  });

  it('says JWT verification is unknown when the API did not report it', () => {
    const lines = describeVerificationFacts({
      ref: REF,
      deployment: deployed({ verifyJwt: undefined }),
    });
    expect(lines[3]).toBe(
      '- JWT verification on the deployed function: unknown'
    );
  });

  it('reports the status and version of a function that is not ACTIVE', () => {
    const lines = describeVerificationFacts({
      ref: REF,
      deployment: deployed({ status: 'THROTTLED', version: 2 }),
    });
    expect(lines[2]).toBe('- deployment: THROTTLED v2');
  });

  it('leaves the version out when the API did not report one', () => {
    const lines = describeVerificationFacts({
      ref: REF,
      deployment: deployed({ version: undefined }),
    });
    expect(lines[2]).toBe('- deployment: ACTIVE');
  });

  it('says not deployed, with JWT verification n/a, when the project has no function', () => {
    expect(
      describeVerificationFacts({
        ref: REF,
        deployment: { ok: true, deployed: null },
      })
    ).toEqual([
      REF_LINE,
      URL_LINE,
      '- deployment: not deployed',
      '- JWT verification on the deployed function: n/a (not deployed)',
    ]);
  });

  it('says the deployment is unavailable and why when the probe failed', () => {
    expect(
      describeVerificationFacts({
        ref: REF,
        deployment: { ok: false, notes: 'connection reset' },
      })
    ).toEqual([
      REF_LINE,
      URL_LINE,
      '- deployment: unavailable (connection reset)',
      '- JWT verification on the deployed function: n/a (deployment unavailable)',
    ]);
  });

  it('keeps the ref and the unavailable notes verbatim', () => {
    const lines = describeVerificationFacts({
      ref: 'zzzzzzzzzzzzzzzzzzzz',
      deployment: { ok: false, notes: NO_HOSTED_PROJECT },
    });
    expect(lines[0]).toBe('- hosted project ref: zzzzzzzzzzzzzzzzzzzz');
    expect(lines[2]).toBe(`- deployment: unavailable (${NO_HOSTED_PROJECT})`);
  });
});

describe('formatVerificationJudgeInput', () => {
  const FACTS = describeVerificationFacts({ ref: REF, deployment: deployed() });

  it('puts the facts ahead of the transcript with tool inputs and outputs', () => {
    const transcript: TranscriptPart[] = [
      {
        type: 'tool_call',
        name: 'shell',
        input: {
          command: `curl -s https://${REF}.supabase.co/functions/v1/shipping-quote`,
        },
        output: 'quote 810 EUR',
      },
    ];
    const input = formatVerificationJudgeInput(FACTS, transcript);
    expect(
      input.startsWith(
        `Ground truth observed by the harness after the run:\n${REF_LINE}\n`
      )
    ).toBe(true);
    expect(input).toContain(URL_LINE);
    expect(input).toContain(
      `curl -s https://${REF}.supabase.co/functions/v1/shipping-quote`
    );
    expect(input.indexOf('quote 810 EUR')).toBeGreaterThan(
      input.indexOf('Transcript:')
    );
  });

  it('matches the shared ground-truth format with tool outputs included', () => {
    const transcript: TranscriptPart[] = [
      { type: 'message', role: 'assistant', content: 'Deploying now.' },
      {
        type: 'tool_call',
        name: 'shell',
        input: { command: 'supabase functions deploy' },
        output: 'Deployed Functions on project abcdefghijklmnopqrst',
      },
      {
        type: 'tool_call',
        name: 'shell',
        input: { command: 'curl https://example.test' },
        error: 'curl: (6) Could not resolve host',
      },
    ];
    expect(formatVerificationJudgeInput(FACTS, transcript)).toBe(
      formatGroundTruthJudgeInput(FACTS, transcript, {
        includeToolCallOutputs: true,
      })
    );
  });

  it('includes tool errors', () => {
    const input = formatVerificationJudgeInput(FACTS, [
      {
        type: 'tool_call',
        name: 'shell',
        input: { command: 'curl https://example.test' },
        error: 'curl: (6) Could not resolve host',
      },
    ]);
    expect(input).toContain('curl: (6) Could not resolve host');
  });

  it('never truncates a long tool output, so the status at the tail survives', () => {
    const output = `${'<html>'.repeat(1000)}HTTP/2 200 TAIL-MARKER`;
    expect(output.length).toBeGreaterThan(2000);
    const input = formatVerificationJudgeInput(FACTS, [
      {
        type: 'tool_call',
        name: 'shell',
        input: { command: 'curl -si https://example.test' },
        output,
      },
    ]);
    expect(input).toContain('HTTP/2 200 TAIL-MARKER');
  });

  it('never truncates a long command, so a request after the heredoc survives', () => {
    const command = `cat > call.mjs <<'EOF'\n${'// padding\n'.repeat(400)}EOF\nnode call.mjs https://${REF}.supabase.co/functions/v1/shipping-quote`;
    expect(command.length).toBeGreaterThan(2000);
    const input = formatVerificationJudgeInput(FACTS, [
      { type: 'tool_call', name: 'shell', input: { command }, output: 'ok' },
    ]);
    expect(input).toContain(
      `node call.mjs https://${REF}.supabase.co/functions/v1/shipping-quote`
    );
  });

  it('keeps the transcript in call order', () => {
    const input = formatVerificationJudgeInput(FACTS, [
      {
        type: 'tool_call',
        name: 'shell',
        input: { command: 'first-command' },
        output: 'first-output',
      },
      {
        type: 'tool_call',
        name: 'shell',
        input: { command: 'second-command' },
        output: 'second-output',
      },
    ]);
    expect(input.indexOf('first-command')).toBeLessThan(
      input.indexOf('first-output')
    );
    expect(input.indexOf('first-output')).toBeLessThan(
      input.indexOf('second-command')
    );
    expect(input.indexOf('second-command')).toBeLessThan(
      input.indexOf('second-output')
    );
  });

  it('still carries the facts when the transcript is empty', () => {
    const input = formatVerificationJudgeInput(FACTS, []);
    for (const line of FACTS) expect(input).toContain(line);
    expect(input).toContain('Transcript:');
  });
});
