import { describe, expect, it } from "vitest";
import { assembleAgentTrace } from "./agent-trace.js";
import type { TranscriptEvent } from "./types.js";

describe("assembleAgentTrace with turn keys (Claude Code style)", () => {
  const events: TranscriptEvent[] = [
    // Turn 1: one assistant API message with thinking + text + two tool uses.
    {
      type: "thinking",
      content: "let me look",
      turnKey: "msg_1",
      messageId: "msg_1",
      usage: { inputTokens: 100, outputTokens: 10 },
    },
    {
      type: "message",
      role: "assistant",
      content: "Checking the tables.",
      turnKey: "msg_1",
      messageId: "msg_1",
      usage: { inputTokens: 100, outputTokens: 10 },
    },
    {
      type: "tool_call",
      turnKey: "msg_1",
      tool: { name: "shell", originalName: "Bash", id: "t1", args: { command: "ls" }, command: "ls" },
    },
    {
      type: "tool_call",
      turnKey: "msg_1",
      tool: { name: "agent_task", originalName: "Task", id: "t2", args: { prompt: "explore" } },
    },
    // Results arrive on later lines.
    { type: "tool_result", tool: { name: "unknown", originalName: "t1", id: "t1", result: "files", success: true } },
    // Subagent sidechain spawned by the Task call.
    {
      type: "message",
      role: "assistant",
      content: "sub work",
      turnKey: "msg_sub",
      parentToolUseId: "t2",
    },
    {
      type: "tool_call",
      turnKey: "msg_sub",
      parentToolUseId: "t2",
      tool: { name: "file_read", originalName: "Read", id: "t3", args: { file_path: "a.ts" }, path: "a.ts" },
    },
    { type: "tool_result", parentToolUseId: "t2", tool: { name: "unknown", originalName: "t3", id: "t3", result: "code", success: true } },
    // Turn 2: a second API message.
    {
      type: "message",
      role: "assistant",
      content: "Done.",
      turnKey: "msg_2",
      messageId: "msg_2",
      usage: { inputTokens: 200, outputTokens: 20 },
    },
  ];
  const trace = assembleAgentTrace(events);

  it("groups one API message into one turn", () => {
    expect(trace.turns).toHaveLength(2);
    const [first, second] = trace.turns;
    expect(first!.text).toBe("Checking the tables.");
    expect(first!.thinking).toBe("let me look");
    expect(first!.toolCalls.map((t) => t.name)).toEqual(["Bash", "Task"]);
    expect(second!.text).toBe("Done.");
    expect(second!.toolCalls).toHaveLength(0);
  });

  it("carries per-turn usage and message ids", () => {
    expect(trace.turns[0]!.messageId).toBe("msg_1");
    expect(trace.turns[0]!.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
    expect(trace.turns[1]!.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
  });

  it("pairs tool results onto their executions", () => {
    const bash = trace.turns[0]!.toolCalls[0]!;
    expect(bash.output).toBe("files");
    expect(bash.success).toBe(true);
    expect(bash.command).toBe("ls");
  });

  it("nests the subagent sidechain under the Task call", () => {
    const task = trace.turns[0]!.toolCalls[1]!;
    expect(task.children).toHaveLength(1);
    const sub = task.children![0]!;
    expect(sub.text).toBe("sub work");
    expect(sub.toolCalls[0]!.name).toBe("Read");
    expect(sub.toolCalls[0]!.output).toBe("code");
    // Sidechain turns don't leak into the main thread.
    expect(trace.turns).toHaveLength(2);
  });
});

describe("assembleAgentTrace closure rule (Codex style, no turn keys)", () => {
  const events: TranscriptEvent[] = [
    { type: "thinking", content: "plan" },
    {
      type: "tool_call",
      tool: { name: "shell", originalName: "command_execution", id: "c1", args: { command: "psql" }, command: "psql" },
    },
    { type: "tool_result", tool: { name: "shell", originalName: "command_execution", id: "c1", result: "rows", success: true } },
    { type: "message", role: "assistant", content: "Found it." },
    {
      type: "tool_call",
      tool: { name: "shell", originalName: "command_execution", id: "c2", args: { command: "fix" }, command: "fix" },
    },
    { type: "message", role: "assistant", content: "Fixed." },
  ];
  const trace = assembleAgentTrace(events);

  it("closes a turn on each assistant message", () => {
    expect(trace.turns).toHaveLength(2);
    expect(trace.turns[0]!.thinking).toBe("plan");
    expect(trace.turns[0]!.text).toBe("Found it.");
    expect(trace.turns[0]!.toolCalls.map((t) => t.args.command)).toEqual(["psql"]);
    expect(trace.turns[1]!.text).toBe("Fixed.");
    expect(trace.turns[1]!.toolCalls.map((t) => t.args.command)).toEqual(["fix"]);
  });
});

describe("assembleAgentTrace edges", () => {
  it("records user/system messages as interjections", () => {
    const trace = assembleAgentTrace([
      { type: "message", role: "user", content: "skill body" },
      { type: "message", role: "assistant", content: "ok", turnKey: "m1" },
      { type: "message", role: "user", content: "tool feedback" },
    ]);
    expect(trace.turns).toHaveLength(1);
    expect(trace.interjections).toEqual([
      { afterTurnIndex: -1, role: "user", content: "skill body" },
      { afterTurnIndex: 0, role: "user", content: "tool feedback" },
    ]);
  });

  it("collects agent errors and flags orphaned sidechains", () => {
    const trace = assembleAgentTrace([
      { type: "error", content: "boom" },
      {
        type: "message",
        role: "assistant",
        content: "orphan",
        turnKey: "m1",
        parentToolUseId: "missing",
      },
    ]);
    expect(trace.turns).toHaveLength(0);
    expect(trace.errors[0]).toBe("boom");
    expect(trace.errors[1]).toContain("orphaned subagent transcript");
  });

  it("stores failed tool results as errors", () => {
    const trace = assembleAgentTrace([
      {
        type: "tool_call",
        tool: { name: "shell", originalName: "Bash", id: "x", args: {} },
      },
      {
        type: "tool_result",
        tool: { name: "unknown", originalName: "x", id: "x", result: "exit 1", success: false },
      },
      { type: "message", role: "assistant", content: "hm" },
    ]);
    const call = trace.turns[0]!.toolCalls[0]!;
    expect(call.error).toBe("exit 1");
    expect(call.output).toBeUndefined();
    expect(call.success).toBe(false);
  });
});
