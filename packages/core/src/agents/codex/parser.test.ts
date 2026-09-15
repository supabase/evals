import { describe, expect, it } from 'vitest';
import { codexParser } from './parser.js';
import { codexRunner } from './runner.js';
import { adaptTranscript } from '../../parsers/adapt.js';
import { evalResultToTraceSpans } from '../../trace-viewer.js';

/** A representative `codex exec --json` stream (shapes captured from CLI 0.138). */
const SESSION = [
  JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'agent_message',
      text: "I'll run a command and write a file.",
    },
  }),
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'command_execution',
      command: "/bin/zsh -lc 'echo hi'",
      aggregated_output: 'hi\n',
      exit_code: 0,
      status: 'completed',
    },
  }),
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_2',
      type: 'file_change',
      changes: [{ path: '/work/note.txt', kind: 'add' }],
      status: 'completed',
    },
  }),
  JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_3', type: 'agent_message', text: 'Done.' },
  }),
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 10, output_tokens: 3 },
  }),
].join('\n');

describe('codexParser', () => {
  it('stamps events from ctx.rollout timestamps, paired by sequence', () => {
    // The --json stream has no timestamps; the rollout logged alongside it does.
    // response_item order mirrors the stream's completed items; outputs trail
    // their calls and give the tool_result its (later) completion time.
    const rollout = [
      JSON.stringify({
        timestamp: '2026-09-12T10:00:00.000Z',
        type: 'session_meta',
        payload: {},
      }),
      JSON.stringify({
        timestamp: '2026-09-12T10:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [] },
      }),
      JSON.stringify({
        timestamp: '2026-09-12T10:00:02.000Z',
        type: 'response_item',
        payload: { type: 'agent_message', content: [] },
      }),
      JSON.stringify({
        timestamp: '2026-09-12T10:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'c1',
          name: 'exec_command',
          input: '{}',
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-12T10:00:09.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'c1',
          output: 'hi',
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-12T10:00:10.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'c2',
          name: 'apply_patch',
          input: '{}',
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-12T10:00:12.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'c2',
          output: 'ok',
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-12T10:00:13.000Z',
        type: 'response_item',
        payload: { type: 'agent_message', content: [] },
      }),
    ].join('\n');

    const { events } = codexParser.parseTranscript(SESSION, { rollout });
    const byType = (t: string) => events.filter((e) => e.type === t);
    expect(byType('message').map((e) => e.timestamp)).toEqual([
      '2026-09-12T10:00:02.000Z',
      '2026-09-12T10:00:13.000Z',
    ]);
    const calls = byType('tool_call');
    expect(calls.map((e) => e.timestamp)).toEqual([
      '2026-09-12T10:00:03.000Z',
      '2026-09-12T10:00:10.000Z',
    ]);
    // The paired tool_result gets the output item's timestamp, so the span
    // shows the real 6s command duration rather than collapsing to zero.
    expect(byType('tool_result').map((e) => e.timestamp)).toEqual([
      '2026-09-12T10:00:09.000Z',
      '2026-09-12T10:00:12.000Z',
    ]);
    // Durations land in the trace adapter once stamped (real gaps, not 0ms).
    const adapted = adaptTranscript(events);
    const spans = evalResultToTraceSpans({
      evalId: 't',
      passed: true,
      transcript: adapted.transcript,
      toolCalls: adapted.toolCalls,
    });
    const durationSum = spans.spans.reduce((sum, s) => sum + s.duration, 0);
    expect(durationSum).toBeGreaterThan(0);
  });

  it('leaves later events untimed when the rollout runs dry mid-stream', () => {
    const rollout = JSON.stringify({
      timestamp: '2026-09-12T10:00:00.000Z',
      type: 'response_item',
      payload: { type: 'agent_message', content: [] },
    });
    const { events } = codexParser.parseTranscript(SESSION, { rollout });
    const messages = events.filter((e) => e.type === 'message');
    expect(messages[0]!.timestamp).toBe('2026-09-12T10:00:00.000Z');
    expect(messages[1]!.timestamp).toBeUndefined();
    // Tool calls have no stamp left to match — untimed, never fabricated.
    expect(
      events
        .filter((e) => e.type === 'tool_call')
        .every((e) => e.timestamp === undefined)
    ).toBe(true);
  });

  it('attaches per-model-call usage from rollout token_count events', () => {
    // `turn.completed` fires once per exec run; per-response usage lives in
    // the rollout's `token_count` events, each closing the response whose
    // items precede it. Attaching per-response usage is what lets the trace
    // viewer attribute context growth to the tool spans between calls.
    const rollout = [
      JSON.stringify({
        timestamp: '2026-09-12T10:00:02.000Z',
        type: 'response_item',
        payload: { type: 'agent_message', content: [] },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 1000, output_tokens: 20 },
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-12T10:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'c1',
          name: 'exec_command',
          input: '{}',
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-12T10:00:09.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'c1',
          output: 'hi',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 1500, output_tokens: 10 },
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-12T10:00:10.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'c2',
          name: 'apply_patch',
          input: '{}',
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-12T10:00:12.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'c2',
          output: 'ok',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 1800, output_tokens: 8 } },
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-12T10:00:13.000Z',
        type: 'response_item',
        payload: { type: 'agent_message', content: [] },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 2500,
              output_tokens: 5,
              cached_input_tokens: 2400,
            },
          },
        },
      }),
    ].join('\n');

    const { events } = codexParser.parseTranscript(SESSION, { rollout });
    const messages = events.filter((e) => e.type === 'message');
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(messages[0]!.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 20,
      totalTokens: 1020,
    });
    expect(messages[1]!.usage).toEqual({
      // The rollout's last count overwrites the stream's whole-run
      // turn.completed usage on the same (final) event.
      inputTokens: 2500,
      outputTokens: 5,
      cacheReadTokens: 2400,
      totalTokens: 2505,
    });
    expect(calls[0]!.usage).toEqual({
      inputTokens: 1500,
      outputTokens: 10,
      totalTokens: 1510,
    });
    expect(calls[1]!.usage).toEqual({
      inputTokens: 1800,
      outputTokens: 8,
      totalTokens: 1808,
    });

    // The viewer then reads consecutive calls' inputTokens as context size:
    // each gap's growth (minus that call's own generation) lands on the tool
    // span the previous response left open.
    const adapted = adaptTranscript(events);
    const spans = evalResultToTraceSpans({
      evalId: 't',
      passed: true,
      transcript: adapted.transcript,
      toolCalls: adapted.toolCalls,
    });
    const children = spans.spans[0]!.children!;
    expect(children[0]!.tokensCount).toBe(1020);
    expect(children[1]!.type).toBe('tool_execution');
    expect(children[1]!.tokensCount).toBe(290); // 1500−1000 minus msg1's own 20
    expect(children[2]!.tokensCount).toBe(692); // 2500−1800 minus call c2's own 8
    expect(children[3]!.tokensCount).toBe(2505);
  });

  it('maps command_execution + file_change to canonical tool calls, paired with results', () => {
    const { events, errors } = codexParser.parseTranscript(SESSION);
    expect(errors).toEqual([]);

    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls.map((e) => e.tool?.name)).toEqual(['shell', 'file_write']);
    expect(calls.map((e) => e.tool?.originalName)).toEqual([
      'command_execution',
      'file_change',
    ]);
    // Normalized views live on the event's tool; raw args are left untouched.
    expect(calls[0].tool?.command).toBe("/bin/zsh -lc 'echo hi'");
    expect(calls[0].tool?.args).toEqual({ command: "/bin/zsh -lc 'echo hi'" });
    expect(calls[1].tool?.path).toBe('/work/note.txt');
    expect(calls[1].tool?.args).toEqual({
      changes: [{ path: '/work/note.txt', kind: 'add' }],
    });

    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.map((e) => e.tool?.id)).toEqual(['item_1', 'item_2']);
    expect(results.every((e) => e.tool?.success === true)).toBe(true);
  });

  it('ignores thread/turn envelopes and surfaces a clean transcript via the adapter', () => {
    const adapted = adaptTranscript(
      codexParser.parseTranscript(SESSION).events
    );
    expect(adapted.agentReport).toBe('Done.');
    expect(adapted.steps).toBe(2); // two agent_message turns
    expect(adapted.toolCalls).toEqual([
      {
        tool: { kind: 'other', toolName: 'command_execution' },
        body: { command: "/bin/zsh -lc 'echo hi'" },
        name: 'shell',
        command: "/bin/zsh -lc 'echo hi'",
        result: 'hi\n',
        error: undefined,
        ts: 0,
      },
      {
        tool: { kind: 'other', toolName: 'file_change' },
        body: { changes: [{ path: '/work/note.txt', kind: 'add' }] },
        name: 'file_write',
        path: '/work/note.txt',
        result: 'completed',
        error: undefined,
        ts: 0,
      },
    ]);
  });

  it('maps reasoning to a thinking event', () => {
    const { events } = codexParser.parseTranscript(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'r0', type: 'reasoning', text: 'Thinking about it.' },
      })
    );
    expect(events).toEqual([
      { type: 'thinking', content: 'Thinking about it.' },
    ]);
  });

  it('normalizes shell reads of SKILL.md as loaded skills', () => {
    const stream = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'skill_1',
        type: 'command_execution',
        command:
          '/bin/zsh -lc "sed -n \'1,220p\' .agents/skills/supabase/SKILL.md"',
        aggregated_output: '# Supabase',
        exit_code: 0,
        status: 'completed',
      },
    });

    const adapted = adaptTranscript(codexParser.parseTranscript(stream).events);
    expect(adapted.toolCalls[0].loadedSkills).toEqual(['supabase']);
  });

  it('marks a non-zero exit code as a failed shell call (error surfaced via adapter)', () => {
    const stream = [
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'c1',
          type: 'command_execution',
          command: 'false',
          aggregated_output: 'nope',
          exit_code: 1,
          status: 'completed',
        },
      }),
    ].join('\n');

    const { events } = codexParser.parseTranscript(stream);
    const result = events.find((e) => e.type === 'tool_result');
    expect(result?.tool?.success).toBe(false);
    // success:false routes the output into `error`, not `result`, in the adapter.
    const adapted = adaptTranscript(events);
    expect(adapted.toolCalls[0].error).toBe('nope');
    expect(adapted.toolCalls[0].result).toBeUndefined();
  });

  it('treats a tool item with no recognizable status as unknown, not success', () => {
    const stream = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'm1',
        type: 'mcp_tool_call',
        tool: 'search_docs',
        result: 'ok',
      },
    });
    const result = codexParser
      .parseTranscript(stream)
      .events.find((e) => e.type === 'tool_result');
    expect(result?.tool?.success).toBeUndefined();
    expect(result?.tool?.originalName).toBe('search_docs');
  });

  it('attributes an mcp_tool_call to its server', () => {
    const withServer = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'm1',
        type: 'mcp_tool_call',
        server: 'supabase-mcp',
        tool: 'query_logs',
        result: 'ok',
      },
    });
    const explicit = codexParser
      .parseTranscript(withServer)
      .events.find((e) => e.type === 'tool_call');
    expect(explicit?.tool?.call).toEqual({
      kind: 'mcp',
      server: 'supabase-mcp',
      toolName: 'query_logs',
    });

    // No server field: falls back to `kind: 'other'` rather than guessing.
    const noServer = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'm2',
        type: 'mcp_tool_call',
        tool: 'query_logs',
        result: 'ok',
      },
    });
    const fallback = codexParser
      .parseTranscript(noServer)
      .events.find((e) => e.type === 'tool_call');
    expect(fallback?.tool?.call).toEqual({
      kind: 'other',
      toolName: 'query_logs',
    });
  });

  it("keeps a web_search item's action, which says what the hosted tool did", () => {
    const url = 'https://supabase.com/changelog.md';
    const stream = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'ws_0',
        type: 'web_search',
        query: url,
        action: { type: 'open_page', url },
        status: 'completed',
      },
    });

    const adapted = adaptTranscript(codexParser.parseTranscript(stream).events);
    expect(adapted.toolCalls[0].name).toBe('web_search');
    expect(adapted.toolCalls[0].body).toEqual({
      query: url,
      action: { type: 'open_page', url },
    });
  });

  it('attaches turn.completed.usage to the last assistant message of that turn', () => {
    const stream = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'm1', type: 'agent_message', text: 'First reply.' },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 120, output_tokens: 15 },
      }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'm2', type: 'agent_message', text: 'Second reply.' },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 200,
          output_tokens: 30,
          cached_input_tokens: 80,
        },
      }),
    ].join('\n');

    const { events } = codexParser.parseTranscript(stream);
    const messages = events.filter((e) => e.type === 'message');
    expect(messages).toHaveLength(2);
    expect(messages[0].usage).toEqual({
      inputTokens: 120,
      outputTokens: 15,
      cacheReadTokens: undefined,
      totalTokens: 135,
    });
    expect(messages[1].usage).toEqual({
      inputTokens: 200,
      outputTokens: 30,
      cacheReadTokens: 80,
      totalTokens: 230,
    });
  });

  it('attaches turn.completed.usage to a tool call when the turn produced no text', () => {
    // Loading a skill is exactly this shape: a turn that's a single tool call
    // with no assistant text before turn.completed.
    const stream = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'skill_1',
          type: 'command_execution',
          command: 'cat .agents/skills/supabase/SKILL.md',
          aggregated_output: '# Supabase',
          exit_code: 0,
          status: 'completed',
        },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1000, output_tokens: 5 },
      }),
    ].join('\n');

    const { events } = codexParser.parseTranscript(stream);
    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall?.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 5,
      cacheReadTokens: undefined,
      totalTokens: 1005,
    });
  });

  it('emits an error event for a failed turn', () => {
    const stream = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'turn.failed',
        error: { message: 'model overloaded' },
      }),
    ].join('\n');
    const { events } = codexParser.parseTranscript(stream);
    expect(events).toEqual([{ type: 'error', content: 'model overloaded' }]);
  });

  it('never throws on malformed lines and reports them as errors', () => {
    const { events, errors } = codexParser.parseTranscript(
      'not json\n' + JSON.stringify({ type: 'turn.started' })
    );
    expect(events).toEqual([]);
    expect(errors.length).toBe(1);
  });
});

describe('codexRunner.deriveStopReason', () => {
  const ok: Parameters<NonNullable<typeof codexRunner.deriveStopReason>>[1] = {
    ok: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
  };

  it("returns 'stop' on a completed turn even though the process also exits 0", () => {
    const raw = JSON.stringify({ type: 'turn.completed', usage: {} });
    expect(codexRunner.deriveStopReason!(raw, ok)).toBe('stop');
  });

  it("returns 'error' on a failed turn despite a 0 exit code", () => {
    const raw = JSON.stringify({
      type: 'turn.failed',
      error: { message: 'boom' },
    });
    // The exit code is 0 (Codex doesn't fail the process), so without this hook
    // the run would be mis-reported as a clean stop.
    expect(codexRunner.deriveStopReason!(raw, ok)).toBe('error');
  });

  it("falls back to the process heuristic when there's no terminal turn event", () => {
    const timedOut = {
      ok: false,
      exitCode: 124,
      stdout: '',
      stderr: 'timed out',
    };
    expect(codexRunner.deriveStopReason!('', timedOut)).toBe('timeout');
  });
});
