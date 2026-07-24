import { describe, expect, it } from "vitest";
import { claudeCodeRunner } from "./runner.js";
import type { CommandResult } from "../../index.js";

const ok: CommandResult = { ok: true, exitCode: 0, stdout: "", stderr: "" };
const timedOut: CommandResult = {
  ok: false,
  exitCode: 124,
  stdout: "",
  stderr: "[command timed out after 540s and was terminated]",
};
const failed: CommandResult = { ok: false, exitCode: 1, stdout: "", stderr: "boom" };

/** A minimal `--output-format stream-json` stdout: init line + result line. */
function streamJson(subtype: string, isError = false): string {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-4-5" }),
    JSON.stringify({
      type: "result",
      subtype,
      is_error: isError,
      result: "all done",
      num_turns: 3,
      session_id: "s1",
    }),
  ].join("\n");
}

describe("claudeCodeRunner.exec env", () => {
  async function execEnv(gateway: boolean): Promise<Record<string, string>> {
    let env: Record<string, string> = {};
    await claudeCodeRunner.exec({
      sandbox: {
        workspace: "/w",
        exec: async (_cmd, options) => {
          if (options?.env) env = options.env;
          return { ...ok, stdout: streamJson("success") };
        },
        readFile: async () => "",
      },
      model: "anthropic/claude-sonnet-5",
      apiKey: "test-key",
      gateway,
      systemPromptPath: "/s",
      userPromptPath: "/u",
      mcpServers: {},
      timeoutSec: 1,
    });
    return env;
  }

  it("routes through the AI Gateway when gateway is set", async () => {
    expect(await execEnv(true)).toEqual({
      ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
      ANTHROPIC_AUTH_TOKEN: "test-key",
      // Must be empty: Claude Code prefers ANTHROPIC_API_KEY when non-empty.
      ANTHROPIC_API_KEY: "",
    });
  });

  it("keeps the direct Anthropic env otherwise", async () => {
    expect(await execEnv(false)).toEqual({ ANTHROPIC_API_KEY: "test-key" });
  });
});

describe("claudeCodeRunner.deriveStopReason", () => {
  const derive = claudeCodeRunner.deriveStopReason!;

  it("maps a successful result event to a normal stop", () => {
    expect(derive(streamJson("success"), ok)).toBe("stop");
  });

  it("surfaces non-success result subtypes verbatim", () => {
    expect(derive(streamJson("error_max_turns", true), ok)).toBe("error_max_turns");
  });

  it("falls back to the process result when there is no result event", () => {
    expect(derive(undefined, timedOut)).toBe("timeout");
    expect(derive("not json\n", failed)).toBe("error_exit_1");
    expect(derive(undefined, ok)).toBe("stop");
  });
});
