import { describe, expect, it } from "vitest";
import { claudeCodeParser } from "./claude-code.js";
import { adaptTranscript } from "./adapt.js";

/** A representative Claude Code `--print` JSONL session. */
const SESSION = [
  // init line carries no text — must not produce an event
  JSON.stringify({ type: "system", subtype: "init", cwd: "/tmp/sandbox-ab12" }),
  // assistant text + a Bash tool_use
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-18T10:00:00.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Let me list the files." },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } },
      ],
    },
  }),
  // tool_result for the Bash call
  JSON.stringify({
    type: "user",
    timestamp: "2026-06-18T10:00:01.000Z",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "file1\nfile2", is_error: false },
      ],
    },
  }),
  // assistant MCP tool_use
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_2", name: "mcp__supabase__search_docs", input: { query: "rls" } },
      ],
    },
  }),
  // failing tool_result for the MCP call
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "boom", is_error: true }],
    },
  }),
  // terminal result line — the final report
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: "Done. Listed files and searched docs.",
  }),
].join("\n");

describe("claudeCodeParser", () => {
  it("normalizes tool names while preserving the original, and pairs results by id", () => {
    const { events, errors } = claudeCodeParser.parseTranscript(SESSION);
    expect(errors).toEqual([]);

    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls.map((e) => e.tool?.name)).toEqual(["shell", "tool_use"]);
    expect(toolCalls.map((e) => e.tool?.originalName)).toEqual([
      "Bash",
      "mcp__supabase__search_docs",
    ]);
    // shell calls get the command extracted for display
    expect(toolCalls[0].tool?.args?._extractedCommand).toBe("ls -la");

    const results = events.filter((e) => e.type === "tool_result");
    expect(results.map((e) => e.tool?.id)).toEqual(["toolu_1", "toolu_2"]);
    expect(results[0].tool?.success).toBe(true);
    expect(results[1].tool?.success).toBe(false);
  });

  it("skips lines with no content and never throws on malformed lines", () => {
    const { events, errors } = claudeCodeParser.parseTranscript(
      "not json\n" + JSON.stringify({ type: "system", subtype: "init" }),
    );
    expect(events).toEqual([]);
    expect(errors.length).toBe(1);
  });
});

describe("adaptTranscript", () => {
  const { events } = claudeCodeParser.parseTranscript(SESSION);
  const adapted = adaptTranscript(events);

  it("derives the final report and assistant-turn count", () => {
    expect(adapted.agentReport).toBe("Done. Listed files and searched docs.");
    // two assistant messages: the opening text and the closing result line
    expect(adapted.steps).toBe(2);
  });

  it("builds tool calls keyed by the original tool name, with results paired in", () => {
    expect(adapted.toolCalls).toEqual([
      {
        endpoint: "Bash",
        body: { command: "ls -la" },
        result: "file1\nfile2",
        error: undefined,
        ts: Date.parse("2026-06-18T10:00:00.000Z"),
      },
      {
        endpoint: "mcp__supabase__search_docs",
        body: { query: "rls" },
        result: undefined,
        error: "boom",
        ts: 0,
      },
    ]);
  });

  it("renders a scorer-facing transcript (messages + tool calls, _extracted keys stripped)", () => {
    expect(adapted.transcript).toEqual([
      { type: "message", role: "assistant", content: "Let me list the files." },
      {
        type: "tool_call",
        name: "Bash",
        input: { command: "ls -la" },
        output: "file1\nfile2",
        error: undefined,
      },
      {
        type: "tool_call",
        name: "mcp__supabase__search_docs",
        input: { query: "rls" },
        output: undefined,
        error: "boom",
      },
      { type: "message", role: "assistant", content: "Done. Listed files and searched docs." },
    ]);
  });
});
