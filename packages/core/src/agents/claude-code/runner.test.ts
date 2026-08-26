import { describe, expect, it } from 'vitest';
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

/** The `claude` invocation from one exec, with a fake sandbox. */
async function captureRunCommand(
  systemPromptPath: string | undefined
): Promise<string> {
  let runCommand = '';
  await claudeCodeRunner.exec({
    sandbox: {
      workspace: '/w',
      exec: async (cmd) => {
        if (cmd.includes('/bin/claude')) runCommand = cmd;
        return ok;
      },
      readFile: async () => '',
    },
    model: 'claude-sonnet-4-6',
    apiKey: 'k',
    systemPromptPath,
    userPromptPath: '"$HOME/.eval/user-prompt.txt"',
    mcpServers: {},
    timeoutSec: 1,
  });
  return runCommand;
}

describe('claudeCodeRunner.exec', () => {
  it('appends the harness system prompt when there is one', async () => {
    const command = await captureRunCommand('"$HOME/.eval/system-prompt.txt"');
    expect(command).toContain(
      '--append-system-prompt-file "$HOME/.eval/system-prompt.txt"'
    );
  });

  it("omits the flag with no system prompt, leaving Claude Code's own intact", async () => {
    const command = await captureRunCommand(undefined);
    expect(command).not.toContain('--append-system-prompt-file');
    // The task itself is still piped in.
    expect(command).toContain('cat "$HOME/.eval/user-prompt.txt"');
  });
});

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
