import { describe, expect, it } from "vitest"

import { makeResult } from "@/lib/eval-results.fixture"
import {
  EXPERIMENT_SUITES,
  JOURNEY_STAGES,
  UNASSIGNED_PRODUCT,
  getEvalIds,
  getProductKeys,
  getProductResults,
  getVisibleExperiments,
  runTokens,
  scoreResults,
  sortResults,
  sortedResults,
} from "@/lib/eval-results"

describe("sortResults", () => {
  const order = (results: ReturnType<typeof makeResult>[]) =>
    [...results].sort(sortResults).map((result) => result.eval)

  it("orders by journey stage before anything else", () => {
    expect(
      order([
        makeResult({ eval: "a", category: "resolve" }),
        makeResult({ eval: "b", category: "build" }),
        makeResult({ eval: "c", category: "investigate" }),
        makeResult({ eval: "d", category: "deploy" }),
      ])
    ).toEqual(["b", "d", "c", "a"])
  })

  it("sorts an unrecognized stage last", () => {
    expect(
      order([
        makeResult({ eval: "unknown", category: "unknown" }),
        makeResult({ eval: "resolve", category: "resolve" }),
        makeResult({ eval: "build", category: "build" }),
      ])
    ).toEqual(["build", "resolve", "unknown"])
  })

  it("falls back to topic, then eval id, within a stage", () => {
    expect(
      order([
        makeResult({ eval: "b", category: "build", primaryCategory: "rls" }),
        makeResult({ eval: "a", category: "build", primaryCategory: "rls" }),
        makeResult({ eval: "c", category: "build", primaryCategory: "cron" }),
      ])
    ).toEqual(["c", "a", "b"])
  })
})

describe("getProductKeys", () => {
  it("collects every product across runs, alphabetically", () => {
    expect(
      getProductKeys([
        makeResult({ product: ["storage"] }),
        makeResult({ product: ["auth", "database"] }),
      ])
    ).toEqual(["auth", "database", "storage"])
  })

  it("dedupes a product that several runs share", () => {
    expect(
      getProductKeys([
        makeResult({ product: ["auth"] }),
        makeResult({ product: ["auth", "database"] }),
      ])
    ).toEqual(["auth", "database"])
  })

  it("pins the unassigned bucket last, after the named products", () => {
    // Enough products, with the unassigned run part way through, that the
    // comparator has to actually move it rather than landing there by luck.
    expect(
      getProductKeys([
        makeResult({ product: ["storage"] }),
        makeResult({ product: ["vectors"] }),
        makeResult({ product: [] }),
        makeResult({ product: ["auth"] }),
        makeResult({ product: ["database"] }),
      ])
    ).toEqual(["auth", "database", "storage", "vectors", UNASSIGNED_PRODUCT])
  })

  it("omits the unassigned bucket when every run declares a product", () => {
    expect(getProductKeys([makeResult({ product: ["auth"] })])).toEqual([
      "auth",
    ])
  })
})

describe("getProductResults", () => {
  const results = [
    makeResult({ eval: "multi", product: ["auth", "database"] }),
    makeResult({ eval: "single", product: ["database"] }),
    makeResult({ eval: "none", product: [] }),
  ]

  it("matches a run on any of its products, not just the first", () => {
    expect(getProductResults("auth", results).map((r) => r.eval)).toEqual([
      "multi",
    ])
    expect(getProductResults("database", results).map((r) => r.eval)).toEqual([
      "multi",
      "single",
    ])
  })

  it("treats the unassigned key as runs with no product at all", () => {
    expect(
      getProductResults(UNASSIGNED_PRODUCT, results).map((r) => r.eval)
    ).toEqual(["none"])
  })
})

describe("getEvalIds", () => {
  it("dedupes the runs of one eval across experiments", () => {
    expect(
      getEvalIds([
        makeResult({ eval: "a", experiment: "one" }),
        makeResult({ eval: "a", experiment: "two" }),
        makeResult({ eval: "b", experiment: "one" }),
      ])
    ).toEqual(["a", "b"])
  })

  it("preserves the order it is given rather than re-sorting", () => {
    expect(
      getEvalIds([
        makeResult({ eval: "z" }),
        makeResult({ eval: "a" }),
        makeResult({ eval: "m" }),
      ])
    ).toEqual(["z", "a", "m"])
  })
})

describe("getVisibleExperiments", () => {
  it("dedupes and sorts the experiments present in the runs", () => {
    expect(
      getVisibleExperiments([
        makeResult({ experiment: "codex" }),
        makeResult({ experiment: "claude-code" }),
        makeResult({ experiment: "codex" }),
      ])
    ).toEqual(["claude-code", "codex"])
  })
})

describe("scoreResults", () => {
  it("counts passes against the total", () => {
    expect(
      scoreResults([
        makeResult({ passed: true }),
        makeResult({ passed: false }),
        makeResult({ passed: true }),
      ])
    ).toEqual({ passed: 2, total: 3 })
  })

  it("reports zero of zero for an empty selection", () => {
    expect(scoreResults([])).toEqual({ passed: 0, total: 0 })
  })
})

describe("runTokens", () => {
  it("prefers the harness's own total, else sums input and output", () => {
    expect(
      runTokens(makeResult({ usage: { totalTokens: 500, inputTokens: 400 } }))
    ).toBe(500)
    expect(
      runTokens(makeResult({ usage: { inputTokens: 400, outputTokens: 50 } }))
    ).toBe(450)
  })

  it("is undefined without token counts", () => {
    expect(runTokens(makeResult())).toBeUndefined()
    expect(runTokens(makeResult({ usage: { costUsd: 0.1 } }))).toBeUndefined()
  })
})

/**
 * The site renders whatever `pnpm export-results` last wrote, so these guard the
 * boundary between that export and the assumptions the UI makes about it.
 */
describe("the exported results", () => {
  it("parses against the schema and is not empty", () => {
    expect(sortedResults.length).toBeGreaterThan(0)
  })

  it("only carries stages the journey knows about", () => {
    const known = new Set<string>(JOURNEY_STAGES.map((stage) => stage.id))
    const unknown = sortedResults
      .filter((result) => !known.has(result.category))
      .map((result) => result.eval)

    expect(Array.from(new Set(unknown))).toEqual([])
  })

  it("only carries suites the suite control can select", () => {
    const suites = new Set(
      sortedResults.map((result) => result.experimentSuite)
    )

    expect(Array.from(suites).sort()).toEqual(
      [...EXPERIMENT_SUITES].sort((a, b) => a.localeCompare(b))
    )
  })

  it("is in canonical order", () => {
    const resorted = [...sortedResults].sort(sortResults)

    expect(sortedResults.map((r) => r.sourcePath)).toEqual(
      resorted.map((r) => r.sourcePath)
    )
  })

  it("describes each experiment the same way on every one of its runs", () => {
    const byExperiment = new Map<string, Set<string>>()

    for (const result of sortedResults) {
      const seen = byExperiment.get(result.experiment) ?? new Set<string>()
      seen.add(JSON.stringify(result.experimentDisplay ?? null))
      byExperiment.set(result.experiment, seen)
    }

    // getExperimentDisplay picks the first matching run, so a disagreement here
    // would silently change a model's label depending on sort order.
    const inconsistent = Array.from(byExperiment)
      .filter(([, seen]) => seen.size > 1)
      .map(([experiment]) => experiment)

    expect(inconsistent).toEqual([])
  })
})
