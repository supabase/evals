import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../../index.js';
import { AI_GATEWAY } from '../gateway.js';
import {
  buildOpencodeConfig,
  createOpencodeRunner,
  providerApiKeyEnv,
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
  it("resolves the API-key env var from the model's provider prefix", () => {
    expect(providerApiKeyEnv('anthropic/claude-sonnet-5')).toBe(
      'ANTHROPIC_API_KEY'
    );
    expect(providerApiKeyEnv('openai/gpt-5.4')).toBe('OPENAI_API_KEY');
    // opencode's google provider reads GOOGLE_GENERATIVE_AI_API_KEY, not GEMINI_API_KEY.
    expect(providerApiKeyEnv('google/gemini-flash-latest')).toBe(
      'GOOGLE_GENERATIVE_AI_API_KEY'
    );
    expect(providerApiKeyEnv('moonshotai/kimi-k3')).toBe('MOONSHOT_API_KEY');
  });

  it('throws a clear error for an unsupported provider', () => {
    expect(() => providerApiKeyEnv('openrouter/some-model')).toThrowError(
      /Unsupported opencode provider "openrouter".*Supported: anthropic, openai, google, moonshotai/
    );
  });

  it('carries the provider on the runner for experiment display metadata', () => {
    expect(createOpencodeRunner('openai/gpt-5.4').modelProvider).toBe('openai');
    expect(
      createOpencodeRunner('google/gemini-flash-latest').modelProvider
    ).toBe('google');
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
    // No gateway → no custom provider block.
    expect(config.provider).toBeUndefined();
  });

  it('adds a Vercel AI Gateway provider block when routing through the gateway', () => {
    const config = JSON.parse(
      buildOpencodeConfig({}, { model: 'moonshotai/kimi-k3', apiKey: 'gw-key' })
    );
    expect(config.provider['vercel-ai-gateway']).toEqual({
      npm: '@ai-sdk/openai-compatible',
      name: 'Vercel AI Gateway',
      options: { baseURL: AI_GATEWAY.openAiBaseUrl, apiKey: 'gw-key' },
      // The gateway `vendor/model` slug is the model id under the provider.
      models: { 'moonshotai/kimi-k3': {} },
    });
  });
});

/** Capture the `--model` flag, run env, and written config from one exec. */
async function captureExec(
  model: string,
  opts: { gateway?: boolean; mcp?: boolean }
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
    apiKey: opts.gateway ? 'gw-key' : 'vendor-key',
    gateway: opts.gateway,
    systemPromptPath: '/s',
    userPromptPath: '/u',
    mcpServers: opts.mcp ? { supabase: { command: 'srv' } } : {},
    timeoutSec: 1,
  });
  return { runCommand, runEnv, config };
}

describe('opencode runner exec routing', () => {
  it('routes the model through the gateway provider and drops the vendor key', async () => {
    const { runCommand, runEnv, config } = await captureExec(
      'moonshotai/kimi-k3',
      { gateway: true, mcp: true }
    );
    // Model is addressed under the custom provider; the gateway slug stays intact.
    expect(runCommand).toContain(
      "--model 'vercel-ai-gateway/moonshotai/kimi-k3'"
    );
    // Key rides in the config, so no vendor key env var is set for the run.
    expect(runEnv).toEqual({});
    // Config carries both MCP servers and the gateway provider.
    expect(config?.mcp).toHaveProperty('supabase');
    expect(config?.provider).toHaveProperty('vercel-ai-gateway');
  });

  it('keeps the direct provider/model id and vendor key otherwise', async () => {
    const { runCommand, runEnv, config } = await captureExec(
      'moonshotai/kimi-k3',
      { mcp: true }
    );
    expect(runCommand).toContain("--model 'moonshotai/kimi-k3'");
    expect(runEnv).toEqual({ MOONSHOT_API_KEY: 'vendor-key' });
    expect(config?.provider).toBeUndefined();
  });

  it('writes a config for the gateway provider even without MCP servers', async () => {
    const { config } = await captureExec('moonshotai/kimi-k3', {
      gateway: true,
    });
    expect(config?.provider).toHaveProperty('vercel-ai-gateway');
  });
});
