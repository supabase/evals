import { describe, expect, it } from "vitest"

import {
  DIMENSIONS,
  DIMENSION_ORDER,
  GROUP_BY_OPTIONS,
  dimensionCell,
  dimensionShortTitle,
  orderRuns,
  tableSelection,
  type GroupBy,
} from "@/lib/dimensions"
import { makeResult } from "@/lib/eval-results.fixture"
import {
  JOURNEY_STAGES,
  UNASSIGNED_PRODUCT,
  sortResults,
  sortedResults,
} from "@/lib/eval-results"

describe("the dimension registry", () => {
  it("covers every group-by axis", () => {
    const ids = Object.keys(DIMENSIONS) as GroupBy[]

    expect([...GROUP_BY_OPTIONS].sort()).toEqual(ids.sort())
    expect(DIMENSION_ORDER.map((d) => d.id).sort()).toEqual(ids.sort())
  })

  it("keys each entry by its own id", () => {
    for (const [id, dimension] of Object.entries(DIMENSIONS)) {
      expect(dimension.id).toBe(id)
    }
  })
})

describe("the stage dimension", () => {
  it("keeps every journey stage visible, even one no eval covers", () => {
    expect(DIMENSIONS.stage.keys([makeResult({ category: "build" })])).toEqual(
      JOURNEY_STAGES.map((stage) => stage.id)
    )
  })

  it("filters runs to the stage they were filed under", () => {
    const runs = [
      makeResult({ eval: "a", category: "build" }),
      makeResult({ eval: "b", category: "resolve" }),
    ]

    expect(DIMENSIONS.stage.filter("resolve", runs).map((r) => r.eval)).toEqual(
      ["b"]
    )
  })

  it("titles a stage and explains it in the tooltip", () => {
    expect(DIMENSIONS.stage.title("investigate")).toBe("Investigate")
    expect(DIMENSIONS.stage.tooltip?.("investigate")).toContain("observability")
  })

  it("titles a stage it does not recognize as Unknown", () => {
    expect(DIMENSIONS.stage.title("nonsense")).toBe("Unknown")
  })
})

describe("the product dimension", () => {
  it("buckets a run under its first product", () => {
    expect(
      DIMENSIONS.product.keyOf(makeResult({ product: ["auth", "db"] }))
    ).toBe("auth")
  })

  it("buckets a run with no product under the unassigned key", () => {
    expect(DIMENSIONS.product.keyOf(makeResult({ product: [] }))).toBe(
      UNASSIGNED_PRODUCT
    )
  })

  it("reads a multi-product run as its full list, not just its bucket", () => {
    expect(
      dimensionCell(
        DIMENSIONS.product,
        makeResult({ product: ["auth", "edge-functions"] })
      )
    ).toBe("Auth, Edge Functions")
  })

  it("reads a run with no product as Unassigned", () => {
    expect(dimensionCell(DIMENSIONS.product, makeResult({ product: [] }))).toBe(
      "Unassigned"
    )
  })
})

describe("the eval dimension", () => {
  it("pins the axes an eval selection already determines", () => {
    // Every run of one eval shares its stage and products, so the sheet drops
    // those columns rather than repeating a constant.
    expect(DIMENSIONS.eval.implies).toEqual(["stage", "product"])
  })

  it("keeps the raw id available as a tooltip", () => {
    expect(DIMENSIONS.eval.tooltip?.("build-cli-001-bootstrap-app")).toBe(
      "build-cli-001-bootstrap-app"
    )
  })
})

describe("dimensionShortTitle", () => {
  it("prefers the compact title when the axis defines one", () => {
    // The model axis splits agent (caption) from model (short title).
    const experiment = sortedResults[0].experiment
    expect(dimensionShortTitle(DIMENSIONS.model, experiment)).not.toBe(
      DIMENSIONS.model.title(experiment)
    )
  })

  it("falls back to the full title for an axis with no compact form", () => {
    expect(dimensionShortTitle(DIMENSIONS.stage, "build")).toBe("Build")
  })
})

