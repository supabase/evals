import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../../index.js';
import {
  buildOpencodeConfig,
  createOpencodeRunner,
  providerForModel,
} from './runner.js';

/** A run's terminal records: a mid-run `step_finish` (tool-calls) then the final one. */
const SESSION = [
  JSON.stringify({
    type: 'step_finish',
    part: { type: 'step-finish', reason: 'tool-calls' },
  }),
  JSON.stringify({ type: 'text', part: { type: 'text', text: 'Done.' } }),
  JSON.stringify({
    type: 'step_finish',
    part: { type: 'step-finish', reason: 'stop' },
  }),
].join('\n');

describe('opencode runner', () => {
  it("resolves the results-metadata provider from the slug's vendor prefix", () => {
    expect(providerForModel('anthropic/claude-sonnet-5')).toBe('anthropic');
    expect(providerForModel('openai/gpt-5.4')).toBe('openai');
    expect(providerForModel('moonshotai/kimi-k3')).toBe('moonshotai');
  });

  it('throws a clear error for a vendor missing from the provider enum', () => {
    expect(() => providerForModel('mistral/some-model')).toThrowError(
      /Unsupported model vendor in "mistral\/some-model".*anthropic, openai, moonshotai/
    );
  });

  it('carries the provider on the runner for experiment display metadata', () => {
    expect(createOpencodeRunner('openai/gpt-5.4').modelProvider).toBe('openai');
    expect(createOpencodeRunner('moonshotai/kimi-k3').modelProvider).toBe(
      'moonshotai'
    );
  });

  it('deriveStopReason reads the terminal step_finish reason', () => {
    const runner = createOpencodeRunner('anthropic/claude-sonnet-5');
    const ok = { ok: true, exitCode: 0, stdout: '', stderr: '' };
    expect(runner.deriveStopReason!(SESSION, ok)).toBe('stop');
    // A non-stop terminal reason is surfaced verbatim.
    const length = JSON.stringify({
      type: 'step_finish',
      part: { reason: 'length' },
    });
    expect(runner.deriveStopReason!(length, ok)).toBe('length');
    // An error event wins regardless of exit code.
    const errored = JSON.stringify({
      type: 'error',
      error: { message: 'model overloaded' },
    });
    expect(runner.deriveStopReason!(errored, ok)).toBe('error');
  });

  it("builds opencode's MCP config shape from harness server configs", () => {
    const config = JSON.parse(
      buildOpencodeConfig({
        supabase: { command: 'npx', args: ['-y', 'srv'], env: { TOKEN: 't' } },
        docs: { command: 'docs-server' },
      })
    );
    expect(config.mcp).toEqual({
      supabase: {
        type: 'local',
        command: ['npx', '-y', 'srv'],
        enabled: true,
        environment: { TOKEN: 't' },
      },
      // No env → no `environment` key.
      docs: { type: 'local', command: ['docs-server'], enabled: true },
    });
  });

  it('disables the title agent', () => {
    // Title agent could otherwise call a different vendor
    const config = JSON.parse(buildOpencodeConfig({}));
    expect(config.agent).toEqual({ title: { disable: true } });
  });
});

describe('opencode runner extractUsage', () => {
  const extract = createOpencodeRunner('anthropic/claude-sonnet-5')
    .extractUsage!;

  it('sums step_finish tokens and cost across steps', () => {
    const raw = [
      JSON.stringify({
        type: 'step_finish',
        part: {
          type: 'step-finish',
          reason: 'tool-calls',
          cost: 0.01,
          tokens: {
            input: 100,
            output: 20,
            reasoning: 5,
            cache: { read: 40, write: 10 },
          },
        },
      }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'Done.' } }),
      JSON.stringify({
        type: 'step_finish',
        part: {
          type: 'step-finish',
          reason: 'stop',
          cost: 0.02,
          tokens: { input: 200, output: 30, reasoning: 0, cache: { read: 90 } },
        },
      }),
    ].join('\n');
    expect(extract(raw)).toEqual({
      inputTokens: 300,
      outputTokens: 50,
      reasoningTokens: 5,
      cachedInputTokens: 130,
      costUsd: 0.03,
    });
  });

  it('omits a zero cost total (unknown pricing) but keeps token counts', () => {
    const raw = JSON.stringify({
      type: 'step_finish',
      part: {
        type: 'step-finish',
        reason: 'stop',
        cost: 0,
        tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0 } },
      },
    });
    expect(extract(raw)).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    });
  });

  it('returns undefined without step_finish token payloads', () => {
    expect(extract(undefined)).toBeUndefined();
    expect(extract('not json\n')).toBeUndefined();
    expect(
      extract(
        JSON.stringify({
          type: 'step_finish',
          part: { type: 'step-finish', reason: 'stop' },
        })
      )
    ).toBeUndefined();
  });
});

/** Capture the `--model` flag, run env, and written config from one exec. */
async function captureExec(
  model: string,
  opts: { mcp?: boolean } = {}
): Promise<{
  runCommand: string;
  runEnv: Record<string, string> | undefined;
  config: Record<string, unknown> | undefined;
}> {
  const ok: CommandResult = { ok: true, exitCode: 0, stdout: '', stderr: '' };
  let runCommand = '';
  let runEnv: Record<string, string> | undefined;
  let config: Record<string, unknown> | undefined;
  await createOpencodeRunner(model).exec({
    sandbox: {
      workspace: '/w',
      exec: async (cmd, options) => {
        const write = /^printf %s '([^']+)'/.exec(cmd);
        if (write) {
          config = JSON.parse(Buffer.from(write[1], 'base64').toString('utf8'));
        } else if (cmd.includes(' run ')) {
          runCommand = cmd;
          runEnv = options?.env;
        }
        return ok;
      },
      readFile: async () => '',
    },
    model,
    apiKey: 'gw-key',
    systemPromptPath: '/s',
    userPromptPath: '/u',
    mcpServers: opts.mcp ? { supabase: { command: 'srv' } } : {},
    timeoutSec: 1,
  });
  return { runCommand, runEnv, config };
}

describe('opencode runner exec routing', () => {
  it("routes the model through opencode's native vercel provider with the gateway key", async () => {
    const { runCommand, runEnv, config } = await captureExec(
      'moonshotai/kimi-k3',
      { mcp: true }
    );
    // Model is addressed under the vercel provider; the gateway slug stays intact.
    expect(runCommand).toContain("--model 'vercel/moonshotai/kimi-k3'");
    expect(runEnv).toEqual({ AI_GATEWAY_API_KEY: 'gw-key' });
    expect(config?.mcp).toHaveProperty('supabase');
  });

  it('still writes the config (to disable the title agent) with no MCP servers', async () => {
    const { runCommand, config } = await captureExec('moonshotai/kimi-k3');
    expect(config?.agent).toEqual({ title: { disable: true } });
    expect(config?.mcp).toEqual({});
    expect(runCommand).toContain('OPENCODE_CONFIG=');
  });
});
