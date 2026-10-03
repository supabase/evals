import { describe, expect, it } from 'vitest';
import { claudeCodeParser } from './parser.js';
import { adaptTranscript } from '../../parsers/adapt.js';

/** A representative Claude Code `--print` JSONL session. */
const SESSION = [
  // init line carries no text — must not produce an event
  JSON.stringify({ type: 'system', subtype: 'init', cwd: '/tmp/sandbox-ab12' }),
  // assistant text + a Bash tool_use
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-18T10:00:00.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me list the files.' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Bash',
          input: { command: 'ls -la' },
        },
      ],
    },
  }),
  // tool_result for the Bash call
  JSON.stringify({
    type: 'user',
    timestamp: '2026-06-18T10:00:01.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: 'file1\nfile2',
          is_error: false,
        },
      ],
    },
  }),
  // assistant MCP tool_use
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_2',
          name: 'mcp__supabase__search_docs',
          input: { query: 'rls' },
        },
      ],
    },
  }),
  // failing tool_result for the MCP call
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          content: 'boom',
          is_error: true,
        },
      ],
    },
  }),
  // terminal result line — the final report
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'Done. Listed files and searched docs.',
  }),
].join('\n');

describe('claudeCodeParser', () => {
  it('normalizes tool names while preserving the original, and pairs results by id', () => {
    const { events, errors } = claudeCodeParser.parseTranscript(SESSION);
    expect(errors).toEqual([]);

    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls.map((e) => e.tool?.name)).toEqual(['shell', 'tool_use']);
    // originalName stays raw as the agent emitted it.
    expect(toolCalls.map((e) => e.tool?.originalName)).toEqual([
      'Bash',
      'mcp__supabase__search_docs',
    ]);
    // `call` carries the agent-agnostic identity: MCP tools are split into
    // server + bare toolName; built-ins are `other`.
    expect(toolCalls.map((e) => e.tool?.call)).toEqual([
      { kind: 'other', toolName: 'Bash' },
      { kind: 'mcp', server: 'supabase', toolName: 'search_docs' },
    ]);
    // the parser normalizes the shell command onto the event (args left raw)
    expect(toolCalls[0].tool?.command).toBe('ls -la');
    expect(toolCalls[0].tool?.args).toEqual({ command: 'ls -la' });

    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.map((e) => e.tool?.id)).toEqual(['toolu_1', 'toolu_2']);
    expect(results[0].tool?.success).toBe(true);
    expect(results[1].tool?.success).toBe(false);
  });

  it('does not double-emit the final message when the result line repeats it', () => {
    // The common real case: stream-json carries the final assistant turn AND a
    // terminal `result` line with the same text. They must collapse to one.
    const finalText = 'All done — migrations applied.';
    const transcript = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: finalText }],
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: finalText }),
    ].join('\n');

    const { events, errors } = claudeCodeParser.parseTranscript(transcript);
    expect(errors).toEqual([]);
    const assistantMessages = events.filter(
      (e) => e.type === 'message' && e.role === 'assistant'
    );
    expect(assistantMessages.map((e) => e.content)).toEqual([finalText]);
  });

  it('normalizes Claude Code Skill tool calls as loaded skills', () => {
    const transcript = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_skill',
            name: 'Skill',
            input: { skill: 'supabase-postgres-best-practices' },
          },
        ],
      },
    });

    const adapted = adaptTranscript(
      claudeCodeParser.parseTranscript(transcript).events
    );
    expect(adapted.toolCalls[0].loadedSkills).toEqual([
      'supabase-postgres-best-practices',
    ]);
  });

  it('normalizes current and legacy subagent tool names', () => {
    const transcript = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_agent',
            name: 'Agent',
            input: { description: 'Inspect the parser' },
          },
          {
            type: 'tool_use',
            id: 'toolu_task',
            name: 'Task',
            input: { description: 'Inspect the runner' },
          },
        ],
      },
    });

    const { events, errors } = claudeCodeParser.parseTranscript(transcript);
    expect(errors).toEqual([]);

    const toolCalls = events.filter((event) => event.type === 'tool_call');
    expect(toolCalls.map((event) => event.tool?.name)).toEqual([
      'agent_task',
      'agent_task',
    ]);
    expect(toolCalls.map((event) => event.tool?.originalName)).toEqual([
      'Agent',
      'Task',
    ]);
  });

  it('still emits the result text when it was never streamed as a message', () => {
    // Plain `--print` (no stream-json) yields only the terminal result line.
    const transcript = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Only the result line.',
    });
    const { events } = claudeCodeParser.parseTranscript(transcript);
    const assistantMessages = events.filter(
      (e) => e.type === 'message' && e.role === 'assistant'
    );
    expect(assistantMessages.map((e) => e.content)).toEqual([
      'Only the result line.',
    ]);
  });

  it('skips lines with no content and never throws on malformed lines', () => {
    const { events, errors } = claudeCodeParser.parseTranscript(
      'not json\n' + JSON.stringify({ type: 'system', subtype: 'init' })
    );
    expect(events).toEqual([]);
    expect(errors.length).toBe(1);
  });
});

describe('adaptTranscript', () => {
  const { events } = claudeCodeParser.parseTranscript(SESSION);
  const adapted = adaptTranscript(events);

  it('derives the final report and assistant-turn count', () => {
    expect(adapted.agentReport).toBe('Done. Listed files and searched docs.');
    // two assistant messages: the opening text and the closing result line
    expect(adapted.steps).toBe(2);
  });

  it('builds tool calls keyed by the original tool name, with results paired in', () => {
    expect(adapted.toolCalls).toEqual([
      {
        tool: { kind: 'other', toolName: 'Bash' },
        body: { command: 'ls -la' },
        name: 'shell',
        command: 'ls -la',
        result: 'file1\nfile2',
        error: undefined,
        ts: Date.parse('2026-06-18T10:00:00.000Z'),
      },
      {
        tool: { kind: 'mcp', server: 'supabase', toolName: 'search_docs' },
        body: { query: 'rls' },
        name: 'tool_use',
        result: undefined,
        error: 'boom',
        ts: 0,
      },
    ]);
  });

  it('renders a scorer-facing transcript (messages + tool calls, raw args preserved)', () => {
    expect(adapted.transcript).toEqual([
      { type: 'message', role: 'assistant', content: 'Let me list the files.' },
      {
        type: 'tool_call',
        name: 'Bash',
        input: { command: 'ls -la' },
        output: 'file1\nfile2',
        error: undefined,
      },
      {
        type: 'tool_call',
        name: 'search_docs',
        input: { query: 'rls' },
        output: undefined,
        error: 'boom',
      },
      {
        type: 'message',
        role: 'assistant',
        content: 'Done. Listed files and searched docs.',
      },
    ]);
  });
});
