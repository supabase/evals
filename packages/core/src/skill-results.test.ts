import { describe, expect, it } from 'vitest';
import { buildSkillResult } from './skill-results.js';
import type { ToolCallRecord } from './index.js';

/** Builds the minimal tool call record needed by skill-result tests. */
function toolCall(
  endpoint: string,
  body: Record<string, unknown>,
  options: Pick<ToolCallRecord, 'command' | 'path'> = {}
): ToolCallRecord {
  return {
    endpoint,
    body,
    ...options,
    ts: 0,
  };
}

describe('buildSkillResult', () => {
  const available = ['supabase', 'supabase-postgres-best-practices'];

  it('tracks normalized skill loads', () => {
    const result = buildSkillResult(available, [
      {
        ...toolCall('load_skill', { name: 'supabase' }),
        loadedSkills: ['supabase'],
      },
    ]);

    expect(result).toEqual({
      available,
      loaded: ['supabase'],
    });
  });

  it('tracks several skills loaded by one call', () => {
    const result = buildSkillResult(available, [
      {
        ...toolCall('bash', {
          command:
            'cat .claude/skills/supabase/SKILL.md .claude/skills/supabase-postgres-best-practices/SKILL.md',
        }),
        loadedSkills: ['supabase', 'supabase-postgres-best-practices'],
      },
    ]);

    expect(result).toEqual({
      available,
      loaded: ['supabase', 'supabase-postgres-best-practices'],
    });
  });

  it('ignores skills that were not available in the run', () => {
    const result = buildSkillResult(
      ['supabase'],
      [
        {
          ...toolCall('load_skill', { name: 'unknown-skill' }),
          loadedSkills: ['unknown-skill'],
        },
      ]
    );

    expect(result).toEqual({
      available: ['supabase'],
      loaded: [],
    });
  });
});
