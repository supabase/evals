import type { SkillResult } from "./eval-metadata.js";
import type { ToolCallRecord } from "./index.js";

/** Checks whether a normalized tool call loaded one configured skill. */
function callLoadsSkill(call: ToolCallRecord, skill: string): boolean {
  return call.loadedSkill === skill;
}

/** Builds the persisted skill activation summary for one eval run. */
export function buildSkillResult(
  available: string[],
  toolCalls: ToolCallRecord[],
): SkillResult {
  const loaded = available.filter((skill) =>
    toolCalls.some((call) => callLoadsSkill(call, skill)),
  );

  return {
    available,
    loaded,
  };
}
