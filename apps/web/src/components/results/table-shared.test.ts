import { describe, expect, it } from "vitest"

import {
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
