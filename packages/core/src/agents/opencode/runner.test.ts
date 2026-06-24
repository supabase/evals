import { describe, expect, it } from "vitest";
import {
  buildOpencodeConfig,
  createOpencodeRunner,
  providerApiKeyEnv,
} from "./runner.js";

/** A run's terminal records: a mid-run `step_finish` (tool-calls) then the final one. */
const SESSION = [
  JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "tool-calls" } }),
  JSON.stringify({ type: "text", part: { type: "text", text: "Done." } }),
  JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "stop" } }),
].join("\n");

describe("opencode runner", () => {
  it("resolves the API-key env var from the model's provider prefix", () => {
    expect(providerApiKeyEnv("anthropic/claude-sonnet-5")).toBe("ANTHROPIC_API_KEY");
    expect(providerApiKeyEnv("openai/gpt-5.4")).toBe("OPENAI_API_KEY");
    // opencode's google provider reads GOOGLE_GENERATIVE_AI_API_KEY, not GEMINI_API_KEY.
    expect(providerApiKeyEnv("google/gemini-flash-latest")).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
  });

  it("throws a clear error for an unsupported provider", () => {
    expect(() => providerApiKeyEnv("openrouter/some-model")).toThrowError(
      /Unsupported opencode provider "openrouter".*Supported: anthropic, openai, google/,
    );
  });

  it("carries the provider on the runner for experiment display metadata", () => {
    expect(createOpencodeRunner("openai/gpt-5.4").modelProvider).toBe("openai");
    expect(createOpencodeRunner("google/gemini-flash-latest").modelProvider).toBe("google");
  });

  it("deriveStopReason reads the terminal step_finish reason", () => {
    const runner = createOpencodeRunner("anthropic/claude-sonnet-5");
    const ok = { ok: true, exitCode: 0, stdout: "", stderr: "" };
    expect(runner.deriveStopReason!(SESSION, ok)).toBe("stop");
    // A non-stop terminal reason is surfaced verbatim.
    const length = JSON.stringify({ type: "step_finish", part: { reason: "length" } });
    expect(runner.deriveStopReason!(length, ok)).toBe("length");
    // An error event wins regardless of exit code.
    const errored = JSON.stringify({ type: "error", error: { message: "model overloaded" } });
    expect(runner.deriveStopReason!(errored, ok)).toBe("error");
  });

  it("builds opencode's MCP config shape from harness server configs", () => {
    const config = JSON.parse(
      buildOpencodeConfig({
        supabase: { command: "npx", args: ["-y", "srv"], env: { TOKEN: "t" } },
        docs: { command: "docs-server" },
      }),
    );
    expect(config.mcp).toEqual({
      supabase: {
        type: "local",
        command: ["npx", "-y", "srv"],
        enabled: true,
        environment: { TOKEN: "t" },
      },
      // No env → no `environment` key.
      docs: { type: "local", command: ["docs-server"], enabled: true },
    });
  });
});
