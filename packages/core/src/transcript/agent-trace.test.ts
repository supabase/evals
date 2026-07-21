import { describe, expect, it } from "vitest";
import { assembleAgentTrace } from "./agent-trace.js";
import type { TranscriptEvent } from "./types.js";

describe("assembleAgentTrace with turn keys (Claude Code style)", () => {
  const events: TranscriptEvent[] = [
    // Step 1: one assistant API message with thinking + text + two tool uses.
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
    // Step 2: a second API message.
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

  it("keeps one autonomous run as a single turn with one step per API message", () => {
    expect(trace.turns).toHaveLength(1);
    const steps = trace.turns[0]!.steps;
    expect(steps).toHaveLength(2);
    expect(steps[0]!.text).toBe("Checking the tables.");
    expect(steps[0]!.thinking).toBe("let me look");
    expect(steps[0]!.toolCalls.map((t) => t.name)).toEqual(["Bash", "Task"]);
    expect(steps[1]!.text).toBe("Done.");
    expect(steps[1]!.toolCalls).toHaveLength(0);
  });

  it("carries per-step usage and message ids", () => {
    const steps = trace.turns[0]!.steps;
    expect(steps[0]!.messageId).toBe("msg_1");
    expect(steps[0]!.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
    expect(steps[1]!.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
  });

  it("pairs tool results onto their executions", () => {
    const bash = trace.turns[0]!.steps[0]!.toolCalls[0]!;
    expect(bash.output).toBe("files");
    expect(bash.success).toBe(true);
    expect(bash.command).toBe("ls");
  });

  it("nests the subagent sidechain under the Task call", () => {
    const task = trace.turns[0]!.steps[0]!.toolCalls[1]!;
    expect(task.children).toHaveLength(1);
    const sub = task.children![0]!;
    expect(sub.text).toBe("sub work");
    expect(sub.toolCalls[0]!.name).toBe("Read");
    expect(sub.toolCalls[0]!.output).toBe("code");
    // Sidechain steps don't leak into the main thread.
    expect(trace.turns[0]!.steps).toHaveLength(2);
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

  it("closes a step on each assistant message, all within one turn", () => {
    expect(trace.turns).toHaveLength(1);
    const steps = trace.turns[0]!.steps;
    expect(steps).toHaveLength(2);
    expect(steps[0]!.thinking).toBe("plan");
    expect(steps[0]!.text).toBe("Found it.");
    expect(steps[0]!.toolCalls.map((t) => t.args.command)).toEqual(["psql"]);
    expect(steps[1]!.text).toBe("Fixed.");
    expect(steps[1]!.toolCalls.map((t) => t.args.command)).toEqual(["fix"]);
  });
});

describe("assembleAgentTrace turn boundaries and edges", () => {
  it("opens a new turn on a mid-run user message", () => {
    const trace = assembleAgentTrace([
      { type: "message", role: "assistant", content: "first", turnKey: "m1" },
      { type: "message", role: "user", content: "extra instruction" },
      { type: "message", role: "assistant", content: "second", turnKey: "m2" },
    ]);
    expect(trace.turns).toHaveLength(2);
    expect(trace.turns[0]!.userMessage).toBeUndefined();
    expect(trace.turns[0]!.steps.map((s) => s.text)).toEqual(["first"]);
    expect(trace.turns[1]!.userMessage).toBe("extra instruction");
    expect(trace.turns[1]!.steps.map((s) => s.text)).toEqual(["second"]);
  });

  it("folds a leading user message into the first turn", () => {
    const trace = assembleAgentTrace([
      { type: "message", role: "user", content: "skill body" },
      { type: "message", role: "assistant", content: "ok", turnKey: "m1" },
    ]);
    expect(trace.turns).toHaveLength(1);
    expect(trace.turns[0]!.userMessage).toBe("skill body");
    expect(trace.turns[0]!.steps.map((s) => s.text)).toEqual(["ok"]);
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
    const call = trace.turns[0]!.steps[0]!.toolCalls[0]!;
    expect(call.error).toBe("exit 1");
    expect(call.output).toBeUndefined();
    expect(call.success).toBe(false);
  });
});
