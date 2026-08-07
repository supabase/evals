import { describe, expect, it } from 'vitest';
import { claudeCodeParser } from './parser.js';
import { adaptTranscript } from '../../parsers/adapt.js';
import { serializeTranscript } from '../../index.js';

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

/**
 * A session with `--forward-subagent-text`: subagent lines are ordinary
 * assistant/user lines whose top-level `parent_tool_use_id` names the
 * spawning Agent tool_use, with `subagent_type` / `task_description`
 * alongside (captured from Claude Code 2.1.220).
 */
const SUBAGENT_SESSION = [
  // main thread spawns the subagent (Task's 2.1.2xx name is `Agent`)
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_spawn',
          name: 'Agent',
          input: {
            description: 'Check primality',
            subagent_type: 'general-purpose',
            prompt: 'Which of 91, 97, 100 are prime?',
          },
        },
      ],
    },
  }),
  // the subagent's kickoff prompt, echoed as a forwarded user line
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Which of 91, 97, 100 are prime?' }],
    },
    parent_tool_use_id: 'toolu_spawn',
    subagent_type: 'general-purpose',
    task_description: 'Check primality',
  }),
  // the subagent thinking (summarized) then replying
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '97 is prime; 91 and 100 are not.' },
      ],
    },
    parent_tool_use_id: 'toolu_spawn',
    subagent_type: 'general-purpose',
    task_description: 'Check primality',
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '[97]' }],
    },
    parent_tool_use_id: 'toolu_spawn',
    subagent_type: 'general-purpose',
    task_description: 'Check primality',
  }),
  // the Agent tool_result closing the spawn, back on the main thread
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_spawn', content: '[97]' },
      ],
    },
    parent_tool_use_id: null,
  }),
  // main thread wraps up; the result line repeats it and must dedup
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'The subagent says only 97 is prime.' }],
    },
    parent_tool_use_id: null,
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'The subagent says only 97 is prime.',
  }),
].join('\n');

describe('claudeCodeParser', () => {
  it('normalizes tool names while preserving the original, and pairs results by id', () => {
    const { events, errors } = claudeCodeParser.parseTranscript(SESSION);
    expect(errors).toEqual([]);

    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls.map((e) => e.tool?.name)).toEqual(['shell', 'tool_use']);
    expect(toolCalls.map((e) => e.tool?.originalName)).toEqual([
      'Bash',
      'mcp__supabase__search_docs',
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

  it('tags forwarded subagent lines with the agnostic subagent ref', () => {
    const { events, errors } =
      claudeCodeParser.parseTranscript(SUBAGENT_SESSION);
    expect(errors).toEqual([]);

    // The Agent spawn (Task's 2.1.2xx name) normalizes to agent_task.
    const spawn = events.find((e) => e.type === 'tool_call');
    expect(spawn?.tool?.name).toBe('agent_task');
    expect(spawn?.tool?.originalName).toBe('Agent');
    expect(spawn?.subagent).toBeUndefined();

    const tagged = events.filter((e) => e.subagent);
    expect(tagged.map((e) => e.type)).toEqual([
      'message', // the subagent's kickoff prompt
      'thinking',
      'message', // the subagent's reply
    ]);
    for (const e of tagged) {
      expect(e.subagent).toEqual({
        id: 'toolu_spawn',
        type: 'general-purpose',
        description: 'Check primality',
      });
    }
    expect(tagged[1].content).toBe('97 is prime; 91 and 100 are not.');
  });

  it('dedups the result line against the main thread even when a subagent spoke last', () => {
    // A subagent reply must not register as "the last assistant message" —
    // otherwise a result line repeating the main thread's final text would be
    // emitted twice (or a subagent echo would swallow it).
    const { events } = claudeCodeParser.parseTranscript(SUBAGENT_SESSION);
    const mainAssistant = events.filter(
      (e) => e.type === 'message' && e.role === 'assistant' && !e.subagent
    );
    expect(mainAssistant.map((e) => e.content)).toEqual([
      'The subagent says only 97 is prime.',
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
        endpoint: 'Bash',
        body: { command: 'ls -la' },
        name: 'shell',
        command: 'ls -la',
        result: 'file1\nfile2',
        error: undefined,
        ts: Date.parse('2026-06-18T10:00:00.000Z'),
      },
      {
        endpoint: 'mcp__supabase__search_docs',
        body: { query: 'rls' },
        name: 'tool_use',
        result: undefined,
        error: 'boom',
        ts: 0,
      },
    ]);
  });

  describe('with forwarded subagent lines', () => {
    const subagentAdapted = adaptTranscript(
      claudeCodeParser.parseTranscript(SUBAGENT_SESSION).events
    );

    it('keeps the report, steps, and tool-call records on the main thread', () => {
      expect(subagentAdapted.agentReport).toBe(
        'The subagent says only 97 is prime.'
      );
      expect(subagentAdapted.steps).toBe(1);
      // Only the main thread's Agent spawn — no subagent-attributed records.
      expect(subagentAdapted.toolCalls.map((c) => c.endpoint)).toEqual([
        'Agent',
      ]);
    });

    it('captures subagent messages and thinking as tagged transcript parts', () => {
      const tagged = subagentAdapted.transcript.filter(
        (p) => 'subagent' in p && p.subagent
      );
      expect(tagged.map((p) => p.type)).toEqual([
        'message',
        'thinking',
        'message',
      ]);
      expect(tagged.find((p) => p.type === 'thinking')?.content).toBe(
        '97 is prime; 91 and 100 are not.'
      );
    });

    it('serializes identically to a subagent-free transcript by default', () => {
      const serialized = serializeTranscript(subagentAdapted.transcript);
      expect(serialized).not.toContain('97 is prime; 91 and 100 are not.');
      expect(serialized).not.toContain('[97]');
      expect(serialized).toContain(
        '[assistant]\nThe subagent says only 97 is prime.'
      );
    });

    it('serializes subagent parts and thinking on request, labeled', () => {
      const serialized = serializeTranscript(subagentAdapted.transcript, {
        includeSubagents: true,
        includeThinking: true,
      });
      expect(serialized).toContain(
        '[subagent:general-purpose thinking]\n97 is prime; 91 and 100 are not.'
      );
      expect(serialized).toContain(
        '[subagent:general-purpose assistant]\n[97]'
      );
    });
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
        name: 'mcp__supabase__search_docs',
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
