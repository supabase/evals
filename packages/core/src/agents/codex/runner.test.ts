import { describe, expect, it } from "vitest";
import { codexRunner } from "./runner.js";

describe("codexRunner.extractUsage", () => {
  const extract = codexRunner.extractUsage!;

  it("reads usage from turn.completed", () => {
    const raw = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 25 },
      }),
    ].join("\n");
    expect(extract(raw)).toEqual({
      inputTokens: 100,
      cachedInputTokens: 30,
      outputTokens: 25,
    });
  });

  it("sums usage across multiple turns", () => {
    const raw = [
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 25 },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5 },
      }),
    ].join("\n");
    expect(extract(raw)).toEqual({
      inputTokens: 150,
      cachedInputTokens: 10,
      outputTokens: 30,
    });
  });

  it("returns undefined without a turn.completed usage payload", () => {
    expect(extract(undefined)).toBeUndefined();
    expect(extract("not json\n")).toBeUndefined();
    expect(extract(JSON.stringify({ type: "turn.completed" }))).toBeUndefined();
  });
});
