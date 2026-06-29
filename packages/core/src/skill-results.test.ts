import { describe, expect, it } from "vitest";
import { buildSkillResult } from "./skill-results.js";
import type { ToolCallRecord } from "./index.js";

/** Builds the minimal tool call record needed by skill-result tests. */
function toolCall(
  endpoint: string,
  body: Record<string, unknown>,
  options: Pick<ToolCallRecord, "command" | "path"> = {},
): ToolCallRecord {
  return {
    endpoint,
    body,
    ...options,
    ts: 0,
  };
}

describe("buildSkillResult", () => {
  const available = ["supabase", "supabase-postgres-best-practices"];

  it("tracks AI SDK load_skill calls", () => {
    const result = buildSkillResult(available, [
      toolCall("load_skill", { name: "supabase" }),
    ]);

    expect(result).toEqual({
      available,
      loaded: ["supabase"],
    });
  });

  it("tracks Claude Code Skill calls", () => {
    const result = buildSkillResult(available, [
      toolCall("Skill", { skill: "supabase-postgres-best-practices" }),
    ]);

    expect(result).toEqual({
      available,
      loaded: ["supabase-postgres-best-practices"],
    });
  });

  it("tracks Codex shell reads from .agents skill installs", () => {
    const result = buildSkillResult(available, [
      toolCall(
        "command_execution",
        {
          command:
            "/bin/bash -lc \"sed -n '1,220p' .agents/skills/supabase/SKILL.md\"",
        },
        {
          command:
            "/bin/bash -lc \"sed -n '1,220p' .agents/skills/supabase/SKILL.md\"",
        },
      ),
    ]);

    expect(result).toEqual({
      available,
      loaded: ["supabase"],
    });
  });

  it("tracks .claude skill install reads defensively", () => {
    const result = buildSkillResult(available, [
      toolCall("command_execution", {
        command:
          "/bin/bash -lc \"sed -n '1,220p' .claude/skills/supabase-postgres-best-practices/SKILL.md\"",
      }),
    ]);

    expect(result).toEqual({
      available,
      loaded: ["supabase-postgres-best-practices"],
    });
  });

  it("tracks exact file-read paths ending at SKILL.md", () => {
    const result = buildSkillResult(available, [
      toolCall(
        "read_file",
        { file_path: "/tmp/sandbox/.agents/skills/supabase/SKILL.md" },
        { path: "/tmp/sandbox/.agents/skills/supabase/SKILL.md" },
      ),
    ]);

    expect(result).toEqual({
      available,
      loaded: ["supabase"],
    });
  });

  it("ignores skills that were not available in the run", () => {
    const result = buildSkillResult(["supabase"], [
      toolCall("load_skill", { name: "unknown-skill" }),
    ]);

    expect(result).toEqual({
      available: ["supabase"],
      loaded: [],
    });
  });
});
