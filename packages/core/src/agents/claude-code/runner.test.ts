import { describe, expect, it, vi } from 'vitest';
import { claudeCodeRunner } from './runner.js';
import type { CommandResult } from '../../index.js';

const ok: CommandResult = { ok: true, exitCode: 0, stdout: '', stderr: '' };
const timedOut: CommandResult = {
  ok: false,
  exitCode: 124,
  stdout: '',
  stderr: '[command timed out after 540s and was terminated]',
};
const failed: CommandResult = {
  ok: false,
  exitCode: 1,
  stdout: '',
  stderr: 'boom',
};

/** A minimal `--output-format stream-json` stdout: init line + result line. */
function streamJson(subtype: string, isError = false): string {
  return [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      model: 'claude-haiku-4-5',
    }),
    JSON.stringify({
      type: 'result',
      subtype,
      is_error: isError,
      result: 'all done',
      num_turns: 3,
      session_id: 's1',
    }),
  ].join('\n');
}

describe('claudeCodeRunner.deriveStopReason', () => {
  const derive = claudeCodeRunner.deriveStopReason!;

  it('maps a successful result event to a normal stop', () => {
    expect(derive(streamJson('success'), ok)).toBe('stop');
  });

  it('surfaces non-success result subtypes verbatim', () => {
    expect(derive(streamJson('error_max_turns', true), ok)).toBe(
      'error_max_turns'
    );
  });

  it('falls back to the process result when there is no result event', () => {
    expect(derive(undefined, timedOut)).toBe('timeout');
    expect(derive('not json\n', failed)).toBe('error_exit_1');
    expect(derive(undefined, ok)).toBe('stop');
  });
});

describe('claudeCodeRunner.exec', () => {
  it('forwards live CLI output to the sandbox', async () => {
    const onStdout = vi.fn();
    let received: ((chunk: string) => void) | undefined;

    await claudeCodeRunner.exec({
      sandbox: {
        workspace: '/work',
        exec: async (_command, options) => {
          received = options?.onStdout;
          return ok;
        },
        readFile: async () => '',
      },
      model: claudeCodeRunner.defaultModel,
      apiKey: 'key',
      systemPromptPath: '/system',
      userPromptPath: '/user',
      mcpServers: {},
      timeoutSec: 1,
      onStdout,
    });

    expect(received).toBe(onStdout);
  });
});
