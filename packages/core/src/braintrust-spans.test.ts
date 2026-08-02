import { describe, expect, it } from "vitest";
import {
  buildEvalTrace,
  uploadableEvalResultSchema,
  type UploadableEvalResult,
} from "./braintrust-spans.js";

const BASE = Date.parse("2026-07-21T10:00:00.000Z");

/** A modern raw result: transcript + toolCalls + usage + timing (no trace). */
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

describe("buildEvalTrace (flat fallback)", () => {
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

  it("exposes a single passed score with the checks in its output", () => {
    expect(trace.scores).toEqual({ passed: 1 });
    const verdict = trace.spans.find((s) => s.name === "passed")!;
    expect(verdict.scores).toEqual({ passed: 1 });
    expect(verdict.output).toEqual({
      passed: true,
      checksPassed: "1/2",
      checks: [
        { name: "named the vulnerable table", passed: true },
        { name: "proposed a concrete fix", passed: false, notes: "missed RLS" },
      ],
    });
  });

  it("emits spans in transcript order, then the verdict span", () => {
    expect(trace.spans.map((s) => `${s.type}:${s.name}`)).toEqual([
      "tool:Skill",
      "task:user",
      "llm:assistant",
      "tool:Bash",
      "llm:assistant",
      "score:passed",
    ]);
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
    expect(legacy.endMs).toBe(BASE + 1000);
    expect(legacy.spans.map((s) => `${s.type}:${s.name}`)).toEqual([
      "score:passed",
    ]);
    expect(legacy.metrics).toEqual({});
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

describe("buildEvalTrace (structured trace)", () => {
  const structured = buildEvalTrace({
    experiment: "x",
    result: parse({
      experiment: "x",
      eval: "y",
      passed: true,
      checks: [{ name: "a check", passed: true, judgeNotes: "solid work" }],
      startedAt: "2026-07-21T09:00:00.000Z",
      durationMs: 40_000,
      trace: {
        turns: [
          {
            index: 0,
            steps: [
              {
                index: 0,
                messageId: "msg_1",
                usage: { inputTokens: 100, outputTokens: 10 },
                thinking: "hmm",
                text: "Looking.",
                toolCalls: [
                  {
                    name: "Bash",
                    canonicalName: "shell",
                    args: { command: "ls" },
                    command: "ls",
                    output: "files",
                  },
                  {
                    name: "Task",
                    canonicalName: "agent_task",
                    args: { prompt: "explore" },
                    children: [
                      {
                        index: 0,
                        toolCalls: [
                          { name: "Read", canonicalName: "file_read", args: {}, output: "code" },
                        ],
                      },
                    ],
                  },
                ],
              },
              { index: 1, text: "Done.", toolCalls: [] },
            ],
          },
          {
            index: 1,
            userMessage: "one more thing",
            steps: [{ index: 2, text: "Sure.", toolCalls: [] }],
          },
        ],
        errors: [],
      },
      judgeCalls: [
        {
          rubric: "Pass if the work is solid.",
          input: "the files the judge saw",
          passed: true,
          notes: "solid work",
          modelId: "gpt-5.5",
          durationMs: 1234,
          usage: { inputTokens: 700, outputTokens: 30 },
        },
      ],
    }),
    baseTimeMs: BASE,
  });

  it("nests steps inside turns and tools inside steps", () => {
    expect(structured.spans.map((s) => `${s.type}:${s.name}`)).toEqual([
      "task:turn 1",
      "task:turn 2",
      "score:passed",
    ]);
    const turn1 = structured.spans[0]!;
    expect(turn1.children!.map((s) => `${s.type}:${s.name}`)).toEqual([
      "llm:step 1",
      "llm:step 2",
    ]);
    const step1 = turn1.children![0]!;
    expect(step1.metrics).toEqual({
      prompt_tokens: 100,
      completion_tokens: 10,
      tokens: 110,
    });
    expect(step1.metadata).toEqual({ messageId: "msg_1" });
    expect(step1.output).toEqual({ thinking: "hmm", text: "Looking." });
    expect(step1.children!.map((s) => `${s.type}:${s.name}`)).toEqual([
      "tool:Bash",
      "tool:Task",
    ]);
    const task = step1.children![1]!;
    expect(task.children!.map((s) => `${s.type}:${s.name}`)).toEqual(["llm:step 1"]);
    expect(task.children![0]!.children!.map((s) => s.name)).toEqual(["Read"]);
  });

  it("carries the opening user message on its turn", () => {
    const turn2 = structured.spans[1]!;
    expect(turn2.input).toBe("one more thing");
    expect(turn2.children!.map((s) => s.name)).toEqual(["step 3"]);
  });

  it("nests judge evidence under the passed score span", () => {
    const verdict = structured.spans[2]!;
    expect(verdict.scores).toEqual({ passed: 1 });
    expect(verdict.children!.map((s) => `${s.type}:${s.name}`)).toEqual([
      "llm:judge: a check",
    ]);
    const judgeSpan = verdict.children![0]!;
    expect(judgeSpan.input).toEqual({
      rubric: "Pass if the work is solid.",
      input: "the files the judge saw",
    });
    expect(judgeSpan.output).toEqual({ passed: true, notes: "solid work" });
    expect(judgeSpan.metadata).toEqual({ modelId: "gpt-5.5", durationMs: 1234 });
    expect(judgeSpan.metrics).toEqual({
      prompt_tokens: 700,
      completion_tokens: 30,
      tokens: 730,
    });
  });

  it("keeps everything inside the run window", () => {
    const start = Date.parse("2026-07-21T09:00:00.000Z");
    const turn1 = structured.spans[0]!;
    expect(turn1.startMs).toBe(start);
    const step1 = turn1.children![0]!;
    expect(step1.startMs).toBeGreaterThanOrEqual(turn1.startMs);
    expect(step1.endMs).toBeLessThanOrEqual(turn1.endMs);
    expect(structured.spans.at(-1)!.endMs).toBeCloseTo(start + 40_000, 5);
  });
});
