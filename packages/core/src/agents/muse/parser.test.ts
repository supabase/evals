import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDocsResult } from '../../docs-results.js';
import { adaptTranscript } from '../../parsers/adapt.js';
import {
  fatalErrors,
  lastTerminal,
  modelRequestCount,
  museParser,
  sessionOpened,
  sessionPromptAt,
  sessionUsage,
} from './parser.js';

/**
 * Session logs written by the real Muse Code 1.4.3-R5018.1 binary, as the
 * runner reads them (the main log, then each child session's log). Local
 * paths are replaced, long strings are trimmed, envelope fields the parser
 * doesn't read are dropped, and records it ignores are kept once each with
 * their bodies reduced. They parse to exactly what the full logs parse to.
 *
 * Against Meta's API (muse-spark-1.3, high effort):
 *   files          read two files, edit both, run one with bash
 *   shell-failure  a bash command that exits 1
 *   mcp            a call to a stdio MCP server's `echo` tool
 *   web            web_search, then web_fetch of a Supabase docs page
 *   skill          read_skill for a workspace skill
 *   subagent       a subagent that runs bash, plus reminder agents
 *   step-limit     `--max-model-steps 1`
 *   bad-model      a model id that doesn't exist
 * Without a key:
 *   echo-session   the keyless echo provider; its verify-reminder fails with
 *                  config_error because echo can't serve reminders
 *   bad-key-session  a rejected key, before a session opened
 */
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8');

const parse = (name: string) => {
  const { events } = museParser.parseTranscript(fixture(name));
  return { events, ...adaptTranscript(events) };
};

