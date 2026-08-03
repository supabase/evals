import type { CheckResult, ToolCallRecord, ToolScorer } from './index.js';

/** The unique skill names actually loaded during a run (from `load_skill` tool calls). */
export function loadedSkillsFromToolCalls(
  toolCalls: ToolCallRecord[]
): string[] {
  const set = new Set<string>();
  for (const call of toolCalls) {
    for (const skill of call.loadedSkills ?? []) set.add(skill);
  }
  return [...set];
}

/**
 * Builds a deterministic `ToolScorer` for skill-trigger-quality evals: compares
 * the skills the agent actually loaded against a hand-authored expected set,
 * emitting one `CheckResult` per skill in the closed set.
 *
 *   expected & loaded   → `loaded <skill>`            passed  (loaded-correct)
 *   expected & !loaded  → `loaded <skill>`            FAILED  (missed)
 *   !expected & loaded  → `<skill> not expected`      FAILED  (false-positive)
 *   !expected & !loaded → `correctly skipped <skill>`  passed  (correctly inactive)
 *
 * `passed = no missed && no false-positive`. Pure analytics over `ctx.toolCalls`
 * — no LLM, no sandbox, no DB. The trigger evals are tools-mode with no
 * `localStack`, so the scoring context's DB surface is unused.
 */
export function createSkillTriggerScorer(
  expectedSkills: readonly string[],
  allSkills: readonly string[]
): ToolScorer {
  const expected = new Set(expectedSkills);
  return async (ctx) => {
    const loaded = new Set(loadedSkillsFromToolCalls(ctx.toolCalls));
    const checks: CheckResult[] = [];
    for (const skill of allSkills) {
      const want = expected.has(skill);
      const got = loaded.has(skill);
      if (want && got) {
        checks.push({ name: `loaded ${skill}`, passed: true });
      } else if (want && !got) {
        checks.push({
          name: `loaded ${skill}`,
          passed: false,
          notes: `expected ${skill} to load; it did not`,
        });
      } else if (!want && got) {
        checks.push({
          name: `${skill} not expected`,
          passed: false,
          notes: `${skill} loaded but not expected for this prompt`,
        });
      } else {
        checks.push({ name: `correctly skipped ${skill}`, passed: true });
      }
    }
    return { passed: checks.every((check) => check.passed), checks };
  };
}
