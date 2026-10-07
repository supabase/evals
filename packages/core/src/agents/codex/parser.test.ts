import { describe, expect, it } from 'vitest';
import { codexParser, enrichFromRollout } from './parser.js';
import { codexRunner } from './runner.js';
import { adaptTranscript } from '../../parsers/adapt.js';
import type { TranscriptEvent } from '../../transcript/types.js';

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

  it("gives an mcp_tool_call's arguments as its input, keeping the result off it", () => {
    // Shape from a real CLI run: the result can be far larger than the call.
    const args = { project_id: 'p1', query: 'select 1' };
    const toolResult = {
      content: [{ type: 'text', text: '[{"?column?":1}]' }],
      structured_content: null,
    };
    const stream = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_7',
        type: 'mcp_tool_call',
        server: 'supabase-mcp',
        tool: 'execute_sql',
        arguments: args,
        result: toolResult,
        error: null,
        status: 'completed',
      },
    });

    const adapted = adaptTranscript(codexParser.parseTranscript(stream).events);
    expect(adapted.transcript[0]).toEqual({
      type: 'tool_call',
      name: 'execute_sql',
      id: 'item_7',
      input: args,
      output: toolResult,
      error: undefined,
    });
    expect(adapted.toolCalls[0].body).toEqual(args);
    expect(adapted.toolCalls[0].result).toEqual(toolResult);
  });

  it('gives an mcp_tool_call with no argument object an empty input', () => {
    const stream = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_8',
        type: 'mcp_tool_call',
        server: 'supabase-mcp',
        tool: 'list_tables',
        arguments: null,
        result: { content: [] },
        status: 'completed',
      },
    });
    const adapted = adaptTranscript(codexParser.parseTranscript(stream).events);
    expect(adapted.toolCalls[0].body).toEqual({});
  });

  it.each([
    {
      failure: 'an error the MCP tool returned',
      result: { content: [{ type: 'text', text: 'column does not exist' }] },
      error: null,
    },
    {
      failure: 'an error Codex raised with no tool result',
      result: null,
      error: { message: 'column does not exist' },
    },
  ])(
    'surfaces $failure as the failed call error, not as input',
    ({ result, error }) => {
      const stream = JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_9',
          type: 'mcp_tool_call',
          server: 'supabase-mcp',
          tool: 'execute_sql',
          arguments: { query: 'select child_table' },
          result,
          error,
          status: 'failed',
        },
      });
      const adapted = adaptTranscript(
        codexParser.parseTranscript(stream).events
      );
      expect(adapted.toolCalls[0].body).toEqual({
        query: 'select child_table',
      });
      expect(adapted.toolCalls[0].result).toBeUndefined();
      expect(adapted.toolCalls[0].error).toContain('column does not exist');
    }
  );

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

