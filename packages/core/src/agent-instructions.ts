import type { AgentSandbox } from './agents/types.js';
import type { AgentHarnessId } from './eval-metadata.js';

/**
 * The project instructions file each CLI agent reads from its working
 * directory. Claude Code reads CLAUDE.md; Codex, OpenCode and Grok read
 * AGENTS.md.
 */
export function agentInstructionsFile(agent: AgentHarnessId): string {
  return agent === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md';
}

/**
 * Adds an experiment's instructions to the project instructions file in the
 * agent's workspace, the way a user sets up a tool like supabase.sh. Appends
 * rather than replaces, so an AGENTS.md or CLAUDE.md the eval ships with
 * keeps its own content.
 */
export async function applyAgentInstructions(
  sandbox: AgentSandbox,
  agent: AgentHarnessId,
  instructions: string
): Promise<void> {
  const text = instructions.trim();
  if (!text) return;
  const file = agentInstructionsFile(agent);
  // Base64 keeps quotes, backticks and `$` in the instructions out of the shell.
  const encoded = Buffer.from(`${text}\n`, 'utf8').toString('base64');
  const result = await sandbox.exec(
    `if [ -s ${file} ]; then printf '\\n' >> ${file}; fi; printf '%s' '${encoded}' | base64 -d >> ${file}`
  );
  if (!result.ok) {
    throw new Error(
      `failed to write experiment instructions to ${file}: ${result.stderr || result.stdout}`
    );
  }
}
