import { afterEach, describe, expect, it } from "vitest";
import {
  RUN_THROUGH_GATEWAY_ENV,
  gatewayModelProvider,
  runThroughGateway,
  toGatewaySlug,
} from "./gateway.js";

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

describe("toGatewaySlug", () => {
  it("prefixes the vendor and swaps version dashes for dots", () => {
    expect(toGatewaySlug("anthropic", "claude-opus-4-8")).toBe(
      "anthropic/claude-opus-4.8",
    );
    expect(toGatewaySlug("anthropic", "claude-sonnet-5")).toBe(
      "anthropic/claude-sonnet-5",
    );
    expect(toGatewaySlug("openai", "gpt-5.4-mini")).toBe("openai/gpt-5.4-mini");
    // Non-version dashes (digit-letter) are untouched.
    expect(toGatewaySlug("openai", "gpt-4-turbo")).toBe("openai/gpt-4-turbo");
  });

  it("passes existing slugs through unchanged", () => {
    expect(toGatewaySlug("google", "google/gemini-3.6-flash")).toBe(
      "google/gemini-3.6-flash",
    );
  });
});

describe("runThroughGateway", () => {
  afterEach(() => {
    delete process.env[RUN_THROUGH_GATEWAY_ENV];
  });

  it("is off by default and on for truthy values only", () => {
    expect(runThroughGateway()).toBe(false);
    for (const [value, expected] of [
      ["true", true],
      ["1", true],
      ["false", false],
      ["", false],
    ] as const) {
      process.env[RUN_THROUGH_GATEWAY_ENV] = value;
      expect(runThroughGateway()).toBe(expected);
    }
  });
});
