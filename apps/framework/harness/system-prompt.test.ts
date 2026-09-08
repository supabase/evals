import { describe, expect, it } from 'vitest';
import type { AgentHarnessId } from '@supabase-evals/core';
import {
  buildSkillsPrompt,
  buildToolSurfaceAddendum,
  type SkillEntry,
} from '@supabase-evals/sandbox';
import { buildSystemPrompt } from './system-prompt.js';

const CLI_AGENTS: AgentHarnessId[] = ['claude-code', 'codex', 'opencode'];

const skills: SkillEntry[] = [
  {
    name: 'supabase',
    description: 'Use for Supabase tasks.',
    dir: '.claude/skills/supabase',
  },
];

describe('buildSystemPrompt', () => {
  it('gives the ai-sdk agent task framing', () => {
    // ai-sdk is the one harness with no system prompt of its own.
    expect(buildSystemPrompt({ agent: 'ai-sdk' })).toContain(
      'Use the provided tools'
    );
  });

  it('gives nothing to any CLI harness', () => {
    // CLI harnesses ship their own system prompt; that is what is measured.
    for (const agent of CLI_AGENTS) {
      expect(buildSystemPrompt({ agent })).toBe('');
    }
  });

  it('assembles to nothing for a CLI harness, even with skills installed', () => {
    // The real block producers, not stand-ins: each CLI finds the skills through
    // its own project-scope discovery and describes them to the model itself.
    for (const agent of CLI_AGENTS) {
      expect(
        buildSystemPrompt({
          agent,
          addendum: buildToolSurfaceAddendum(agent),
          skillContext: buildSkillsPrompt(agent, skills),
        })
      ).toBe('');
    }
  });

  it('keeps the runtime blocks for ai-sdk, in order, after the base prompt', () => {
    const base = buildSystemPrompt({ agent: 'ai-sdk' });
    expect(
      buildSystemPrompt({
        agent: 'ai-sdk',
        addendum: 'Addendum.',
        skillContext: 'Skills listing.',
      })
    ).toBe(`${base}\n\nAddendum.\n\nSkills listing.`);
    const withSkills = buildSystemPrompt({
      agent: 'ai-sdk',
      addendum: buildToolSurfaceAddendum('ai-sdk'),
      skillContext: buildSkillsPrompt('ai-sdk', skills),
    });
    expect(withSkills).toContain('## Available skills');
    expect(withSkills).toContain('- supabase: Use for Supabase tasks.');
  });

  it('drops empty blocks instead of leaving blank gaps', () => {
    const base = buildSystemPrompt({ agent: 'ai-sdk' });
    expect(
      buildSystemPrompt({
        agent: 'ai-sdk',
        addendum: '',
        skillContext: 'Skills listing.',
      })
    ).toBe(`${base}\n\nSkills listing.`);
    expect(
      buildSystemPrompt({ agent: 'ai-sdk', addendum: '', skillContext: '' })
    ).toBe(base);
  });

  it('never names Supabase, a project, or how to end the turn', () => {
    // Issue #164: naming Supabase hands the agent the answer to "which tool";
    // "project" presumes there is one to modify; stopping coaching shapes the
    // report the judge reads. All three are part of what is measured.
    const prompt = buildSystemPrompt({ agent: 'ai-sdk' });
    expect(prompt).not.toMatch(/supabase/i);
    expect(prompt).not.toMatch(/project/i);
    expect(prompt).not.toMatch(/eval/i);
    expect(prompt).not.toMatch(/summary|end your turn/i);
  });
});
