import { describe, expect, it } from "vitest";
import { geminiCliParser } from "./parser.js";
import { buildGeminiSettings, geminiCliRunner } from "./runner.js";
import { adaptTranscript } from "../../parsers/adapt.js";

/** A representative `gemini --output-format stream-json` stream (shapes from CLI 0.20.2). */
const SESSION = [
  JSON.stringify({ type: "init", session_id: "s1", model: "gemini-3.5-flash" }),
  JSON.stringify({ type: "message", role: "user", content: "Count the rows." }),
  JSON.stringify({
    type: "tool_use",
    timestamp: "2026-06-24T11:14:21.542Z",
    tool_name: "run_shell_command",
    tool_id: "run_shell_command-1-abc",
    parameters: { description: "echo", command: "echo 42" },
  }),
  JSON.stringify({
    type: "tool_result",
    tool_id: "run_shell_command-1-abc",
    status: "success",
    output: "42",
  }),
  // Assistant text streamed as two delta chunks — must merge into one message.
  JSON.stringify({ type: "message", role: "assistant", content: "The number ", delta: true }),
  JSON.stringify({ type: "message", role: "assistant", content: "is 42.", delta: true }),
  JSON.stringify({ type: "result", status: "success", stats: { tool_calls: 1 } }),
].join("\n");

describe("geminiCliParser", () => {
  it("maps run_shell_command to a canonical shell call, paired by tool_id", () => {
    const { events, errors } = geminiCliParser.parseTranscript(SESSION);
    expect(errors).toEqual([]);

    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls.map((e) => e.tool?.name)).toEqual(["shell"]);
    expect(calls.map((e) => e.tool?.originalName)).toEqual(["run_shell_command"]);
    expect(calls[0].tool?.id).toBe("run_shell_command-1-abc");
    expect(calls[0].tool?.command).toBe("echo 42");

    const results = events.filter((e) => e.type === "tool_result");
    expect(results[0].tool?.id).toBe("run_shell_command-1-abc");
    expect(results[0].tool?.success).toBe(true);
  });

  it("merges streamed assistant deltas into one message + surfaces the report", () => {
    const events = geminiCliParser.parseTranscript(SESSION).events;
    const assistantMessages = events.filter(
      (e) => e.type === "message" && e.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].content).toBe("The number is 42.");

    const adapted = adaptTranscript(events);
    expect(adapted.agentReport).toBe("The number is 42.");
    expect(adapted.steps).toBe(1); // one merged assistant turn, not two deltas
    expect(adapted.toolCalls).toEqual([
      {
        endpoint: "run_shell_command",
        body: { description: "echo", command: "echo 42" },
        command: "echo 42",
        result: "42",
        error: undefined,
        ts: Date.parse("2026-06-24T11:14:21.542Z"),
      },
    ]);
  });

  it("marks a failed tool_result via status and never throws on malformed lines", () => {
    const stream = [
      "not json",
      JSON.stringify({ type: "tool_use", tool_name: "run_shell_command", tool_id: "t-1", parameters: { command: "false" } }),
      JSON.stringify({ type: "tool_result", tool_id: "t-1", status: "error", error: "boom" }),
    ].join("\n");
    const { events, errors } = geminiCliParser.parseTranscript(stream);
    expect(errors.length).toBe(1);
    const result = events.find((e) => e.type === "tool_result");
    expect(result?.tool?.success).toBe(false);
    expect(adaptTranscript(events).toolCalls[0].error).toBe("boom");
  });

  it("identifies a loaded skill from a SKILL.md read", () => {
    const stream = JSON.stringify({
      type: "tool_use",
      tool_name: "read_file",
      tool_id: "r-1",
      parameters: { absolute_path: "/workspace/.claude/skills/supabase/SKILL.md" },
    });
    const call = geminiCliParser.parseTranscript(stream).events.find((e) => e.type === "tool_call");
    expect(call?.tool?.loadedSkill).toBe("supabase");
    expect(adaptTranscript([call!]).toolCalls[0].loadedSkill).toBe("supabase");
  });

  it("maps the 0.46+ update_topic built-in to agent_task", () => {
    const stream = JSON.stringify({
      type: "tool_use",
      tool_name: "update_topic",
      tool_id: "u-1",
      parameters: { topic: "Counting rows" },
    });
    const call = geminiCliParser.parseTranscript(stream).events.find((e) => e.type === "tool_call");
    expect(call?.tool?.name).toBe("agent_task");
    expect(call?.tool?.originalName).toBe("update_topic");
  });

  it("keeps two non-delta assistant messages as separate turns", () => {
    const stream = [
      JSON.stringify({ type: "message", role: "assistant", content: "First." }),
      JSON.stringify({ type: "message", role: "assistant", content: "Second." }),
    ].join("\n");
    const events = geminiCliParser.parseTranscript(stream).events;
    expect(
      events.filter((e) => e.type === "message" && e.role === "assistant").map((e) => e.content),
    ).toEqual(["First.", "Second."]);
  });

  it("emits an error event from an error record", () => {
    const events = geminiCliParser.parseTranscript(
      JSON.stringify({ type: "error", error: { message: "quota exceeded" } }),
    ).events;
    expect(events).toEqual([
      { timestamp: undefined, type: "error", content: "quota exceeded", raw: { type: "error", error: { message: "quota exceeded" } } },
    ]);
  });
});

describe("gemini-cli runner", () => {
  const ok = { ok: true, exitCode: 0, stdout: "", stderr: "" };

  it("deriveStopReason reads the terminal result status", () => {
    expect(geminiCliRunner.deriveStopReason!(SESSION, ok)).toBe("stop");
    const errored = JSON.stringify({ type: "result", status: "error" });
    expect(geminiCliRunner.deriveStopReason!(errored, ok)).toBe("error");
  });

  it("deriveStopReason falls back to the process result when there's no terminal event", () => {
    const timedOut = { ok: false, exitCode: 124, stdout: "", stderr: "timed out" };
    expect(geminiCliRunner.deriveStopReason!("", timedOut)).toBe("timeout");
  });

  it("reads the key from GEMINI_API_KEY", () => {
    expect(geminiCliRunner.apiKeyEnvVar).toBe("GEMINI_API_KEY");
  });

  it("builds gemini-cli's settings.json MCP shape", () => {
    const settings = JSON.parse(
      buildGeminiSettings({
        supabase: { command: "npx", args: ["-y", "srv"], env: { TOKEN: "t" } },
        docs: { command: "docs-server" },
      }),
    );
    expect(settings.mcpServers).toEqual({
      supabase: { command: "npx", args: ["-y", "srv"], env: { TOKEN: "t" } },
      docs: { command: "docs-server" },
    });
  });
});
