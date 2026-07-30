import { describe, expect, it } from "vitest"

import {
  formatCost,
  formatDuration,
  formatTokens,
  hasMoreContentToRight,
  scoreLabel,
} from "@/components/results/table-shared"

describe("scoreLabel", () => {
  it("shows pass or fail only for a single run", () => {
    expect(scoreLabel(1, 1, true)).toBe("Pass")
    expect(scoreLabel(0, 1, true)).toBe("Fail")
    expect(scoreLabel(1, 2, true)).toBe("50%")
  })
})

describe("metric formatters", () => {
  it("formats durations as seconds under a minute, minutes above", () => {
    expect(formatDuration(38_000)).toBe("38s")
    expect(formatDuration(245_000)).toBe("4m 05s")
  })

  it("formats token counts compactly", () => {
    expect(formatTokens(845)).toBe("845")
    expect(formatTokens(12_400)).toBe("12k")
    expect(formatTokens(1_230_000)).toBe("1.2M")
  })

  it("keeps cents-level costs from rounding away", () => {
    expect(formatCost(0.042)).toBe("$0.042")
    expect(formatCost(1.5)).toBe("$1.50")
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
