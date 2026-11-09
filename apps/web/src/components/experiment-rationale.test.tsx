import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/eval-results", () => ({
  getSuiteResults: () => [],
  getVisibleExperiments: () => ["test-experiment"],
  getExperimentDisplay: () => undefined,
  getExperimentRationale: () => ({
    summary: [
      "See the ",
      { text: "model", url: "https://example.com/model" },
      ".",
    ],
    asOf: "2026-01-01",
  }),
}))

import { ExperimentRationale } from "./experiment-rationale"

describe("inline rationale links", () => {
  it("links the claim inside the sentence", () => {
    const html = renderToStaticMarkup(<ExperimentRationale />)
    expect(html).toContain('See the <a href="https://example.com/model"')
    expect(html).toContain(">model</a>.")
  })
})
