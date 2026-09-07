import { describe, expect, it } from "vitest"

import {
  formatDuration,
  formatTokens,
  hasMoreContentToRight,
  sampleSetLabel,
  scoreLabel,
} from "@/components/results/table-shared"

describe("scoreLabel", () => {
  it("shows pass or fail only for a single run", () => {
    expect(scoreLabel(1, 1, true)).toBe("Pass")
    expect(scoreLabel(0, 1, true)).toBe("Fail")
    expect(scoreLabel(1, 2, true)).toBe("50%")
  })

  it("shows a multi-run pair as its pass rate", () => {
    expect(scoreLabel(2, 3, true)).toBe("67%")
  })
})

describe("sampleSetLabel", () => {
  it("shows both the fraction and the rate", () => {
    expect(sampleSetLabel(2, 3)).toBe("2/3 \u00b7 67%")
  })
})

describe("metric formatters", () => {
  it("formats durations", () => {
    expect(formatDuration(38_000)).toBe("38s")
    expect(formatDuration(245_000)).toBe("4m 05s")
  })

  it("formats tokens as a total with the in/out split, summed across models", () => {
    expect(
      formatTokens([
        {
          model: "claude-sonnet-5",
          inputTokens: 442_717,
          cacheReadInputTokens: 418_062,
          cacheWriteInputTokens: 20_952,
          outputTokens: 1_693,
        },
        {
          model: "claude-haiku-4-5-20251001",
          inputTokens: 519,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 14,
        },
      ])
    ).toBe("444.9K (443.2K in / 1.7K out)")
  })
})

describe("hasMoreContentToRight", () => {
  it("only reports overflow before the right edge", () => {
    expect(
      hasMoreContentToRight({
        scrollLeft: 0,
        clientWidth: 100,
        scrollWidth: 200,
      })
    ).toBe(true)
    expect(
      hasMoreContentToRight({
        scrollLeft: 100,
        clientWidth: 100,
        scrollWidth: 200,
      })
    ).toBe(false)
  })
})
