import { describe, expect, it } from "vitest"

import { scoreLabel } from "@/components/results/table-shared"

describe("scoreLabel", () => {
  it("shows pass or fail only for a single run", () => {
    expect(scoreLabel(1, 1, true)).toBe("Pass")
    expect(scoreLabel(0, 1, true)).toBe("Fail")
    expect(scoreLabel(1, 2, true)).toBe("50%")
  })
})
