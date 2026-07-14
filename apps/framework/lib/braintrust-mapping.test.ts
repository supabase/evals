import { describe, expect, it } from "vitest";
import {
  experimentMetadata,
  groupByExperiment,
  isResultRow,
  metadataFor,
  scoresFor,
  tagsFor,
  type ResultRow,
} from "./braintrust-mapping.js";

function makeRow(overrides: Partial<ResultRow> = {}): ResultRow {
  return {
    experiment: "claude-code-opus-4.8",
    experimentSuite: "benchmark",
    experimentDisplay: {
      agent: "claude-code",
      modelProvider: "anthropic",
      modelId: "claude-opus-4-8",
      reasoningEffort: "high",
    },
    eval: "build-cli-001-bootstrap-app",
    stage: "build",
    product: ["database", "data-api"],
    topic: ["migrations", "rls"],
    suite: "benchmark",
    interface: "cli",
    passed: true,
    checks: [
      { name: "a", passed: true },
      { name: "b", passed: false },
    ],
    attempts: 1,
    skills: { available: ["supabase"], loaded: ["supabase"] },
    sourcePath: "claude-code-opus-4.8/build-cli-001-bootstrap-app.json",
    ...overrides,
  } as ResultRow;
}

describe("isResultRow", () => {
  it("accepts rows with string experiment and eval", () => {
    expect(isResultRow(makeRow())).toBe(true);
  });

  it("rejects non-objects and rows missing required keys", () => {
    expect(isResultRow(null)).toBe(false);
    expect(isResultRow("x")).toBe(false);
    expect(isResultRow({ experiment: "x" })).toBe(false);
    expect(isResultRow({ eval: "x" })).toBe(false);
    expect(isResultRow({ experiment: 1, eval: 2 })).toBe(false);
  });
});

describe("groupByExperiment", () => {
  it("groups rows by experiment, preserving order", () => {
    const rows = [
      makeRow({ experiment: "a", eval: "e1" }),
      makeRow({ experiment: "b", eval: "e2" }),
      makeRow({ experiment: "a", eval: "e3" }),
    ];
    const groups = groupByExperiment(rows);
    expect([...groups.keys()]).toEqual(["a", "b"]);
    expect(groups.get("a")?.map((r) => r.eval)).toEqual(["e1", "e3"]);
    expect(groups.get("b")?.map((r) => r.eval)).toEqual(["e2"]);
  });

  it("returns an empty map for no rows", () => {
    expect(groupByExperiment([]).size).toBe(0);
  });
});

describe("scoresFor", () => {
  it("maps passed to 1/0 and computes the check pass rate", () => {
    expect(scoresFor(makeRow({ passed: true }))).toEqual({
      passed: 1,
      checkPassRate: 0.5,
    });
    expect(scoresFor(makeRow({ passed: false }))).toEqual({
      passed: 0,
      checkPassRate: 0.5,
    });
  });

  it("falls back to passed when there are no checks", () => {
    expect(scoresFor(makeRow({ passed: true, checks: [] }))).toEqual({
      passed: 1,
      checkPassRate: 1,
    });
    expect(scoresFor(makeRow({ passed: false, checks: undefined }))).toEqual({
      passed: 0,
      checkPassRate: 0,
    });
  });

  it("reports a perfect rate when every check passes", () => {
    const row = makeRow({
      checks: [
        { name: "a", passed: true },
        { name: "b", passed: true },
      ],
    });
    expect(scoresFor(row).checkPassRate).toBe(1);
  });
});

describe("tagsFor", () => {
  it("combines interface, suite, product, and topic, deduped", () => {
    expect(tagsFor(makeRow())).toEqual([
      "cli",
      "benchmark",
      "database",
      "data-api",
      "migrations",
      "rls",
    ]);
  });

  it("drops undefined/empty values", () => {
    const row = makeRow({
      interface: undefined,
      experimentSuite: undefined,
      product: undefined,
      topic: ["rls"],
    });
    expect(tagsFor(row)).toEqual(["rls"]);
  });

  it("de-duplicates overlapping product/topic values", () => {
    const row = makeRow({ product: ["database"], topic: ["database"] } as Partial<ResultRow>);
    expect(tagsFor(row)).toEqual(["cli", "benchmark", "database"]);
  });
});

describe("metadataFor", () => {
  it("flattens experimentDisplay into first-class grouping keys", () => {
    const meta = metadataFor(makeRow());
    expect(meta.agent).toBe("claude-code");
    expect(meta.modelProvider).toBe("anthropic");
    expect(meta.modelId).toBe("claude-opus-4-8");
    expect(meta.reasoningEffort).toBe("high");
    expect(meta.skillsLoaded).toEqual(["supabase"]);
    expect(meta.eval).toBe("build-cli-001-bootstrap-app");
  });

  it("tolerates a missing experimentDisplay", () => {
    const meta = metadataFor(makeRow({ experimentDisplay: undefined }));
    expect(meta.agent).toBeUndefined();
    expect(meta.modelId).toBeUndefined();
  });
});

describe("experimentMetadata", () => {
  it("carries the per-configuration dimensions and a source marker", () => {
    expect(experimentMetadata(makeRow())).toEqual({
      experimentSuite: "benchmark",
      agent: "claude-code",
      modelProvider: "anthropic",
      modelId: "claude-opus-4-8",
      reasoningEffort: "high",
      source: "eval-results.json",
    });
  });
});