describe('enrichFromRollout', () => {
  it('pairs stdout events with rollout records by position', () => {
    const line = (timestamp: string, type: string, payload: object) =>
      JSON.stringify({ timestamp, type, payload });
    const rollout = [
      line('t1', 'response_item', { type: 'message', role: 'assistant' }),
      line('t2', 'response_item', { type: 'function_call', call_id: 'c1' }),
      line('t3', 'token_usage_record', {
        response_id: 'r1',
        usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
      }),
      line('t4', 'event_msg', {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'c1',
          command: ['/bin/bash', '-lc', 'ls'],
        },
      }),
      line('t5', 'response_item', {
        type: 'function_call_output',
        call_id: 'c1',
      }),
    ].join('\n');
    const events: TranscriptEvent[] = [
      { type: 'message', role: 'assistant', content: 'hi' },
      {
        type: 'tool_call',
        tool: {
          name: 'shell',
          originalName: 'x',
          id: 'item_1',
          command: '/bin/bash -lc ls',
        },
      },
      {
        type: 'tool_result',
        tool: { name: 'shell', originalName: 'x', id: 'item_1' },
      },
    ];
    enrichFromRollout(events, rollout);
    const usage = {
      inputTokens: 10,
      cacheReadInputTokens: 4,
      cacheWriteInputTokens: 0,
      outputTokens: 2,
    };
    expect(events.map((e) => [e.timestamp, e.requestId, e.usage])).toEqual([
      ['t1', 'r1', usage],
      ['t2', 'r1', usage],
      ['t4', undefined, undefined],
    ]);
  });

  it("sets a paired tool call's cwd from the rollout item, resolving file:// URLs", () => {
    const item = (id: string, command: string, cwd?: string) =>
      JSON.stringify({
        timestamp: 't',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id,
            command: ['/bin/bash', '-lc', command],
            ...(cwd === undefined ? {} : { cwd }),
          },
        },
      });
    const call = (id: string, command: string): TranscriptEvent => ({
      type: 'tool_call',
      tool: {
        name: 'shell',
        originalName: 'command_execution',
        id,
        command: `/bin/bash -lc ${command}`,
      },
    });
    const events = [call('i1', 'a'), call('i2', 'b'), call('i3', 'c')];
    enrichFromRollout(
      events,
      [
        item('c1', 'a', '/work/client-a'),
        item('c2', 'b', 'file:///work/my%20app'),
        item('c3', 'c'),
      ].join('\n')
    );
    expect(events.map((e) => e.tool?.cwd)).toEqual([
      '/work/client-a',
      '/work/my app',
      undefined,
    ]);
  });

  it('adds an empty message for a request with no events', () => {
    const line = (timestamp: string, type: string, payload: object) =>
      JSON.stringify({ timestamp, type, payload });
    const usageRecord = (at: string, id: string) =>
      line(at, 'token_usage_record', { response_id: id, usage: {} });
    const rollout = [
      line('t1', 'response_item', { type: 'message', role: 'assistant' }),
      usageRecord('t2', 'r1'),
      // A compaction call, which leaves no response item.
      usageRecord('t3', 'r2'),
      line('t4', 'response_item', { type: 'message', role: 'assistant' }),
      usageRecord('t5', 'r3'),
    ].join('\n');
    const events: TranscriptEvent[] = [
      { type: 'message', role: 'assistant', content: 'a' },
      { type: 'message', role: 'assistant', content: 'b' },
    ];
    enrichFromRollout(events, rollout);
    expect(events.map((e) => [e.content, e.timestamp, e.requestId])).toEqual([
      ['a', 't1', 'r1'],
      ['', 't3', 'r2'],
      ['b', 't4', 'r3'],
    ]);
  });

  it('adds only itemless empty messages when messages do not pair', () => {
    const line = (timestamp: string, type: string, payload: object) =>
      JSON.stringify({ timestamp, type, payload });
    const usageRecord = (at: string, id: string) =>
      line(at, 'token_usage_record', { response_id: id, usage: {} });
    const rollout = [
      line('t1', 'response_item', { type: 'message', role: 'assistant' }),
      usageRecord('t2', 'r1'),
      usageRecord('t3', 'r2'),
      line('t4', 'response_item', { type: 'message', role: 'assistant' }),
      usageRecord('t5', 'r3'),
    ].join('\n');
    const events: TranscriptEvent[] = [
      { type: 'message', role: 'assistant', content: 'a' },
    ];
    enrichFromRollout(events, rollout);
    expect(events.map((e) => [e.content, e.timestamp, e.requestId])).toEqual([
      ['a', undefined, undefined],
      ['', 't3', 'r2'],
    ]);
  });

  it('returns the first user message time as the prompt time', () => {
    const line = (timestamp: string, role: string) =>
      JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: { type: 'message', role },
      });
    const rollout = [
      line('2026-10-01T17:43:08.454Z', 'developer'),
      line('2026-10-01T17:43:08.454Z', 'user'),
      line('2026-10-01T17:43:08.473Z', 'user'),
      line('2026-10-01T17:43:18.250Z', 'assistant'),
    ].join('\n');
    expect(enrichFromRollout([], rollout)).toBe(
      Date.parse('2026-10-01T17:43:08.454Z')
    );
  });
});

