import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../../index.js';
import {
  buildCursorMcpConfig,
  cursorModelArg,
  cursorRunner,
} from './runner.js';

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

function streamJson(subtype: string, isError = false): string {
  return [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      model: 'composer-2.5',
    }),
    JSON.stringify({
      type: 'result',
      subtype,
      is_error: isError,
      result: 'all done',
      session_id: 's1',
    }),
  ].join('\n');
}

describe('cursorModelArg', () => {
  it('returns the bare model when effort is omitted', () => {
    expect(cursorModelArg('composer-2.5')).toBe('composer-2.5');
  });

  it('applies Cursor effort bracket syntax', () => {
    expect(cursorModelArg('composer-2.5', 'high')).toBe(
      'composer-2.5[effort=high]'
    );
  });

  it('rejects combining effort with an already-parameterized model', () => {
    expect(() =>
      cursorModelArg('composer-2.5[fast=false]', 'high')
    ).toThrowError(/already has bracket params/);
  });
});

describe('buildCursorMcpConfig', () => {
  it("builds Cursor's ~/.cursor/mcp.json stdio shape", () => {
    const config = JSON.parse(
      buildCursorMcpConfig({
        supabase: {
          command: 'npx',
          args: ['-y', 'srv'],
          env: { TOKEN: 't' },
        },
        docs: { command: 'docs-server' },
      })
    );
    expect(config.mcpServers).toEqual({
      supabase: {
        command: 'npx',
        args: ['-y', 'srv'],
        env: { TOKEN: 't' },
      },
      docs: { command: 'docs-server' },
    });
  });
});

describe('cursorRunner.deriveStopReason', () => {
  const derive = cursorRunner.deriveStopReason!;

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

type CapturedExec = {
  commands: string[];
  runCommand: string;
  runEnv: Record<string, string> | undefined;
  mcpConfig: Record<string, unknown> | undefined;
};

async function captureExec(opts: {
  mcp?: boolean;
  reasoningEffort?: string;
  skillsPresent?: boolean;
}): Promise<CapturedExec> {
  const commands: string[] = [];
  let runCommand = '';
  let runEnv: Record<string, string> | undefined;
  let mcpConfig: Record<string, unknown> | undefined;

  await cursorRunner.exec({
    sandbox: {
      workspace: '/workspace',
      exec: async (cmd, options) => {
        commands.push(cmd);
        const write = /^printf %s '([^']+)'/.exec(cmd);
        if (write) {
          const decoded = Buffer.from(write[1], 'base64').toString('utf8');
          if (decoded.includes('mcpServers')) {
            mcpConfig = JSON.parse(decoded);
          }
        } else if (cmd.includes('cursor-agent') && cmd.includes('--print')) {
          runCommand = cmd;
          runEnv = options?.env;
        } else if (opts.skillsPresent && cmd.includes('.claude/skills')) {
          // pretend the skills dir exists by no-op success
        }
        return ok;
      },
      readFile: async () => '',
    },
    model: 'composer-2.5',
    apiKey: 'cursor-key',
    systemPromptPath: '"$HOME/.eval/system-prompt.txt"',
    userPromptPath: '"$HOME/.eval/user-prompt.txt"',
    mcpServers: opts.mcp
      ? { supabase: { command: 'npx', args: ['-y', '@supabase/mcp'] } }
      : {},
    reasoningEffort: opts.reasoningEffort,
    timeoutSec: 1,
  });

  return { commands, runCommand, runEnv, mcpConfig };
}

describe('cursorRunner.exec', () => {
  it('runs headless with locked flags, workspace, model, and API key', async () => {
    const { runCommand, runEnv } = await captureExec({});
    expect(runCommand).toContain('--print');
    expect(runCommand).toContain('--output-format=stream-json');
    expect(runCommand).toContain('--yolo');
    expect(runCommand).toContain('--trust');
    expect(runCommand).toContain('--approve-mcps');
    expect(runCommand).toContain("--model='composer-2.5'");
    expect(runCommand).toContain("--workspace='/workspace'");
    expect(runCommand).toContain('cursor-prompt.txt');
    expect(runEnv).toEqual({ CURSOR_API_KEY: 'cursor-key' });
  });

  it('writes MCP config when servers are present', async () => {
    const { mcpConfig, commands } = await captureExec({ mcp: true });
    expect(mcpConfig?.mcpServers).toHaveProperty('supabase');
    expect(commands.some((c) => c.includes('.cursor/mcp.json'))).toBe(true);
  });

  it('does not write MCP config when no servers are configured', async () => {
    const { mcpConfig } = await captureExec({ mcp: false });
    expect(mcpConfig).toBeUndefined();
  });

  it('applies reasoning effort as a model bracket param', async () => {
    const { runCommand } = await captureExec({ reasoningEffort: 'high' });
    expect(runCommand).toContain("--model='composer-2.5[effort=high]'");
  });

  it('always attempts the .claude/skills → ~/.cursor/skills bridge', async () => {
    const { commands } = await captureExec({});
    expect(
      commands.some(
        (c) => c.includes('.claude/skills') && c.includes('.cursor/skills')
      )
    ).toBe(true);
  });
});

describe('cursorRunner metadata', () => {
  it('advertises cursor provider and pinned defaults', () => {
    expect(cursorRunner.id).toBe('cursor');
    expect(cursorRunner.modelProvider).toBe('cursor');
    expect(cursorRunner.apiKeyEnvVar).toBe('CURSOR_API_KEY');
    expect(cursorRunner.defaultModel).toBe('composer-2.5');
    expect(cursorRunner.defaultCliVersion).toBe('2026.07.23-e383d2b');
  });
});
