import { describe, expect, it } from 'vitest';
import { opencodeParser } from './parser.js';
import { adaptTranscript } from '../../parsers/adapt.js';

/** A representative `opencode run --format json` stream (shapes from CLI 1.18.5). */
const SESSION = [
  JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
  JSON.stringify({
    type: 'reasoning',
    timestamp: 1782295624200,
    part: { type: 'reasoning', text: 'I should list the files.' },
  }),
  JSON.stringify({
    type: 'text',
    timestamp: 1782295624232,
    part: { type: 'text', text: 'Listing files.' },
  }),
  JSON.stringify({
    type: 'tool_use',
    timestamp: 1782295624290,
    part: {
      type: 'tool',
      tool: 'bash',
      callID: 'tool_1',
      state: {
        status: 'completed',
        input: { command: 'ls -la', description: 'List files' },
        output: 'file1\nfile2',
        metadata: { exit: 0 },
      },
    },
  }),
  JSON.stringify({
    type: 'tool_use',
    timestamp: 1782295624300,
    part: {
      type: 'tool',
      tool: 'write',
      callID: 'tool_2',
      state: {
        status: 'completed',
        input: { filePath: '/work/note.txt', content: 'hi' },
        output: 'written',
      },
    },
  }),
  JSON.stringify({
    type: 'text',
    timestamp: 1782295624400,
    part: { type: 'text', text: 'Done.' },
  }),
  JSON.stringify({
    type: 'step_finish',
    part: {
      type: 'step-finish',
      reason: 'stop',
      tokens: { input: 3, output: 6 },
    },
  }),
].join('\n');

describe('opencodeParser', () => {
  it("normalizes MCP tools (opencode's `<server>_<tool>` names) to tool_use", () => {
    const record = JSON.stringify({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'supabase-mcp_list_tables',
        callID: 'tool_mcp',
        state: { status: 'completed', input: { schemas: ['public'] } },
      },
    });
    const { events } = opencodeParser.parseTranscript(record);
    const call = events.find((e) => e.type === 'tool_call');
    expect(call?.tool?.name).toBe('tool_use');
    expect(call?.tool?.originalName).toBe('supabase-mcp_list_tables');
  });

  it('maps bash + write to canonical tool calls, paired with results by callID', () => {
    const { events, errors } = opencodeParser.parseTranscript(SESSION);
    expect(errors).toEqual([]);

    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls.map((e) => e.tool?.name)).toEqual(['shell', 'file_write']);
    expect(calls.map((e) => e.tool?.originalName)).toEqual(['bash', 'write']);
    expect(calls.map((e) => e.tool?.id)).toEqual(['tool_1', 'tool_2']);
    // Normalized views on the event; raw args untouched.
    expect(calls[0].tool?.command).toBe('ls -la');
    expect(calls[1].tool?.path).toBe('/work/note.txt');

    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.map((e) => e.tool?.id)).toEqual(['tool_1', 'tool_2']);
    expect(results.every((e) => e.tool?.success === true)).toBe(true);
  });

  it('surfaces reasoning + the assistant report via the adapter', () => {
    const events = opencodeParser.parseTranscript(SESSION).events;
    expect(
      events.some(
        (e) => e.type === 'thinking' && e.content === 'I should list the files.'
      )
    ).toBe(true);

    const adapted = adaptTranscript(events);
    expect(adapted.agentReport).toBe('Done.');
    expect(adapted.steps).toBe(2); // two assistant text turns
    expect(adapted.toolCalls).toEqual([
      {
        endpoint: 'bash',
        body: { command: 'ls -la', description: 'List files' },
        name: 'shell',
        command: 'ls -la',
        result: 'file1\nfile2',
        error: undefined,
        ts: 1782295624290, // epoch ms preserved through toISO -> parseTs
      },
      {
        endpoint: 'write',
        body: { filePath: '/work/note.txt', content: 'hi' },
        name: 'file_write',
        path: '/work/note.txt',
        result: 'written',
        error: undefined,
        ts: 1782295624300,
      },
    ]);
  });

  it('surfaces skill loads from the skill tool and from SKILL.md reads', () => {
    const stream = [
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'skill',
          callID: 's1',
          state: {
            status: 'completed',
            input: { name: 'supabase' },
            output: '# Supabase',
          },
        },
      }),
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'read',
          callID: 's2',
          state: {
            status: 'completed',
            input: {
              filePath:
                '.claude/skills/supabase-postgres-best-practices/SKILL.md',
            },
            output: '# Postgres',
          },
        },
      }),
    ].join('\n');
    const adapted = adaptTranscript(
      opencodeParser.parseTranscript(stream).events
    );
    expect(adapted.toolCalls.map((call) => call.loadedSkill)).toEqual([
      'supabase',
      'supabase-postgres-best-practices',
    ]);
  });

  it('marks a non-zero shell exit as failed (error surfaced via adapter)', () => {
    const stream = JSON.stringify({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'c1',
        state: {
          status: 'completed',
          input: { command: 'false' },
          output: 'nope',
          metadata: { exit: 1 },
        },
      },
    });
    const events = opencodeParser.parseTranscript(stream).events;
    expect(events.find((e) => e.type === 'tool_result')?.tool?.success).toBe(
      false
    );
    const adapted = adaptTranscript(events);
    expect(adapted.toolCalls[0].error).toBe('nope');
    expect(adapted.toolCalls[0].result).toBeUndefined();
  });

  it('emits an error event and never throws on malformed lines', () => {
    const record = { type: 'error', error: { unrecognized: true } };
    const { events, errors } = opencodeParser.parseTranscript(
      'not json\n' + JSON.stringify(record)
    );
    expect(events).toEqual([
      {
        timestamp: undefined,
        type: 'error',
        content: JSON.stringify(record),
        raw: record,
      },
    ]);
    expect(errors.length).toBe(1);
  });

  it('reads the message out of opencode\'s real error envelope', () => {
    const { events } = opencodeParser.parseTranscript(
      JSON.stringify({
        type: 'error',
        error: { name: 'UnknownError', data: { message: 'boom', ref: 'x' } },
      })
    );
    expect(events[0].content).toBe('UnknownError: boom');
  });

  it('falls back to the error name when data carries no message', () => {
    const { events } = opencodeParser.parseTranscript(
      JSON.stringify({
        type: 'error',
        error: { name: 'MessageOutputLengthError', data: {} },
      })
    );
    expect(events[0].content).toBe('MessageOutputLengthError');
  });
});
