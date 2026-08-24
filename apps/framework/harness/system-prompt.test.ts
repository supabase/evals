import { describe, expect, it } from 'vitest';
import type { AgentHarnessId } from '@supabase-evals/core';
import {
  buildSkillsPrompt,
  buildToolSurfaceAddendum,
  type SkillEntry,
} from '@supabase-evals/sandbox';
import { buildSystemPrompt } from './system-prompt.js';
import type { EvalMode } from './types.js';

const CLI_AGENTS: AgentHarnessId[] = ['claude-code', 'codex', 'opencode'];
const MODES: EvalMode[] = ['tools', 'local-stack'];

describe('buildSystemPrompt', () => {
  it('gives the ai-sdk agent task framing in both modes', () => {
    // ai-sdk is the one harness with no system prompt of its own, so it's the
    // one harness the framework has to supply one for.
    for (const mode of MODES) {
      expect(buildSystemPrompt('ai-sdk', mode)).toContain(
        'Use the provided tools'
      );
    }
  });

  it('gives no framing of our own to any CLI harness', () => {
    // CLI harnesses ship their own system prompt; we're measuring that.
    for (const agent of CLI_AGENTS) {
      for (const mode of MODES) {
        expect(buildSystemPrompt(agent, mode)).toBe('');
      }
    }
  });

  it('drops blocks a caller hands it for a CLI harness', () => {
    // The producers gate their own output, so this should never happen — but a
    // block that did reach a CLI harness would fail silently, leaving the eval
    // measuring our prompt rather than the agent's own behaviour. A new
    // experiment pairing a CLI harness with an MCP server that carries a
    // `promptAddendum` is the way in; the assembler refuses it regardless.
    for (const agent of CLI_AGENTS) {
      for (const mode of MODES) {
        expect(
          buildSystemPrompt(agent, mode, 'Addendum.', 'Skills listing.')
        ).toBe('');
      }
    }
  });

  it('keeps the runtime blocks for ai-sdk, in order, after the base prompt', () => {
    const base = buildSystemPrompt('ai-sdk', 'local-stack');
    expect(
      buildSystemPrompt('ai-sdk', 'local-stack', 'Addendum.', 'Skills listing.')
    ).toBe(`${base}\n\nAddendum.\n\nSkills listing.`);
  });

  it('assembles to nothing at all for a CLI harness, even with skills', () => {
    // The real block producers, not stand-ins: with skills installed, a CLI
    // harness must still receive an entirely empty system prompt. Codex and
    // OpenCode find the skills through their own project-scope discovery and
    // describe them to the model themselves.
    const skills: SkillEntry[] = [
      {
        name: 'supabase',
        description: 'Use for Supabase tasks.',
        dir: '.claude/skills/supabase',
      },
    ];
    for (const agent of CLI_AGENTS) {
      expect(
        buildSystemPrompt(
          agent,
          'local-stack',
          buildToolSurfaceAddendum(agent),
          buildSkillsPrompt(agent, skills)
        )
      ).toBe('');
    }
    // ai-sdk has no such mechanism — it only learns about skills from us.
    const aiSdk = buildSystemPrompt(
      'ai-sdk',
      'local-stack',
      buildToolSurfaceAddendum('ai-sdk'),
      buildSkillsPrompt('ai-sdk', skills)
    );
    expect(aiSdk).toContain('## Available skills');
    expect(aiSdk).toContain('- supabase: Use for Supabase tasks.');
  });

  it('never tells any agent how to end its turn', () => {
    // Stopping behaviour is part of what an eval measures, so the harness must
    // not coach it (e.g. "end your turn with a short summary").
    for (const agent of [...CLI_AGENTS, 'ai-sdk' as const]) {
      for (const mode of MODES) {
        const prompt = buildSystemPrompt(agent, mode);
        expect(prompt).not.toMatch(/summary/i);
        expect(prompt).not.toMatch(/end your turn/i);
      }
    }
  });

  it('drops empty blocks instead of leaving blank gaps', () => {
    expect(buildSystemPrompt('ai-sdk', 'tools', '', 'Skills listing.')).toBe(
      `${buildSystemPrompt('ai-sdk', 'tools')}\n\nSkills listing.`
    );
    expect(buildSystemPrompt('ai-sdk', 'tools', '', '')).not.toMatch(/\n\n$/);
  });
});
