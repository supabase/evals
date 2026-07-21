import { describe, expect, it } from "vitest";
import {
  buildEvalTrace,
  uploadableEvalResultSchema,
  type UploadableEvalResult,
} from "./braintrust-spans.js";

const BASE = Date.parse("2026-07-21T10:00:00.000Z");

/** A modern raw result: transcript + toolCalls + usage + timing. */
const modernResult = {
  experiment: "claude-code-sonnet-5",
  experimentSuite: "benchmark",
  experimentDisplay: {
    agent: "claude-code",
    modelProvider: "anthropic",
    modelId: "claude-sonnet-5",
  },
  eval: "investigate-security-001-public-table",
  stage: "investigate",
  product: ["database"],
  topic: ["security", "rls"],
  suite: "benchmark",
  passed: true,
  checks: [
    { name: "named the vulnerable table", passed: true },
    { name: "proposed a concrete fix", passed: false, notes: "missed RLS" },
  ],
  attempts: 1,
  skills: { available: ["supabase"], loaded: ["supabase"] },
  transcript: [
    { type: "tool_call", name: "Skill", input: { skill: "supabase" }, output: "Launching skill: supabase" },
    { type: "message", role: "user", content: "skill body" },
    { type: "message", role: "assistant", content: "Looking at the tables." },
    { type: "tool_call", name: "Bash", input: { command: "psql" }, error: "exit 1" },
    { type: "message", role: "assistant", content: "Final report." },
  ],
  toolCalls: [
    { endpoint: "Skill", body: { skill: "supabase" }, loadedSkill: "supabase", result: "Launching skill: supabase", ts: 0 },
    { endpoint: "Bash", body: { command: "psql" }, name: "shell", command: "psql", error: "exit 1", ts: 0 },
  ],
  agentReport: "Final report.",
  stoppedReason: "stop",
  steps: 2,
  usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 20, costUsd: 0.12 },
  startedAt: "2026-07-21T09:00:00.000Z",
  durationMs: 60_000,
} satisfies Record<string, unknown>;

function parse(result: Record<string, unknown>): UploadableEvalResult {
  return uploadableEvalResultSchema.parse(result);
}

describe("uploadableEvalResultSchema", () => {
  it("accepts a legacy result without transcript fields", () => {
    const parsed = parse({
      experiment: "claude-code-sonnet-4.6",
      eval: "some-eval",
      passed: false,
      checks: [{ name: "a check", passed: false }],
    });
    expect(parsed.transcript).toBeUndefined();
    expect(parsed.usage).toBeUndefined();
  });

  it("accepts the modern shape", () => {
    const parsed = parse(modernResult);
    expect(parsed.transcript).toHaveLength(5);
    expect(parsed.usage?.costUsd).toBe(0.12);
  });
});

