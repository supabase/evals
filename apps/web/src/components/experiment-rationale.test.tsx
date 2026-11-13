import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/eval-results", () => ({
  getSuiteResults: () => [],
  getVisibleExperiments: () => ["test-experiment"],
  getExperimentDisplay: () => undefined,
  getExperimentResults: () => [
    { experimentCreatedAt: "2026-10-28T18:53:01.928Z" },
  ],
  getExperimentRationale: () => ({
    summary: [
      "See the ",
      { text: "model", url: "https://example.com/model" },
      ".",
    ],
  }),
}))

import { ExperimentRationale } from "./experiment-rationale"

describe("inline rationale links", () => {
  it("links the claim inside the sentence", () => {
    const html = renderToStaticMarkup(<ExperimentRationale />)
    expect(html).toContain('See the <a href="https://example.com/model"')
    expect(html).toContain(">model</a>.")
    expect(html).toContain("Experiment upload dates")
    expect(html).toContain(
      'dateTime="2026-10-28T18:53:01.928Z">2026-10-28</time>'
    )
  })
})
