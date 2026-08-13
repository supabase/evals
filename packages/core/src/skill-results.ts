import type { SkillResult } from './eval-metadata.js';
import type { ToolCallRecord } from './index.js';

/** Builds the persisted skill activation summary for one eval run. */
export function buildSkillResult(
  available: string[],
  toolCalls: ToolCallRecord[]
): SkillResult {
  const loadedSkills = new Set<string>();
  for (const call of toolCalls) {
    for (const skill of call.loadedSkills ?? []) {
      loadedSkills.add(skill);
    }
  }
  const loaded = available.filter((skill) => loadedSkills.has(skill));

  return {
    available,
    loaded,
  };
}
