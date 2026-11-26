import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentInstructionsFile,
  applyAgentInstructions,
} from './agent-instructions.js';
import type { AgentSandbox } from './agents/types.js';

/** A sandbox that runs commands with the host shell in a temp workspace. */
function localSandbox(): AgentSandbox {
  const workspace = mkdtempSync(join(tmpdir(), 'agent-instructions-'));
  return {
    workspace,
    async exec(command) {
      try {
        const stdout = execSync(command, {
          cwd: workspace,
          shell: '/bin/bash',
          encoding: 'utf8',
        });
        return { ok: true, exitCode: 0, stdout, stderr: '' };
      } catch (error) {
        const e = error as { status?: number; stderr?: string };
        return {
          ok: false,
          exitCode: e.status ?? 1,
          stdout: '',
          stderr: e.stderr ?? '',
        };
      }
    },
    async readFile(path) {
      return readFileSync(join(workspace, path), 'utf8');
    },
    async copyToHost() {},
  };
}

describe('agentInstructionsFile', () => {
  it('uses CLAUDE.md for Claude Code and AGENTS.md for the other CLI agents', () => {
    expect(agentInstructionsFile('claude-code')).toBe('CLAUDE.md');
    expect(agentInstructionsFile('codex')).toBe('AGENTS.md');
    expect(agentInstructionsFile('opencode')).toBe('AGENTS.md');
    expect(agentInstructionsFile('grok')).toBe('AGENTS.md');
  });
});

describe('applyAgentInstructions', () => {
  it('creates the file with the instructions, keeping shell characters intact', async () => {
    const sandbox = localSandbox();
    const instructions =
      "## Supabase Docs\n\nRun `ssh supabase.sh grep -rl 'auth' /supabase/docs/` and check $HOME.";

    await applyAgentInstructions(sandbox, 'claude-code', instructions);

    expect(await sandbox.readFile('CLAUDE.md')).toBe(`${instructions}\n`);
  });

  it('appends to an instructions file the eval ships, without touching its content', async () => {
    const sandbox = localSandbox();
    writeFileSync(join(sandbox.workspace, 'AGENTS.md'), '# Project rules\n');

    await applyAgentInstructions(sandbox, 'codex', '## Supabase Docs');

    expect(await sandbox.readFile('AGENTS.md')).toBe(
      '# Project rules\n\n## Supabase Docs\n'
    );
  });

  it('does nothing for empty instructions', async () => {
    const sandbox = localSandbox();

    await applyAgentInstructions(sandbox, 'claude-code', '  \n');

    await expect(sandbox.readFile('CLAUDE.md')).rejects.toThrow();
  });
});