describe("buildEvalTrace", () => {
  const trace = buildEvalTrace({
    experiment: "claude-code-sonnet-5",
    result: parse(modernResult),
    prompt: "Find the security issue.",
    extraMetadata: { sourcePath: "claude-code-sonnet-5/x.json" },
    baseTimeMs: BASE,
  });

  it("uses the prompt as row input and the report as output", () => {
    expect(trace.input).toBe("Find the security issue.");
    expect(trace.output).toBe("Final report.");
  });

  it("scores passed plus one score per check", () => {
    expect(trace.scores).toEqual({
      passed: 1,
      "named the vulnerable table": 1,
      "proposed a concrete fix": 0,
    });
  });

  it("emits spans in transcript order, then the verdict and check score spans", () => {
    expect(trace.spans.map((s) => `${s.type}:${s.name}`)).toEqual([
      "tool:Skill",
      "task:user",
      "llm:assistant",
      "tool:Bash",
      "llm:assistant",
      "score:passed",
      "score:named the vulnerable table",
      "score:proposed a concrete fix",
    ]);
    const verdict = trace.spans.find((s) => s.name === "passed");
    expect(verdict?.scores).toEqual({ passed: 1 });
    expect(verdict?.output).toEqual({ passed: true, checksPassed: "1/2" });
  });

  it("pairs tool spans with the normalized toolCalls record", () => {
    const bash = trace.spans.find((s) => s.name === "Bash");
    expect(bash?.metadata).toEqual({ tool: "shell", command: "psql" });
    expect(bash?.error).toBe("exit 1");
    expect(bash?.output).toBeUndefined();
    const skill = trace.spans.find((s) => s.name === "Skill");
    expect(skill?.metadata).toEqual({ loadedSkill: "supabase" });
    expect(skill?.output).toBe("Launching skill: supabase");
  });

  it("uses the recorded run window and spreads spans across it", () => {
    const start = Date.parse("2026-07-21T09:00:00.000Z");
    expect(trace.startMs).toBe(start);
    expect(trace.endMs).toBe(start + 60_000);
    const starts = trace.spans.map((s) => s.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(starts[0]).toBe(start);
    expect(trace.spans.at(-1)!.endMs).toBeCloseTo(start + 60_000, 5);
  });

  it("maps usage onto Braintrust metric names", () => {
    expect(trace.metrics).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_cached_tokens: 20,
      tokens: 150,
    });
    expect(trace.metadata.costUsd).toBe(0.12);
  });

  it("carries the scenario dimensions in metadata and tags", () => {
    expect(trace.metadata).toMatchObject({
      eval: "investigate-security-001-public-table",
      experiment: "claude-code-sonnet-5",
      experimentSuite: "benchmark",
      agent: "claude-code",
      modelId: "claude-sonnet-5",
      stage: "investigate",
      suite: "benchmark",
      attempts: 1,
      steps: 2,
      stoppedReason: "stop",
      stepTiming: "synthetic-order-only",
      sourcePath: "claude-code-sonnet-5/x.json",
    });
    expect(trace.tags).toEqual(["investigate", "database", "security", "rls"]);
  });

  it("attaches check notes to score spans", () => {
    const failedCheck = trace.spans.find(
      (s) => s.name === "proposed a concrete fix",
    );
    expect(failedCheck?.scores).toEqual({ "proposed a concrete fix": 0 });
    expect(failedCheck?.output).toEqual({ passed: false, notes: "missed RLS" });
  });

  it("falls back to synthetic timing and eval-id input for legacy results", () => {
    const legacy = buildEvalTrace({
      experiment: "old",
      result: parse({
        experiment: "old",
        eval: "legacy-eval",
        passed: false,
        checks: [{ name: "a check", passed: false }],
      }),
      baseTimeMs: BASE,
    });
    expect(legacy.input).toEqual({ eval: "legacy-eval" });
    expect(legacy.output).toBeUndefined();
    expect(legacy.startMs).toBe(BASE);
    expect(legacy.endMs).toBe(BASE + 2000);
    expect(legacy.spans.map((s) => `${s.type}:${s.name}`)).toEqual([
      "score:passed",
      "score:a check",
    ]);
    expect(legacy.metrics).toEqual({});
  });

  it("de-duplicates and reserves score names", () => {
    const clashing = buildEvalTrace({
      experiment: "x",
      result: parse({
        experiment: "x",
        eval: "y",
        passed: true,
        checks: [
          { name: "passed", passed: true },
          { name: "same", passed: true },
          { name: "same", passed: false },
        ],
      }),
      baseTimeMs: BASE,
    });
    expect(Object.keys(clashing.scores)).toEqual([
      "passed",
      "check: passed",
      "same",
      "same (2)",
    ]);
    expect(clashing.scores["same (2)"]).toBe(0);
  });

  it("truncates oversized tool outputs", () => {
    const big = buildEvalTrace({
      experiment: "x",
      result: parse({
        experiment: "x",
        eval: "y",
        passed: true,
        transcript: [
          {
            type: "tool_call",
            name: "Read",
            input: {},
            output: "x".repeat(150_000),
          },
        ],
        toolCalls: [{ endpoint: "Read", body: {}, ts: 0 }],
      }),
      baseTimeMs: BASE,
    });
    const output = big.spans[0]!.output as string;
    expect(output.length).toBeLessThan(30_000);
    expect(output).toContain("[truncated 150000 chars]");
  });
});