describe("tableSelection", () => {
  it("deep-links a score cell when its dimensions identify one run", () => {
    const run = makeResult({
      eval: "build-cli-001-bootstrap-app",
      sourcePath: "claude-code-sonnet-5/build-cli-001-bootstrap-app.json",
    })

    expect(tableSelection(DIMENSIONS.eval, run.eval, [run])).toEqual({
      dimension: "eval",
      key: run.eval,
      expandedRun: run.sourcePath,
    })
  })

  it("deep-links the sample set when a cell is one pair's runs", () => {
    const runs = [1, 2, 3].map((run) =>
      makeResult({
        eval: "build-cli-001-bootstrap-app",
        run,
        sourcePath: `claude-code-sonnet-5/build-cli-001-bootstrap-app/run-${run}/result.json`,
      })
    )

    expect(tableSelection(DIMENSIONS.eval, runs[0].eval, runs)).toEqual({
      dimension: "eval",
      key: runs[0].eval,
      expandedRun: "claude-code-sonnet-5::build-cli-001-bootstrap-app",
    })
  })

  it("leaves aggregate cells at the sheet level", () => {
    const runs = [
      makeResult({ eval: "a", sourcePath: "model/a.json" }),
      makeResult({ eval: "b", sourcePath: "model/b.json" }),
    ]

    expect(tableSelection(DIMENSIONS.stage, "build", runs)).toEqual({
      dimension: "stage",
      key: "build",
    })
  })

  it("leaves row and column selections at the sheet level", () => {
    expect(tableSelection(DIMENSIONS.model, "model-a")).toEqual({
      dimension: "model",
      key: "model-a",
    })
  })
})

describe("orderRuns", () => {
  it("sorts by the first column, then the second", () => {
    const runs = [
      makeResult({ eval: "b", category: "resolve" }),
      makeResult({ eval: "a", category: "resolve" }),
      makeResult({ eval: "b", category: "build" }),
      makeResult({ eval: "a", category: "build" }),
    ]
    const table = [...runs].sort(sortResults)

    const ordered = orderRuns(runs, [DIMENSIONS.stage, DIMENSIONS.eval], table)

    expect(ordered.map((r) => `${r.category}/${r.eval}`)).toEqual([
      "build/a",
      "build/b",
      "resolve/a",
      "resolve/b",
    ])
  })

  it("ranks against the whole table, not just the selected runs", () => {
    const runs = [
      makeResult({ eval: "late", category: "resolve" }),
      makeResult({ eval: "mid", category: "investigate" }),
    ]

    expect(
      orderRuns(runs, [DIMENSIONS.stage], sortedResults).map((r) => r.eval)
    ).toEqual(["mid", "late"])
  })

  it("takes a column's key order from the table, so the eval axis is not alphabetical", () => {
    // getEvalIds preserves the order it is handed rather than re-sorting, which
    // is what keeps sheet rows in the same order as the table's eval rows.
    const runs = [
      makeResult({ eval: "a", category: "build" }),
      makeResult({ eval: "z", category: "build" }),
    ]
    const table = [
      makeResult({ eval: "z", category: "build" }),
      makeResult({ eval: "a", category: "build" }),
    ]

    expect(
      orderRuns(runs, [DIMENSIONS.eval], table).map((r) => r.eval)
    ).toEqual(["z", "a"])
  })

  it("falls back to canonical order for runs a column cannot separate", () => {
    const runs = [
      makeResult({ eval: "z", category: "build" }),
      makeResult({ eval: "a", category: "build" }),
    ]

    expect(
      orderRuns(runs, [DIMENSIONS.stage], runs).map((r) => r.eval)
    ).toEqual(["a", "z"])
  })

  it("leaves the input array untouched", () => {
    const runs = [
      makeResult({ eval: "b", category: "resolve" }),
      makeResult({ eval: "a", category: "build" }),
    ]

    orderRuns(runs, [DIMENSIONS.stage], runs)

    expect(runs.map((r) => r.eval)).toEqual(["b", "a"])
  })
})

describe("the model dimension, against the real export", () => {
  it("presents the experiment axis as Agent", () => {
    expect(DIMENSIONS.model.label).toBe("Agent")
  })

  it("labels every experiment rather than falling back to its raw id", () => {
    const experiments = Array.from(
      new Set(sortedResults.map((result) => result.experiment))
    )

    const unlabelled = experiments.filter(
      (experiment) => DIMENSIONS.model.title(experiment) === experiment
    )

    expect(unlabelled).toEqual([])
  })

  it("ranks experiments best first", () => {
    const keys = DIMENSIONS.model.keys(sortedResults)
    const passRateOf = (experiment: string) => {
      const runs = DIMENSIONS.model.filter(experiment, sortedResults)
      return runs.filter((run) => run.passed).length / runs.length
    }

    const rates = keys.map(passRateOf)
    expect(rates).toEqual([...rates].sort((a, b) => b - a))
  })
})
