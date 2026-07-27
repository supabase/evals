import { describe, expect, it } from "vitest"

import {
  formatEvalName,
  formatExperimentLabel,
  formatModelColumnLabel,
  formatProductLabel,
  formatTagLabel,
} from "@/lib/format"
import { UNASSIGNED_PRODUCT, type ExperimentDisplay } from "@/lib/eval-results"

function display(
  overrides: Partial<ExperimentDisplay> = {}
): ExperimentDisplay {
  return {
    agent: "claude-code",
    modelProvider: "anthropic",
    modelId: "claude-sonnet-5",
    ...overrides,
  } as ExperimentDisplay
}

describe("formatExperimentLabel", () => {
  it("reads as agent / model", () => {
    expect(formatExperimentLabel(display(), "fallback")).toBe(
      "Claude Code / Sonnet 5"
    )
  })

  it("appends the reasoning effort when the experiment pins one", () => {
    expect(
      formatExperimentLabel(display({ reasoningEffort: "high" }), "fallback")
    ).toBe("Claude Code / Sonnet 5 (high)")
  })

  it("falls back to the raw experiment name when the export has no display", () => {
    expect(formatExperimentLabel(undefined, "claude-code-sonnet-5")).toBe(
      "claude-code-sonnet-5"
    )
  })

  describe("anthropic model ids", () => {
    it("drops the claude- prefix and dots the version", () => {
      expect(
        formatExperimentLabel(display({ modelId: "claude-opus-4-8" }), "x")
      ).toBe("Claude Code / Opus 4.8")
    })

    it("drops a trailing release date", () => {
      expect(
        formatExperimentLabel(
          display({ modelId: "claude-haiku-4-5-20251001" }),
          "x"
        )
      ).toBe("Claude Code / Haiku 4.5")
    })

    it("passes through an id with no version to parse", () => {
      expect(formatExperimentLabel(display({ modelId: "claude" }), "x")).toBe(
        "Claude Code / claude"
      )
    })
  })

  describe("openai model ids", () => {
    const openai = (modelId: string) =>
      formatExperimentLabel(
        display({ agent: "codex", modelProvider: "openai", modelId }),
        "x"
      )

    it("upper-cases the family and keeps the version", () => {
      expect(openai("gpt-5.5")).toBe("Codex / GPT-5.5")
    })

    it("normalizes a dashed version and keeps the variant", () => {
      expect(openai("gpt-5-4-mini")).toBe("Codex / GPT-5.4 mini")
    })

    it("passes through an id that is not a gpt- model", () => {
      expect(openai("o3-pro")).toBe("Codex / o3-pro")
    })
  })
})

describe("formatModelColumnLabel", () => {
  it("drops the agent, which the column caption already carries", () => {
    expect(
      formatModelColumnLabel(display({ reasoningEffort: "high" }), "x")
    ).toBe("Sonnet 5 (high)")
  })

  it("falls back to the raw key when the export has no display", () => {
    expect(formatModelColumnLabel(undefined, "some-experiment")).toBe(
      "some-experiment"
    )
  })
})

describe("formatEvalName", () => {
  it("drops the journey stage and reads the rest as a sentence", () => {
    expect(formatEvalName("build-cli-002-declarative-schema")).toBe(
      "cli 002: declarative schema"
    )
  })

  it("keeps multi-word slugs intact", () => {
    expect(formatEvalName("resolve-security-001-rls-cross-user-leak")).toBe(
      "security 001: rls cross user leak"
    )
  })

  it("falls back to a de-hyphenated id when the shape does not match", () => {
    expect(formatEvalName("not-an-eval")).toBe("not an eval")
  })
})

describe("formatTagLabel", () => {
  it("upper-cases short words so acronyms read correctly", () => {
    expect(formatTagLabel("rls")).toBe("RLS")
    expect(formatTagLabel("sql")).toBe("SQL")
  })

  it("leaves longer words alone", () => {
    expect(formatTagLabel("migrations")).toBe("migrations")
  })

  it("handles each word independently", () => {
    expect(formatTagLabel("api security")).toBe("API security")
  })
})

describe("formatProductLabel", () => {
  it("uses the curated label for a known product", () => {
    expect(formatProductLabel("edge-functions")).toBe("Edge Functions")
    expect(formatProductLabel("data-api")).toBe("Data API")
  })

  it("names the unassigned bucket", () => {
    expect(formatProductLabel(UNASSIGNED_PRODUCT)).toBe("Unassigned")
  })

  it("falls back to tag formatting for a product with no curated label", () => {
    expect(formatProductLabel("mcp")).toBe("MCP")
  })
})
