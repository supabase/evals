import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../../index.js';
import { codexRunner } from './runner.js';

const ok: CommandResult = { ok: true, exitCode: 0, stdout: '', stderr: '' };

/** The `codex exec` invocation from one exec, with a fake sandbox. */
async function captureRunCommand(
  systemPromptPath: string | undefined
): Promise<string> {
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
    systemPromptPath,
    userPromptPath: '"$HOME/.eval/user-prompt.txt"',
    mcpServers: {},
    timeoutSec: 1,
  });
  return runCommand;
}

describe('codexRunner.exec', () => {
  it('prepends the harness system prompt to the task when there is one', async () => {
    // Codex has no system-prompt flag, so it lands on the user prompt.
    const command = await captureRunCommand('"$HOME/.eval/system-prompt.txt"');
    expect(command).toContain(
      `{ cat "$HOME/.eval/system-prompt.txt"; printf '\\n\\n'; cat "$HOME/.eval/user-prompt.txt"; }`
    );
  });

  it('sends the task alone with no system prompt (no leading blank block)', async () => {
    const command = await captureRunCommand(undefined);
    expect(command).not.toContain('system-prompt');
    expect(command).not.toContain("printf '\\n\\n'");
    expect(command.startsWith('cat "$HOME/.eval/user-prompt.txt" |')).toBe(
      true
    );
  });
});
