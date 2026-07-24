import { describe, expect, it } from "vitest";
import { gatewayModelProvider } from "./gateway.js";

describe("gatewayModelProvider", () => {
  it("parses the vendor from a gateway slug", () => {
    expect(gatewayModelProvider("anthropic/claude-sonnet-5")).toBe("anthropic");
    expect(gatewayModelProvider("openai/gpt-5.4-mini")).toBe("openai");
    expect(gatewayModelProvider("google/gemini-3.6-flash")).toBe("google");
  });

  it("infers the vendor for bare Anthropic/OpenAI ids", () => {
    expect(gatewayModelProvider("claude-sonnet-4-6")).toBe("anthropic");
    expect(gatewayModelProvider("gpt-5.4")).toBe("openai");
    expect(gatewayModelProvider("o4-mini")).toBe("openai");
  });

  it("rejects vendors outside the benchmark's provider enum", () => {
    expect(() => gatewayModelProvider("mistral/mistral-large")).toThrow(
      /unsupported AI Gateway model vendor/,
    );
  });

  it("rejects bare ids it cannot attribute to a vendor", () => {
    expect(() => gatewayModelProvider("gemini-3.6-flash")).toThrow(
      /vendor\/model slug/,
    );
  });
});
