import { describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../../index.js';
import { codexRunner } from './runner.js';

const ok: CommandResult = { ok: true, exitCode: 0, stdout: '', stderr: '' };

describe('codexRunner.exec', () => {
  it('forwards live CLI output to the sandbox', async () => {
    const onStdout = vi.fn();
    let received: ((chunk: string) => void) | undefined;

    await codexRunner.exec({
      sandbox: {
        workspace: '/work',
        exec: async (_command, options) => {
          received = options?.onStdout;
          return ok;
        },
        readFile: async () => '',
      },
      model: codexRunner.defaultModel,
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
