import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '../transcript/types.js';
import { adaptTranscript } from './adapt.js';

describe('adaptTranscript', () => {
  const events: TranscriptEvent[] = [
    {
      type: 'tool_call',
      timestamp: '2026-06-18T10:00:00.000Z',
      tool: {
        name: 'shell',
        originalName: 'Bash',
        id: 't1',
        command: 'supabase start',
        cwd: '/work/client-a',
      },
    },
    {
      type: 'tool_result',
      timestamp: '2026-06-18T10:00:05.000Z',
      tool: { name: 'shell', originalName: 'Bash', id: 't1', result: 'ok' },
    },
    {
      type: 'tool_call',
      tool: { name: 'shell', originalName: 'Bash', id: 't2', command: 'ls' },
    },
  ];

  it("copies a call's cwd and result time onto its ToolCallRecord", () => {
    const [first, second] = adaptTranscript(events).toolCalls;
    expect(first.cwd).toBe('/work/client-a');
    expect(first.resultTs).toBe(Date.parse('2026-06-18T10:00:05.000Z'));
    expect(second.cwd).toBeUndefined();
    expect(second.resultTs).toBeUndefined();
  });

  it("copies a call's cwd onto its transcript part only when present", () => {
    const parts = adaptTranscript(events).transcript.filter(
      (part) => part.type === 'tool_call'
    );
    expect(parts[0]).toMatchObject({ cwd: '/work/client-a' });
    expect(parts[1]).not.toHaveProperty('cwd');
  });
});
