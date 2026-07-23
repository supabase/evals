import { describe, expect, it } from 'vitest';
import { extractLoadedSkillFromText } from './extract.js';

describe('extractLoadedSkillFromText', () => {
  it('extracts skill names from SKILL.md path mentions', () => {
    expect(
      extractLoadedSkillFromText(
        `/bin/zsh -lc "sed -n '1,220p' .agents/skills/supabase/SKILL.md"`
      )
    ).toBe('supabase');

    expect(
      extractLoadedSkillFromText(
        '/tmp/sandbox/.claude/skills/supabase-postgres-best-practices/SKILL.md'
      )
    ).toBe('supabase-postgres-best-practices');
  });

  it('ignores paths that do not end at the skill entrypoint', () => {
    expect(
      extractLoadedSkillFromText('.agents/skills/supabase/references/auth.md')
    ).toBeUndefined();
  });
});
