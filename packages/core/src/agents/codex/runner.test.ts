import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../../index.js';
import { codexRunner } from './runner.js';

const ok: CommandResult = { ok: true, exitCode: 0, stdout: '', stderr: '' };

/** The `codex exec` invocation from one exec, with a fake sandbox. */
async function captureRunCommand(): Promise<string> {
  let runCommand = '';
  await codexRunner.exec({
    sandbox: {
      workspace: '/w',
      exec: async (cmd) => {
        if (cmd.includes(' exec ')) runCommand = cmd;
        return ok;
      },
      readFile: async () => '',
    },
    model: 'gpt-5.4',
    apiKey: 'k',
    userPromptPath: '"$HOME/.eval/user-prompt.txt"',
    mcpServers: {},
    timeoutSec: 1,
  });
  return runCommand;
}

describe('codexRunner.exec', () => {
  it('sends the task alone on stdin', async () => {
    // Codex has no system-prompt flag, so anything else here would land on the
    // user prompt. Nothing is prepended.
    const command = await captureRunCommand();
    expect(command.startsWith('cat "$HOME/.eval/user-prompt.txt" |')).toBe(
      true
    );
    expect(command).not.toContain('system-prompt');

describe('codexRunner.extractUsage', () => {
  const extract = codexRunner.extractUsage!;

  it('maps turn.completed usage straight across', () => {
    const raw = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 30,
          cache_write_input_tokens: 20,
          output_tokens: 25,
        },
      }),
    ].join('\n');
    expect(extract(raw, 'gpt-5.6')).toEqual([
      {
        model: 'gpt-5.6',
        inputTokens: 100,
        cacheReadInputTokens: 30,
        cacheWriteInputTokens: 20,
        outputTokens: 25,
      },
    ]);
  });

  it('sums usage across multiple turns', () => {
    const raw = [
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 25 },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5 },
      }),
    ].join('\n');
    expect(extract(raw, 'gpt-5.6')).toEqual([
      {
        model: 'gpt-5.6',
        inputTokens: 150,
        cacheReadInputTokens: 10,
        cacheWriteInputTokens: 0,
        outputTokens: 30,
      },
    ]);
  });

  it('returns undefined without usage', () => {
    expect(extract(undefined, 'gpt-5.6')).toBeUndefined();
    expect(extract('not json\n', 'gpt-5.6')).toBeUndefined();
    expect(
      extract(JSON.stringify({ type: 'turn.completed' }), 'gpt-5.6')
    ).toBeUndefined();
