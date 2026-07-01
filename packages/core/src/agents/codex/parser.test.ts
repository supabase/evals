import { describe, expect, it } from "vitest";
import { codexParser } from "./parser.js";
import { codexRunner } from "./runner.js";
import { adaptTranscript } from "../../parsers/adapt.js";

/** A representative `codex exec --json` stream (shapes captured from CLI 0.138). */
const SESSION = [
  JSON.stringify({ type: "thread.started", thread_id: "t1" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text: "I'll run a command and write a file." },
  }),
  JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "command_execution",
      command: "/bin/zsh -lc 'echo hi'",
      aggregated_output: "hi\n",
      exit_code: 0,
      status: "completed",
    },
  }),
  JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "file_change",
      changes: [{ path: "/work/note.txt", kind: "add" }],
      status: "completed",
    },
  }),
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_3", type: "agent_message", text: "Done." },
  }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } }),
].join("\n");

describe("codexParser", () => {
  it("maps command_execution + file_change to canonical tool calls, paired with results", () => {
    const { events, errors } = codexParser.parseTranscript(SESSION);
    expect(errors).toEqual([]);

    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls.map((e) => e.tool?.name)).toEqual(["shell", "file_write"]);
    expect(calls.map((e) => e.tool?.originalName)).toEqual(["command_execution", "file_change"]);
    // Normalized views live on the event's tool; raw args are left untouched.
    expect(calls[0].tool?.command).toBe("/bin/zsh -lc 'echo hi'");
    expect(calls[0].tool?.args).toEqual({ command: "/bin/zsh -lc 'echo hi'" });
    expect(calls[1].tool?.path).toBe("/work/note.txt");
    expect(calls[1].tool?.args).toEqual({ changes: [{ path: "/work/note.txt", kind: "add" }] });

    const results = events.filter((e) => e.type === "tool_result");
    expect(results.map((e) => e.tool?.id)).toEqual(["item_1", "item_2"]);
    expect(results.every((e) => e.tool?.success === true)).toBe(true);
  });

  it("ignores thread/turn envelopes and surfaces a clean transcript via the adapter", () => {
    const adapted = adaptTranscript(codexParser.parseTranscript(SESSION).events);
    expect(adapted.agentReport).toBe("Done.");
    expect(adapted.steps).toBe(2); // two agent_message turns
    expect(adapted.toolCalls).toEqual([
      {
        endpoint: "command_execution",
        body: { command: "/bin/zsh -lc 'echo hi'" },
        command: "/bin/zsh -lc 'echo hi'",
        result: "hi\n",
        error: undefined,
        ts: 0,
      },
      {
        endpoint: "file_change",
        body: { changes: [{ path: "/work/note.txt", kind: "add" }] },
        path: "/work/note.txt",
        result: "completed",
        error: undefined,
        ts: 0,
      },
    ]);
  });

  it("maps reasoning to a thinking event", () => {
    const { events } = codexParser.parseTranscript(
      JSON.stringify({
        type: "item.completed",
        item: { id: "r0", type: "reasoning", text: "Thinking about it." },
      }),
    );
    expect(events).toEqual([{ type: "thinking", content: "Thinking about it." }]);
  });

  it("normalizes shell reads of SKILL.md as loaded skills", () => {
    const stream = JSON.stringify({
      type: "item.completed",
      item: {
        id: "skill_1",
        type: "command_execution",
        command:
          "/bin/zsh -lc \"sed -n '1,220p' .agents/skills/supabase/SKILL.md\"",
        aggregated_output: "# Supabase",
        exit_code: 0,
        status: "completed",
      },
    });

    const adapted = adaptTranscript(codexParser.parseTranscript(stream).events);
    expect(adapted.toolCalls[0].loadedSkill).toBe("supabase");
  });

  it("marks a non-zero exit code as a failed shell call (error surfaced via adapter)", () => {
    const stream = [
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "c1",
          type: "command_execution",
          command: "false",
          aggregated_output: "nope",
          exit_code: 1,
          status: "completed",
        },
      }),
    ].join("\n");

    const { events } = codexParser.parseTranscript(stream);
    const result = events.find((e) => e.type === "tool_result");
    expect(result?.tool?.success).toBe(false);
    // success:false routes the output into `error`, not `result`, in the adapter.
    const adapted = adaptTranscript(events);
    expect(adapted.toolCalls[0].error).toBe("nope");
    expect(adapted.toolCalls[0].result).toBeUndefined();
  });

  it("treats a tool item with no recognizable status as unknown, not success", () => {
    const stream = JSON.stringify({
      type: "item.completed",
      item: { id: "m1", type: "mcp_tool_call", tool: "search_docs", result: "ok" },
    });
    const result = codexParser
      .parseTranscript(stream)
      .events.find((e) => e.type === "tool_result");
    expect(result?.tool?.success).toBeUndefined();
    expect(result?.tool?.originalName).toBe("search_docs");
  });

  it("emits an error event for a failed turn", () => {
    const stream = [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "turn.failed", error: { message: "model overloaded" } }),
    ].join("\n");
    const { events } = codexParser.parseTranscript(stream);
    expect(events).toEqual([{ type: "error", content: "model overloaded" }]);
  });

  it("never throws on malformed lines and reports them as errors", () => {
    const { events, errors } = codexParser.parseTranscript(
      "not json\n" + JSON.stringify({ type: "turn.started" }),
    );
    expect(events).toEqual([]);
    expect(errors.length).toBe(1);
  });
});

describe("codexRunner.deriveStopReason", () => {
  const ok: Parameters<NonNullable<typeof codexRunner.deriveStopReason>>[1] = {
    ok: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
  };

  it("returns 'stop' on a completed turn even though the process also exits 0", () => {
    const raw = JSON.stringify({ type: "turn.completed", usage: {} });
    expect(codexRunner.deriveStopReason!(raw, ok)).toBe("stop");
  });

  it("returns 'error' on a failed turn despite a 0 exit code", () => {
    const raw = JSON.stringify({ type: "turn.failed", error: { message: "boom" } });
    // The exit code is 0 (Codex doesn't fail the process), so without this hook
    // the run would be mis-reported as a clean stop.
    expect(codexRunner.deriveStopReason!(raw, ok)).toBe("error");
  });

  it("falls back to the process heuristic when there's no terminal turn event", () => {
    const timedOut = { ok: false, exitCode: 124, stdout: "", stderr: "timed out" };
    expect(codexRunner.deriveStopReason!("", timedOut)).toBe("timeout");
  });
});
