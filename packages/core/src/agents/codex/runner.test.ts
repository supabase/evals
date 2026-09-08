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
  });
});
