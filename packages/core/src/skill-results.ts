import type { ToolCallRecord } from "./index.js";
import type { SkillResult } from "./eval-metadata.js";

// Skill reads can appear as bare paths or quoted shell args in tool-call logs.
const PATH_START_BOUNDARY = String.raw`(?:^|[\s"'` + "`" + String.raw`])`;
const PATH_END_BOUNDARY = String.raw`(?:$|[\s"'` + "`" + String.raw`])`;

/** Escapes configured skill names before interpolating them into path regexes. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Checks whether text mentions a loaded skill entrypoint in any installed skill directory. */
function textReferencesSkillEntrypoint(text: string, skill: string): boolean {
  return new RegExp(
    `${PATH_START_BOUNDARY}\\S*skills/${escapeRegExp(skill)}/SKILL\\.md${PATH_END_BOUNDARY}`,
  ).test(text);
}

/** Recognizes known agent transcript signatures for loading one configured skill. */
function callLoadsSkill(call: ToolCallRecord, skill: string): boolean {
  if (call.endpoint === "load_skill" && call.body.name === skill) return true;
  if (call.endpoint === "Skill" && call.body.skill === skill) return true;

  const path = call.path ?? call.body.file_path ?? call.body.path;
  if (typeof path === "string" && textReferencesSkillEntrypoint(path, skill)) {
    return true;
  }

  const command = call.command ?? call.body.command;
  return (
    typeof command === "string" &&
    textReferencesSkillEntrypoint(command, skill)
  );
}

/** Builds the persisted skill activation summary for one eval run. */
export function buildSkillResult(
  available: readonly string[],
  toolCalls: readonly ToolCallRecord[],
): SkillResult {
  const loaded = available.filter((skill) =>
    toolCalls.some((call) => callLoadsSkill(call, skill)),
  );

  return {
    available: [...available],
    loaded,
  };
}
