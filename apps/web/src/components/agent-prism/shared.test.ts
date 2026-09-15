import { describe, expect, it } from "vitest"
import { deepParseJson, formatTokenCount } from "./shared"

describe("formatTokenCount", () => {
  it("renders under-1000 counts as-is", () => {
    expect(formatTokenCount(0)).toBe("0")
    expect(formatTokenCount(999)).toBe("999")
  })

  it("renders thousands with one decimal and a K suffix", () => {
    expect(formatTokenCount(2_760)).toBe("2.8K")
    expect(formatTokenCount(164_900)).toBe("164.9K")
  })

  it("renders millions with an M suffix", () => {
    expect(formatTokenCount(1_500_000)).toBe("1.5M")
  })
})

describe("deepParseJson", () => {
  it("recursively parses a JSON string nested inside another JSON structure", () => {
    const raw = {
      content: [
        { type: "text", text: '{"error":{"name":"Error","message":"boom"}}' },
      ],
      isError: true,
    }
    expect(deepParseJson(raw)).toEqual({
      content: [
        { type: "text", text: { error: { name: "Error", message: "boom" } } },
      ],
      isError: true,
    })
  })

  it("leaves plain strings that are not JSON objects/arrays alone", () => {
    expect(deepParseJson("hello world")).toBe("hello world")
    expect(deepParseJson("5")).toBe("5") // not treated as JSON number 5
    expect(deepParseJson("true")).toBe("true")
  })

  it("leaves a malformed JSON-looking string alone instead of throwing", () => {
    expect(deepParseJson("{not valid json")).toBe("{not valid json")
  })

  it("recurses into arrays too", () => {
    expect(deepParseJson(['{"a":1}', "plain"])).toEqual([{ a: 1 }, "plain"])
  })
})