describe('enrichFromRollout tool pairing', () => {
  const line = (timestamp: string, type: string, payload: object) =>
    JSON.stringify({ timestamp, type, payload });
  const issued = (id: string, at: string) =>
    line(at, 'response_item', { type: 'function_call', call_id: id });
  const completed = (id: string, script: string) =>
    line('', 'event_msg', {
      type: 'item_completed',
      item: {
        type: 'CommandExecution',
        id,
        command: ['/bin/bash', '-lc', script],
      },
    });
  const finished = (id: string, at: string) =>
    line(at, 'response_item', { type: 'function_call_output', call_id: id });
  const call = (id: string, command: string): TranscriptEvent[] => [
    {
      type: 'tool_call',
      tool: { name: 'shell', originalName: 'x', id, command },
    },
    { type: 'tool_result', tool: { name: 'shell', originalName: 'x', id } },
  ];
  const times = (events: TranscriptEvent[], rollout: string[]) => {
    enrichFromRollout(events, rollout.join('\n'));
    return events.map((e) => e.timestamp);
  };

  it('matches shell-quoted commands to the argv', () => {
    expect(
      times(call('item_1', `/bin/bash -lc 'cat "a b.txt"'`), [
        issued('c1', 't1'),
        completed('c1', 'cat "a b.txt"'),
        finished('c1', 't2'),
      ])
    ).toEqual(['t1', 't2']);
  });

  it('takes a yielded command completion time from its item_completed', () => {
    const completedAt = (id: string, at: string) =>
      line(at, 'event_msg', {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id,
          command: ['/bin/bash', '-lc', 'sleep 90'],
        },
      });
    expect(
      times(call('item_1', '/bin/bash -lc "sleep 90"'), [
        issued('c1', 't1'),
        finished('c1', 't2'),
        issued('c2', 't3'),
        finished('c2', 't4'),
        completedAt('c1', 't5'),
      ])
    ).toEqual(['t1', 't5']);
  });

  it('falls back to the output time without an item_completed timestamp', () => {
    expect(
      times(call('item_1', '/bin/bash -lc "sleep 90"'), [
        issued('c1', 't1'),
        finished('c1', 't2'),
        issued('c2', 't3'),
        finished('c2', 't4'),
        completed('c1', 'sleep 90'),
      ])
    ).toEqual(['t1', 't2']);
  });

  it('leaves a command with extra arguments unpaired and pairs the rest', () => {
    expect(
      times(
        [
          ...call('item_1', '/bin/bash -lc pwd'),
          ...call('item_2', '/bin/bash -lc ls -la'),
          ...call('item_3', '/bin/bash -lc date'),
        ],
        [
          issued('c1', 't1'),
          completed('c1', 'pwd'),
          finished('c1', 't2'),
          issued('c2', 't3'),
          completed('c2', 'ls'),
          finished('c2', 't4'),
          issued('c3', 't5'),
          completed('c3', 'date'),
          finished('c3', 't6'),
        ]
      )
    ).toEqual(['t1', 't2', undefined, undefined, 't5', 't6']);
  });

  it('matches a redacted secret', () => {
    expect(
      times(
        call('item_1', `/bin/bash -lc 'login --password [REDACTED_SECRET]'`),
        [
          issued('c1', 't1'),
          completed('c1', 'login --password hunter2'),
          finished('c1', 't2'),
        ]
      )
    ).toEqual(['t1', 't2']);
  });

  it('rejects different text around a redacted secret', () => {
    expect(
      times(
        call('item_1', `/bin/bash -lc 'logout --password [REDACTED_SECRET]'`),
        [
          issued('c1', 't1'),
          completed('c1', 'login --password hunter2'),
          finished('c1', 't2'),
        ]
      )
    ).toEqual([undefined, undefined]);
  });

  it('pairs what it can when the rollout has fewer commands', () => {
    expect(
      times(
        [
          ...call('item_1', '/bin/bash -lc pwd'),
          ...call('item_2', '/bin/bash -lc ls'),
        ],
        [issued('c1', 't1'), completed('c1', 'pwd'), finished('c1', 't2')]
      )
    ).toEqual(['t1', 't2', undefined, undefined]);
  });

  it('skips a rollout command the stream never listed', () => {
    const events = [
      ...call('item_1', '/bin/bash -lc pwd'),
      ...call('item_2', '/bin/bash -lc ls'),
    ];
    const withCwd = (id: string, script: string, cwd: string) =>
      line('', 'event_msg', {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id,
          cwd,
          command: ['/bin/bash', '-lc', script],
        },
      });
    enrichFromRollout(
      events,
      [
        issued('c1', 't1'),
        withCwd('c1', 'pwd', '/a'),
        finished('c1', 't2'),
        issued('c2', 't3'),
        withCwd('c2', 'supabase functions serve', '/killed'),
        finished('c2', 't4'),
        issued('c3', 't5'),
        withCwd('c3', 'ls', '/b'),
        finished('c3', 't6'),
      ].join('\n')
    );
    expect(events.map((e) => [e.timestamp, e.tool?.cwd])).toEqual([
      ['t1', '/a'],
      ['t2', undefined],
      ['t5', '/b'],
      ['t6', undefined],
    ]);
  });

  it('never pairs out of order, even when a later item matches an earlier call', () => {
    expect(
      times(
        [
          ...call('item_1', '/bin/bash -lc ls'),
          ...call('item_2', '/bin/bash -lc pwd'),
        ],
        [
          issued('c1', 't1'),
          completed('c1', 'pwd'),
          finished('c1', 't2'),
          issued('c2', 't3'),
          completed('c2', 'ls'),
          finished('c2', 't4'),
        ]
      )
    ).toEqual(['t3', 't4', undefined, undefined]);
  });

  it('adds only itemless empty messages when a tool call does not pair', () => {
    const events = [
      ...call('item_1', '/bin/bash -lc pwd'),
      ...call('item_2', '/bin/bash -lc ls'),
    ];
    const usageRecord = (at: string, id: string) =>
      line(at, 'token_usage_record', { response_id: id, usage: {} });
    enrichFromRollout(
      events,
      [
        issued('c1', 't1'),
        completed('c1', 'pwd'),
        usageRecord('t2', 'r1'),
        finished('c1', 't3'),
        usageRecord('t4', 'r2'),
      ].join('\n')
    );
    expect(events.map((e) => [e.type, e.requestId])).toEqual([
      ['tool_call', 'r1'],
      ['tool_result', undefined],
      ['tool_call', undefined],
      ['tool_result', undefined],
      ['message', 'r2'],
    ]);
  });

  it('ignores non-tool rollout items', () => {
    expect(
      times(call('item_1', '/bin/bash -lc pwd'), [
        issued('c1', 't1'),
        line('', 'event_msg', {
          type: 'item_completed',
          item: { type: 'ContextCompaction', id: 'cc_1' },
        }),
        completed('c1', 'pwd'),
        finished('c1', 't2'),
      ])
    ).toEqual(['t1', 't2']);
  });

  it('pairs repeated commands in order', () => {
    const command = `/bin/bash -lc 'supabase status'`;
    expect(
      times(
        [...call('item_1', command), ...call('item_2', command)],
        [
          issued('c1', 't1'),
          completed('c1', 'supabase status'),
          finished('c1', 't2'),
          issued('c2', 't3'),
          completed('c2', 'supabase status'),
          finished('c2', 't4'),
        ]
      )
    ).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('pairs parallel calls in completion order', () => {
    // c1 starts first, but both streams list c2 first because it finished first.
    expect(
      times(
        [
          ...call('item_2', `/bin/bash -lc 'echo hi'`),
          ...call('item_1', `/bin/bash -lc 'sleep 2'`),
        ],
        [
          issued('c1', 't1'),
          issued('c2', 't2'),
          completed('c2', 'echo hi'),
          finished('c2', 't3'),
          completed('c1', 'sleep 2'),
          finished('c1', 't4'),
        ]
      )
    ).toEqual(['t2', 't3', 't1', 't4']);
  });
});