describe('museParser on real runs', () => {
  it('reads tool calls, their results, and the final report', () => {
    const { toolCalls, agentReport } = parse('files');
    expect(
      toolCalls.map((c) => [c.name, c.tool, c.body, c.error === undefined])
    ).toEqual([
      [
        'file_read',
        { kind: 'other', toolName: 'read_file' },
        { path: 'notes.txt' },
        true,
      ],
      [
        'file_read',
        { kind: 'other', toolName: 'read_file' },
        { path: 'app.py' },
        true,
      ],
      [
        'file_edit',
        { kind: 'other', toolName: 'edit_file' },
        {
          find: 'line two',
          path: 'notes.txt',
          replace: 'line two\nline three',
        },
        true,
      ],
      [
        'file_edit',
        { kind: 'other', toolName: 'edit_file' },
        { find: 'print("hi")', path: 'app.py', replace: 'print("bye")' },
        true,
      ],
      [
        'shell',
        { kind: 'other', toolName: 'bash' },
        { command: 'python3 app.py', description: 'Run app.py with python3' },
        true,
      ],
    ]);
    // The text the model saw, paired by call id.
    expect(toolCalls[0].result).toBe(
      'Read text file `notes.txt`.\n1|line one\n2|line two'
    );
    expect(agentReport).toMatch(/^Done\.\n\n- \[notes\.txt\]/);
    expect(agentReport).toContain('`python3 app.py` output: `bye`');
  });

  it('maps Muse tool names to canonical ones and extracts their arguments', () => {
    const { events } = parse('files');
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(
      calls.map((e) => [e.tool?.name, e.tool?.path, e.tool?.command])
    ).toEqual([
      ['file_read', 'notes.txt', undefined],
      ['file_read', 'app.py', undefined],
      ['file_edit', 'notes.txt', undefined],
      ['file_edit', 'app.py', undefined],
      ['shell', undefined, 'python3 app.py'],
    ]);
  });

  it('ties each tool call to the request that made it, with that request’s usage', () => {
    const { events } = parse('files');
    const first = events[0];
    expect(first).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: 'Adding your third line, flipping hi to bye, and running it.',
      usage: {
        inputTokens: 25250,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 227,
      },
    });
    // Both reads came from that first response.
    expect(events[1].requestId).toBe(first.requestId);
    expect(events[2].requestId).toBe(first.requestId);
    // The next request reused the cached prefix.
    expect(events[5].usage).toEqual({
      inputTokens: 25560,
      cacheReadInputTokens: 24945,
      cacheWriteInputTokens: 0,
      outputTokens: 298,
    });
  });

  it('marks a failed tool call as an error', () => {
    const [call] = parse('shell-failure').toolCalls;
    expect(call.tool).toEqual({ kind: 'other', toolName: 'bash' });
    expect(call.error).toContain('"exit_code": 1');
    expect(call.error).toContain('No such file or directory');
  });

  it('attributes MCP calls to their server', () => {
    const [call] = parse('mcp').toolCalls;
    expect(call.tool).toEqual({
      kind: 'mcp',
      server: 'everything',
      toolName: 'echo',
    });
    expect(call.body).toEqual({ message: 'ping' });
    expect(call.result).toBe('Echo: ping');
  });

  it('feeds web search and fetch into docs results', () => {
    const { toolCalls } = parse('web');
    expect(buildDocsResult(toolCalls).calls).toEqual([
      {
        source: 'web_search',
        query: 'Supabase documentation Row Level Security',
        hasContent: false,
        pages: [
          {
            url: 'https://supabase.com/docs/guides/database/postgres/row-level-security?ref=javorszky.co.uk',
          },
          {
            url: 'https://supabase.com/docs/guides/troubleshooting/rls-simplified-BJTcS8',
          },
        ],
        resultChars: expect.any(Number),
      },
      {
        source: 'web_fetch',
        query:
          'https://supabase.com/docs/guides/database/postgres/row-level-security',
        hasContent: true,
        pages: [
          {
            url: 'https://supabase.com/docs/guides/database/postgres/row-level-security',
          },
        ],
        resultChars: expect.any(Number),
      },
    ]);
  });

  it('records the skills read_skill loads, and reasoning summaries', () => {
    const { toolCalls, events } = parse('skill');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].loadedSkills).toEqual(['supabase']);
    expect(events.filter((e) => e.type === 'thinking')).toHaveLength(1);
  });

  it("includes a subagent's tool calls but not the reminder agents'", () => {
    const raw = fixture('subagent');
    const { toolCalls, agentReport } = parse('subagent');
    // The reminders each called submit_reminder_decision; those are the
    // harness watching, not the agent working.
    expect(toolCalls.map((c) => c.tool.toolName)).toEqual([
      'subagent_spawn',
      'subagent_wait',
      'bash',
      'subagent_read_result',
    ]);
    expect(toolCalls[2].body.command).toContain('wc -l');
    expect(agentReport).toBe(
      'Subagent line count complete:\n\n- `app.py`: 1 line\n- `notes.txt`: 2 lines\n- Total: 3 lines'
    );
    // Steps are the agent's own responses; usage is every session's.
    expect(modelRequestCount(raw)).toBe(4);
    expect(sessionUsage(raw, 'muse-spark-1.3')).toEqual([
      {
        model: 'muse-spark-1.3',
        inputTokens: 152889,
        cacheReadInputTokens: 99253,
        cacheWriteInputTokens: 0,
        outputTokens: 1898,
      },
    ]);
  });

  it('records the step limit as a scored failure', () => {
    const raw = fixture('step-limit');
    expect(lastTerminal(raw)).toEqual({
      terminal: 'failed',
      reason: 'model did not reach a terminal state within 1 step(s)',
      errorClass: 'step_limit',
    });
    expect(
      parse('step-limit')
        .events.filter((e) => e.type === 'error')
        .map((e) => e.content)
    ).toEqual(['Muse run failed: step_limit']);
  });

  it('reports a model request the provider refused, though Muse left it unclassified', () => {
    expect(fatalErrors(fixture('bad-model'))).toEqual([
      {
        sessionId: '01a11814-ed9e-7983-927e-7bcd50485893',
        isMain: true,
        errorClass: 'provider_error',
        reason:
          'model `muse-spark-9.9` does not exist or you lack access [request_id=b6c377b4-5d42-47b7-9f9f-2c24de7bfdf3]',
      },
    ]);
  });

  it('times the prompt from the main run start', () => {
    expect(sessionPromptAt(fixture('files'))).toBe(1_791_405_278_676);
  });
});

