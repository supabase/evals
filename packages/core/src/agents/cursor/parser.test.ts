import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adaptTranscript } from '../../parsers/adapt.js';
import { cursorParser } from './parser.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

describe('cursorParser', () => {
  it('parses a live Composer ask session (thinking + assistant + result)', () => {
    const raw = loadFixture('stream-json-live-composer-2.5.jsonl');
    const { events, errors } = cursorParser.parseTranscript(raw);
    expect(errors).toEqual([]);

    expect(events.some((e) => e.type === 'message' && e.role === 'user')).toBe(
      true
    );
    expect(
      events.some((e) => e.type === 'message' && e.role === 'assistant')
    ).toBe(true);
    expect(events.some((e) => e.type === 'thinking')).toBe(true);

    const thinking = events.find((e) => e.type === 'thinking');
    expect(thinking?.content).toContain('PONG');

    const assistant = events.filter(
      (e) => e.type === 'message' && e.role === 'assistant'
    );
    // Result line repeats "PONG" — must not double-emit.
    expect(assistant.map((e) => e.content)).toEqual(['PONG']);
  });

  it('parses live MCP tool use into tool_call + tool_result', () => {
    const raw = loadFixture('stream-json-live-mcp-composer-2.5.jsonl');
    const { events, errors } = cursorParser.parseTranscript(raw);
    expect(errors).toEqual([]);

    const toolCalls = events.filter((e) => e.type === 'tool_call');
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolResults.length).toBe(toolCalls.length);

    const mcpCall = toolCalls.find((e) => e.tool?.originalName === 'm0_ping');
    expect(mcpCall?.tool?.name).toBe('tool_use');
    expect(mcpCall?.tool?.id).toBeTruthy();

    const mcpResult = toolResults.find((e) => e.tool?.id === mcpCall?.tool?.id);
    expect(mcpResult?.tool?.success).toBe(true);
    expect(JSON.stringify(mcpResult?.tool?.result)).toContain('PONG_FROM_MCP');
  });

  it('normalizes docs-sample read/write tool calls', () => {
    const raw = loadFixture('stream-json-docs-sample.jsonl');
    const { events, errors } = cursorParser.parseTranscript(raw);
    expect(errors).toEqual([]);

    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls.map((e) => e.tool?.name)).toEqual([
      'file_read',
      'file_write',
    ]);
    expect(toolCalls[0].tool?.path).toBe('README.md');
    expect(toolCalls[1].tool?.path).toBe('summary.txt');
    // started events are skipped — only completed pairs
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2);
  });

  it('normalizes Harbor shellToolCall shapes', () => {
    const raw = loadFixture('stream-json-harbor-tool-shapes.jsonl');
    const { events, errors } = cursorParser.parseTranscript(raw);
    expect(errors).toEqual([]);

    const shell = events.find(
      (e) => e.type === 'tool_call' && e.tool?.name === 'shell'
    );
    expect(shell?.tool?.command).toBe('ls');
    expect(shell?.tool?.originalName).toBe('shellToolCall');
  });

  it('skips started tool_call events', () => {
    const transcript = [
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'c1',
        tool_call: { readToolCall: { args: { path: 'a.txt' } } },
      }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'c1',
        tool_call: {
          readToolCall: {
            args: { path: 'a.txt' },
            result: { success: { content: 'hi' } },
          },
        },
      }),
    ].join('\n');

    const { events } = cursorParser.parseTranscript(transcript);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(1);
  });

  it('never throws on malformed lines and records parse errors', () => {
    const { events, errors } = cursorParser.parseTranscript(
      'not json\n' + JSON.stringify({ type: 'system', subtype: 'init' })
    );
    expect(events).toEqual([]);
    expect(errors.length).toBe(1);
  });

  it('emits an error event when the result line is_error', () => {
    const transcript = JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'something broke',
    });
    const { events } = cursorParser.parseTranscript(transcript);
    expect(events.filter((e) => e.type === 'error')).toEqual([
      expect.objectContaining({ content: 'something broke' }),
    ]);
  });
});

describe('adaptTranscript (cursor fixtures)', () => {
  it('derives report and tool calls from the live MCP session', () => {
    const raw = loadFixture('stream-json-live-mcp-composer-2.5.jsonl');
    const { events } = cursorParser.parseTranscript(raw);
    const adapted = adaptTranscript(events);

    expect(adapted.agentReport).toBe('PONG_FROM_MCP');
    expect(adapted.toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(
      adapted.toolCalls.some(
        (t) =>
          t.endpoint.includes('m0_ping') ||
          JSON.stringify(t).includes('m0_ping')
      )
    ).toBe(true);
  });
});
