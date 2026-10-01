import { describe, expect, it } from 'vitest';
import { extractLoadedSkillsFromText } from './extract.js';

describe('extractLoadedSkillsFromText', () => {
  it('extracts skill names from SKILL.md path mentions', () => {
    expect(
      extractLoadedSkillsFromText(
        `/bin/zsh -lc "sed -n '1,220p' .agents/skills/supabase/SKILL.md"`
      )
    ).toEqual(['supabase']);

    expect(
      extractLoadedSkillsFromText(
        '/tmp/sandbox/.claude/skills/supabase-postgres-best-practices/SKILL.md'
      )
    ).toEqual(['supabase-postgres-best-practices']);
  });

  it('extracts every skill when one command reads several SKILL.md files', () => {
    expect(
      extractLoadedSkillsFromText(
        'cat .claude/skills/supabase/SKILL.md 2>/dev/null; echo "---"; cat .claude/skills/supabase-postgres-best-practices/SKILL.md 2>/dev/null'
      )
    ).toEqual(['supabase', 'supabase-postgres-best-practices']);
  });

  it('extracts adjacent paths in a single cat command', () => {
    expect(
      extractLoadedSkillsFromText(
        'cat .claude/skills/supabase/SKILL.md .claude/skills/supabase-postgres-best-practices/SKILL.md'
      )
    ).toEqual(['supabase', 'supabase-postgres-best-practices']);
  });

  it('dedupes repeated mentions of the same skill', () => {
    expect(
      extractLoadedSkillsFromText(
        'cat skills/supabase/SKILL.md && cat skills/supabase/SKILL.md'
      )
    ).toEqual(['supabase']);
  });

  it('ignores paths that do not end at the skill entrypoint', () => {
    expect(
      extractLoadedSkillsFromText('.agents/skills/supabase/references/auth.md')
    ).toEqual([]);
  });
});