describe('museParser on the keyless echo run', () => {
  const ECHO = fixture('echo-session');

  it('reads the reply and its usage', () => {
    const { agentReport, events } = parse('echo-session');
    expect(agentReport).toBe('echo: Say hello and list the files here.');
    expect(events[0].requestId).toBe(
      '11111111-1111-4111-8111-111111111111:muse-tui-echo'
    );
  });

  it("keeps the reminder's failure out of the transcript but reports it", () => {
    expect(
      parse('echo-session').events.filter((e) => e.type === 'error')
    ).toEqual([]);
    expect(lastTerminal(ECHO)).toEqual({ terminal: 'completed' });
    expect(fatalErrors(ECHO)).toEqual([
      {
        sessionId: 'f2a2cdf2-dd92-480c-9c81-c334c8e5ac80',
        isMain: false,
        errorClass: 'config_error',
        reason:
          'invalid run configuration: provider does not support base instructions',
      },
    ]);
  });
});

describe('a run that never opened a session', () => {
  it('is recognized, and is not a transcript', () => {
    const BAD_KEY = fixture('bad-key-session');
    expect(sessionOpened(BAD_KEY)).toBe(false);
    expect(sessionOpened(fixture('echo-session'))).toBe(true);
    expect(() => museParser.parseTranscript(BAD_KEY)).toThrow(
      'no session.opened.observed'
    );
  });
});

/** One envelope line, shaped like Muse's own. */
function record(
  session: string,
  sequence: number,
  payloadType: string,
  payload: Record<string, unknown>
): string {
  return JSON.stringify({
    schema_version: 1,
    stream: { kind: 'session', id: session },
    sequence,
    recorded_at: 1_791_400_000_000_000 + sequence * 1_000_000,
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  });
}

const run = (
  session: string,
  sequence: number,
  event: Record<string, unknown>
) =>
  record(session, sequence, 'runtime.session', {
    kind: 'run',
    run_id: `run-${session}`,
    event,
  });

const usage = (
  input: number,
  output: number,
  cacheRead = 0,
  reasoning = 0
) => ({
  input_tokens: input,
  output_tokens: output,
  cached_tokens: cacheRead,
  cache_read_tokens: cacheRead,
  cache_write_tokens: 0,
  reasoning_tokens: reasoning,
});

/** A minimal main session up to the run's start. */
function mainLog(...rest: string[]): string[] {
  return [
    record('main', 1, 'session.opened.observed', {
      kind: 'session_opened',
      record: { schema_version: 1, session_id: 'main' },
    }),
    run('main', 2, { kind: 'started', prompt: 'Fix the bug.' }),
    ...rest,
  ];
}

const completed = (sequence: number) =>
  run('main', sequence, { kind: 'terminal', terminal: 'completed' });

describe('museParser usage', () => {
  it('refuses usage that breaks its own convention', () => {
    // Cache reads beyond the input, or reasoning beyond the output, would mean
    // Muse counts them beside the totals, and every total here would be short.
    for (const reported of [usage(100, 5, 900), usage(100, 5, 0, 50)]) {
      const log = mainLog(
        run('main', 3, { kind: 'model_response_created', response_id: 'r1' }),
        run('main', 4, { kind: 'model_completed', usage: reported })
      ).join('\n');
      expect(() => museParser.parseTranscript(log)).toThrow(
        'usage breaks its own convention'
      );
    }
  });

  it('reads the older cached_tokens name when cache_read_tokens is absent', () => {
    const log = mainLog(
      run('main', 3, { kind: 'model_response_created', response_id: 'r1' }),
      run('main', 4, {
        kind: 'model_completed',
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          cached_tokens: 60,
          reasoning_tokens: 0,
        },
      })
    ).join('\n');
    expect(sessionUsage(log, 'm')?.[0].cacheReadInputTokens).toBe(60);
  });
});

describe('museParser failures', () => {
  it('reports fatal errors that no terminal event followed', () => {
    const raw = mainLog(
      run('main', 3, {
        kind: 'run_fatal_error_classified',
        error_class: 'rate_limited',
      })
    ).join('\n');
    expect(lastTerminal(raw)).toBeUndefined();
    expect(fatalErrors(raw)).toEqual([
      { sessionId: 'main', isMain: true, errorClass: 'rate_limited' },
    ]);
  });

  it("doesn't add provider_error where Muse classified the failure", () => {
    const task = (sequence: number, kind: string, extra = {}) =>
      record('main', sequence, 'runtime.session', {
        kind: 'task',
        event: { kind, task_id: 't1', ...extra },
      });
    const raw = mainLog(
      task(3, 'proposed', { task_kind: 'model.meta.response' }),
      task(4, 'failed', { reason: 'prompt too long' }),
      run('main', 5, {
        kind: 'run_fatal_error_classified',
        error_class: 'context_length',
      })
    ).join('\n');
    expect(fatalErrors(raw).map((e) => e.errorClass)).toEqual([
      'context_length',
    ]);
  });
});

