import { createLoader, createSerializer } from "nuqs"
import { describe, expect, it } from "vitest"

import {
  resultsQueryKeys,
  resultsQueryParsers,
  selectionQueryKeys,
  selectionQueryParsers,
} from "@/lib/url-state"

const loadResultsQuery = createLoader(resultsQueryParsers, {
  urlKeys: resultsQueryKeys,
})
const serializeResultsQuery = createSerializer(resultsQueryParsers, {
  urlKeys: resultsQueryKeys,
})
const loadSelectionQuery = createLoader(selectionQueryParsers, {
  urlKeys: selectionQueryKeys,
})

describe("results URL state", () => {
  it("loads grouping and skill settings from readable query values", () => {
    expect(loadResultsQuery("?group=eval&skills=without")).toEqual({
      groupBy: "eval",
      experimentSuite: "no-skills",
    })
  })

  it("falls back to the current defaults for invalid settings", () => {
    expect(loadResultsQuery("?group=invalid&skills=invalid")).toEqual({
      groupBy: "model",
      experimentSuite: "benchmark",
    })
  })

  it("serializes the experiment suite as the choice shown in the UI", () => {
    expect(
      serializeResultsQuery("", {
        groupBy: "product",
        experimentSuite: "no-skills",
      })
    ).toBe("?group=product&skills=without")
  })
})

describe("selection URL state", () => {
  it("loads the open sheet, selected item, and expanded result row", () => {
    expect(
      loadSelectionQuery(
        "?sheet=eval&item=build-cli-001-bootstrap-app&run=codex%2Fresult.json"
      )
    ).toEqual({
      dimension: "eval",
      key: "build-cli-001-bootstrap-app",
      run: "codex/result.json",
    })
  })
})
