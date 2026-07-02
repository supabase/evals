import { describe, expect, it } from "vitest";
import { cursorCliParser } from "./parser.js";
import { buildCursorMcpConfig, cursorCliRunner } from "./runner.js";
import { adaptTranscript } from "../../parsers/adapt.js";

/** A representative `cursor-agent --output-format stream-json` stream. */
const SESSION = [
  JSON.stringify({ type: "system", subtype: "init", model: "composer-2.5", session_id: "s1" }),
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Count the rows." }] },
  }),
  JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: "c1",
    timestamp_ms: 1_780_000_000_000,
    tool_call: { shellToolCall: { args: { command: "echo 42" } } },
  }),
  JSON.stringify({
    type: "tool_call",
    subtype: "completed",
    call_id: "c1",
    tool_call: { shellToolCall: { args: { command: "echo 42" }, result: { success: { output: "42" } } } },
  }),
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "The count is 42." }] },
  }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "The count is 42." }),
].join("\n");

describe("cursorCliParser", () => {
  it("maps a shellToolCall to a canonical shell call, paired by call_id", () => {
    const { events, errors } = cursorCliParser.parseTranscript(SESSION);
    expect(errors).toEqual([]);

    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls.map((e) => e.tool?.name)).toEqual(["shell"]);
    expect(calls.map((e) => e.tool?.originalName)).toEqual(["shellToolCall"]);
    expect(calls[0].tool?.id).toBe("c1");
    expect(calls[0].tool?.command).toBe("echo 42");

    const results = events.filter((e) => e.type === "tool_result");
    expect(results[0].tool?.id).toBe("c1");
    expect(results[0].tool?.success).toBe(true);
  });

  it("adapts the transcript: report, one assistant step, paired tool result", () => {
    const { events } = cursorCliParser.parseTranscript(SESSION);
    const adapted = adaptTranscript(events);
    expect(adapted.agentReport).toBe("The count is 42.");
    expect(adapted.steps).toBe(1);
    expect(adapted.toolCalls).toEqual([
      {
        endpoint: "shellToolCall",
        body: { command: "echo 42" },
        command: "echo 42",
        result: { success: { output: "42" } },
        error: undefined,
        ts: 1_780_000_000_000,
      },
    ]);
  });

  it("marks a failed tool_result via the error result shape", () => {
    const stream = [
      JSON.stringify({ type: "tool_call", subtype: "started", call_id: "t1", tool_call: { shellToolCall: { args: { command: "false" } } } }),
      JSON.stringify({ type: "tool_call", subtype: "completed", call_id: "t1", tool_call: { shellToolCall: { args: { command: "false" }, result: { error: { message: "boom" } } } } }),
    ].join("\n");
    const { events } = cursorCliParser.parseTranscript(stream);
    const result = events.find((e) => e.type === "tool_result");
    expect(result?.tool?.success).toBe(false);
    expect(adaptTranscript(events).toolCalls[0].error).toContain("boom");
  });

  it("identifies a loaded skill from a SKILL.md read", () => {
    const stream = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "r1",
      tool_call: { readToolCall: { args: { path: "/workspace/.claude/skills/supabase/SKILL.md" } } },
    });
    const call = cursorCliParser.parseTranscript(stream).events.find((e) => e.type === "tool_call");
    expect(call?.tool?.name).toBe("file_read");
    expect(call?.tool?.loadedSkill).toBe("supabase");
    expect(adaptTranscript([call!]).toolCalls[0].loadedSkill).toBe("supabase");
  });

  it("never throws on malformed lines and records the error", () => {
    const { errors } = cursorCliParser.parseTranscript("not json\n{}\n");
    expect(errors.length).toBe(1);
  });
});

describe("cursor-cli runner", () => {
  const ok = { ok: true, exitCode: 0, stdout: "", stderr: "" };

  it("deriveStopReason reads the terminal result status", () => {
    expect(cursorCliRunner.deriveStopReason!(SESSION, ok)).toBe("stop");
    const errored = JSON.stringify({ type: "result", subtype: "error", is_error: true });
    expect(cursorCliRunner.deriveStopReason!(errored, ok)).toBe("error");
  });

  it("deriveStopReason falls back to the process result when there's no terminal event", () => {
    const timedOut = { ok: false, exitCode: 124, stdout: "", stderr: "timed out" };
    expect(cursorCliRunner.deriveStopReason!("", timedOut)).toBe("timeout");
  });

  it("reads the key from CURSOR_API_KEY", () => {
    expect(cursorCliRunner.apiKeyEnvVar).toBe("CURSOR_API_KEY");
  });

  it("builds cursor-agent's mcp.json shape", () => {
    const config = JSON.parse(
      buildCursorMcpConfig({
        supabase: { command: "npx", args: ["-y", "srv"], env: { TOKEN: "t" } },
        docs: { command: "docs-server" },
      }),
    );
    expect(config.mcpServers).toEqual({
      supabase: { command: "npx", args: ["-y", "srv"], env: { TOKEN: "t" } },
      docs: { command: "docs-server" },
    });
  });
});