describe('museParser strictness', () => {
  // Every case is something a real run could contain that the parser can't
  // yet read; scoring a transcript with it silently dropped could be wrong.
  it.each([
    [
      'an unknown run event',
      run('main', 3, { kind: 'tool_call_started', tool: 'bash' }),
      'run event "tool_call_started"',
    ],
    [
      'an unknown task kind',
      record('main', 3, 'runtime.session', {
        kind: 'task',
        event: { kind: 'proposed', task_kind: 'browser.open' },
      }),
      'task kind "browser.open"',
    ],
    [
      'a proposed task without a kind',
      record('main', 3, 'runtime.session', {
        kind: 'task',
        event: { kind: 'proposed' },
      }),
      'task kind "undefined"',
    ],
    [
      'an unknown task event',
      record('main', 3, 'runtime.session', {
        kind: 'task',
        event: { kind: 'paused' },
      }),
      'task event "paused"',
    ],
    [
      'an unknown session record kind',
      record('main', 3, 'runtime.session', { kind: 'approval_pending' }),
      'runtime.session record of kind "approval_pending"',
    ],
    [
      'an unknown payload type',
      record('main', 3, 'runtime.approval.requested', {}),
      'payload type "runtime.approval.requested"',
    ],
    [
      'an unknown subagent control record',
      record('main', 3, 'subagent.control.migrated', {}),
      'payload type "subagent.control.migrated"',
    ],
    [
      'a malformed MCP tool catalog',
      record('main', 3, 'runtime.mcp_tool_identity_catalog', {
        kind: 'mcp_tool_identity_catalog',
        entries: [{ canonical_id: 'mcp__x__y' }],
      }),
      'MCP tool identity catalog entry',
    ],
    [
      'a terminal event without its outcome',
      run('main', 3, { kind: 'terminal', reason: 'done' }),
      'terminal event without a string terminal',
    ],
    [
      'an assistant message without text',
      run('main', 3, {
        kind: 'assistant_message_committed',
        response_id: 'r1',
      }),
      'assistant_message_committed event without a string text',
    ],
    [
      'a fatal error without a class',
      run('main', 3, { kind: 'run_fatal_error_classified' }),
      'run_fatal_error_classified event without a string error_class',
    ],
    [
      'a tool call without a call id',
      run('main', 3, {
        kind: 'assistant_tool_calls_committed',
        response_id: 'r1',
        tool_calls: [{ name: 'bash', args: '{}' }],
      }),
      'tool call "bash" without a call id',
    ],
    [
      'a tool result without a call id',
      run('main', 3, {
        kind: 'tool_result_batch_committed',
        results: [{ text: 'ok' }],
      }),
      'tool result without a call id',
    ],
    ['a line that is not JSON', '{"schema_version":1,', 'is not JSON'],
    [
      'another envelope version',
      JSON.stringify({ schema_version: 2, payload_type: 'x', payload: {} }),
      'is not a schema_version 1 envelope',
    ],
    [
      'a retained marker of another kind',
      JSON.stringify({ retained_marker: 'omitted_durable', schema_version: 1 }),
      "is a retained marker the parser doesn't know",
    ],
    [
      'a session-opening record with another payload version',
      record('main', 3, 'session.opened.observed', {
        kind: 'session_opened',
        record: { session_id: 'main' },
      }).replace('"payload_schema_version":1', '"payload_schema_version":2'),
      'session.opened.observed record with payload_schema_version 2',
    ],
    [
      'a run event with another payload version',
      run('main', 3, { kind: 'terminal', terminal: 'completed' }).replace(
        '"payload_schema_version":1',
        '"payload_schema_version":2'
      ),
      'run record with payload_schema_version 2',
    ],
  ])('throws on %s', (_case, line, message) => {
    const raw = mainLog(line, completed(9)).join('\n');
    expect(() => museParser.parseTranscript(raw)).toThrow(message);
  });

  it("names an MCP tool by the server's own name, from Muse's catalog", () => {
    // Muse renames tools for the model: `get-env` becomes `get_env`.
    const raw = mainLog(
      record('main', 3, 'runtime.mcp_tool_identity_catalog', {
        kind: 'mcp_tool_identity_catalog',
        entries: [
          {
            canonical_id: 'mcp__everything__get_env',
            surface: { namespace: 'mcp__everything', name: 'get_env' },
            server_name: 'everything',
            raw_tool_name: 'get-env',
          },
        ],
      }),
      run('main', 4, {
        kind: 'assistant_tool_calls_committed',
        response_id: 'r1',
        tool_calls: [
          { call_id: 'c1', name: 'mcp__everything__get_env', args: '{}' },
          { call_id: 'c2', name: 'mcp__other__list_rows', args: '{}' },
        ],
      }),
      completed(5)
    ).join('\n');
    const calls = museParser
      .parseTranscript(raw)
      .events.filter((e) => e.type === 'tool_call');
    expect(calls.map((e) => e.tool?.call)).toEqual([
      { kind: 'mcp', server: 'everything', toolName: 'get-env' },
      // Not in the catalog: split by structure.
      { kind: 'mcp', server: 'other', toolName: 'list_rows' },
    ]);
  });

  it('orders events across sessions by their microsecond record times', () => {
    // Same millisecond: the subagent's call happened first, though its log
    // comes after the main log in `raw`.
    const at = (line: string, micros: number) =>
      line.replace(/"recorded_at":\d+/, `"recorded_at":${micros}`);
    const call = (session: string, id: string) =>
      run(session, 3, {
        kind: 'assistant_tool_calls_committed',
        response_id: 'r1',
        tool_calls: [{ call_id: id, name: 'bash', args: '{}' }],
      });
    const raw = [
      ...mainLog(at(call('main', 'main-call'), 1_791_400_010_000_900)),
      at(call('sub', 'sub-call'), 1_791_400_010_000_100),
    ].join('\n');
    expect(
      museParser
        .parseTranscript(raw)
        .events.filter((e) => e.type === 'tool_call')
        .map((e) => e.tool?.id)
    ).toEqual(['sub-call', 'main-call']);
  });

  it('keeps tool arguments that are not JSON, as Muse does', () => {
    const raw = mainLog(
      run('main', 3, {
        kind: 'assistant_tool_calls_committed',
        response_id: 'r1',
        tool_calls: [{ call_id: 'c1', name: 'bash', args: '{"command": ls' }],
      }),
      completed(4)
    ).join('\n');
    const [call] = museParser
      .parseTranscript(raw)
      .events.filter((e) => e.type === 'tool_call');
    expect(call.tool?.args).toEqual({ raw_args: '{"command": ls' });
  });

  it('throws when a finished run links a child log that was not read', () => {
    const link = run('main', 3, {
      kind: 'memory_reminder_child_session_linked',
      child_session_id: 'missing-child',
      child_session_log_path: 'subagent/missing-child/session.jsonl',
    });
    expect(() =>
      museParser.parseTranscript(mainLog(link, completed(4)).join('\n'))
    ).toThrow('missing-child');
    // Killed at the time limit: the child may not have written its log yet.
    expect(() =>
      museParser.parseTranscript(mainLog(link).join('\n'))
    ).not.toThrow();
  });

  it('throws when a finished run binds a subagent whose log was not read', () => {
    const SUBAGENT_SESSION = '01a11814-867a-7bb1-881c-1988a40e2ba5';
    const withoutChild = fixture('subagent')
      .split('\n')
      .filter((line) => !line.includes(`"id":"${SUBAGENT_SESSION}"`))
      .join('\n');
    expect(() => museParser.parseTranscript(withoutChild)).toThrow(
      `subagent session ${SUBAGENT_SESSION} has no log`
    );
  });

  it('accepts a linked child that has no log', () => {
    // Muse gives the skill reminder no log at all.
    const link = run('main', 3, {
      kind: 'memory_reminder_child_session_linked',
      child_session_id: 'logless-child',
    });
    expect(() =>
      museParser.parseTranscript(mainLog(link, completed(4)).join('\n'))
    ).not.toThrow();
  });
});
