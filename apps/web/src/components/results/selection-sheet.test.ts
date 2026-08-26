import { describe, expect, it } from "vitest"

import {
  groupRuns,
  nextGroupRunExpansion,
} from "@/components/results/selection-sheet"
import { makeResult } from "@/lib/eval-results.fixture"

const sample = (experiment: string, evalId: string, run?: number) =>
  makeResult({
    experiment,
    eval: evalId,
    run,
    sourcePath: `${experiment}/${evalId}/run-${run ?? 1}/result.json`,
  })

describe("groupRuns", () => {
  it("collapses one pair's runs into a single group, in run order", () => {
    const groups = groupRuns([
      sample("model-a", "eval-1", 3),
      sample("model-a", "eval-1", 1),
      sample("model-a", "eval-1", 2),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe("model-a::eval-1")
    expect(groups[0].runs.map((run) => run.run)).toEqual([1, 2, 3])
  })

  it("keeps one group per pair, in the order they arrive", () => {
    const groups = groupRuns([
      sample("model-b", "eval-1", 1),
      sample("model-a", "eval-1", 1),
      sample("model-b", "eval-1", 2),
    ])

    expect(groups.map((group) => group.key)).toEqual([
      "model-b::eval-1",
      "model-a::eval-1",
    ])
  })

  it("leaves a legacy row without a run index as its own group", () => {
    const groups = groupRuns([sample("model-a", "eval-1")])

    expect(groups[0].runs).toHaveLength(1)
    expect(groups[0].runs[0].run).toBeUndefined()
  })
})

describe("nextGroupRunExpansion", () => {
  const group = "model-a::eval-1"
  const path = "model-a/eval-1/run-2/result.json"

  it("expands the clicked run", () => {
    expect(nextGroupRunExpansion(group, group, path)).toBe(path)
  })

  it("falls back to the group when the open run is clicked again", () => {
    expect(nextGroupRunExpansion(path, group, path)).toBe(group)
  })
})
