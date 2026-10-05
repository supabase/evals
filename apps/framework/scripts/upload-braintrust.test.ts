import { describe, expect, it } from 'vitest';
import {
  experimentName,
  logTranscript,
  runViewUrl,
  unwrapShell,
  type SpanSink,
  tokenMetrics,
  utcStamp,
} from './upload-braintrust.js';

describe('tokenMetrics', () => {
  it('reports cache buckets without double-counting', () => {
    expect(
      tokenMetrics([
        {
          model: 'claude-sonnet-5',
          inputTokens: 18,
          cacheReadInputTokens: 10,
          cacheWriteInputTokens: 5,
          outputTokens: 7,
        },
      ])
    ).toEqual({
      prompt_tokens: 18,
      completion_tokens: 7,
      tokens: 25,
      prompt_cached_tokens: 10,
      prompt_cache_creation_tokens: 5,
    });
  });

  it('sums models and omits zero cache metrics', () => {
    expect(
      tokenMetrics([
        {
          model: 'a',
          inputTokens: 2,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
        {
          model: 'b',
          inputTokens: 4,
          outputTokens: 3,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
      ])
    ).toEqual({ prompt_tokens: 6, completion_tokens: 4, tokens: 10 });
  });

  it('returns no metrics without usage', () => {
    expect(tokenMetrics(undefined)).toEqual({});
  });
});

describe('experimentName', () => {
  it('appends the short sha and stamp', () => {
    expect(experimentName('grok-4.6', 'aefa8348abc', '20260923T1339Z')).toBe(
      'grok-4.6@aefa834-20260923T1339Z'
    );
  });

  it('omits the sha outside a git checkout', () => {
    expect(experimentName('grok-4.6', undefined, '20260923T1339Z')).toBe(
      'grok-4.6-20260923T1339Z'
    );
  });
});

describe('utcStamp', () => {
  it('formats to minute precision', () => {
    expect(utcStamp(new Date('2026-09-23T13:39:07.123Z'))).toBe(
      '20260923T1339Z'
    );
  });
});

describe('runViewUrl', () => {
  it('filters the experiments list by run id', () => {
    const url = runViewUrl(
      'https://www.braintrust.dev/app/my-org/p/MyProject/experiments/my-experiment',
      'my-run-id'
    );
    const { pathname, searchParams } = new URL(url);
    expect(pathname).toBe('/app/my-org/p/MyProject/experiments');
    const [filter] = JSON.parse(searchParams.get('search') ?? '').filter;
    expect(decodeURIComponent(filter.text)).toBe(
      'metadata.run_id = "my-run-id"'
    );
  });
});

interface RecordedSpan {
  name?: string;
  start?: number;
  end?: number;
  metrics?: unknown;
  input?: unknown;
  children: RecordedSpan[];
}

function recorder(node: RecordedSpan): SpanSink {
  return {
    startSpan(args) {
      const child: RecordedSpan = {
        name: args?.name,
        start: args?.startTime,
        children: [],
      };
      node.children.push(child);
      return recorder(child);
    },
    log(event) {
      if (event.metrics) {
        node.metrics = event.metrics;
      }
      if (event.input !== undefined && node.name === 'm') {
        node.input = event.input;
      }
    },
    end(args) {
      node.end = args?.endTime;
    },
  };
}

describe('logTranscript', () => {
  it('logs back-to-back LLM spans per request, with teardown and score after task', () => {
    const root: RecordedSpan = { children: [] };
    const ms = (s: number) => (100 + s) * 1000;
    logTranscript(recorder(root), {
      prompt: 'go',
      agentReport: 'done',
      checks: [],
      judgeCalls: [],
      passed: true,
      modelId: 'm',
      startTime: 100,
      endTime: 150,
      agentEndTime: 140,
      scoringEndTime: 150,
      toolLabels: [],
      transcript: [
        {
          type: 'message',
          role: 'assistant',
          content: 'a',
          ts: ms(4),
          requestId: 'r1',
          usage: {
            inputTokens: 10,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 2,
          },
        },
        {
          type: 'tool_call',
          name: 'Skill',
          input: {},
          output: 'loaded',
          id: 't1',
          ts: ms(4),
          resultTs: ms(5),
          requestId: 'r1',
        },
        {
          type: 'tool_call',
          name: 'Bash',
          input: {},
          output: 'ok',
          id: 't2',
          ts: ms(8),
          resultTs: ms(31),
          requestId: 'r2',
        },
        {
          type: 'message',
          role: 'assistant',
          content: 'b',
          ts: ms(38),
          requestId: 'r3',
        },
      ],
    });
    const span = (
      name: string,
      start: number,
      end: number,
      ...children: RecordedSpan[]
    ) => ({
      name,
      start: 100 + start,
      end: 100 + end,
      children,
    });
    const call = (id: string, name: string) => ({
      id,
      type: 'function',
      function: { name, arguments: '{}' },
    });
    const prompt = { role: 'user', content: 'go' };
    const first = {
      role: 'assistant',
      content: 'a',
      tool_calls: [call('t1', 'Skill')],
    };
    const skillResult = { role: 'tool', tool_call_id: 't1', content: 'loaded' };
    const second = {
      role: 'assistant',
      content: '',
      tool_calls: [call('t2', 'Bash')],
    };
    const bashResult = { role: 'tool', tool_call_id: 't2', content: 'ok' };
    expect(root.children).toEqual([
      span(
        'task',
        0,
        38,
        {
          ...span('m', 0, 4),
          input: [prompt],
          metrics: { prompt_tokens: 10, completion_tokens: 2, tokens: 12 },
        },
        span('Skill', 4, 5),
        { ...span('m', 5, 8), input: [prompt, first, skillResult] },
        span('Bash', 8, 31),
        {
          ...span('m', 31, 38),
          input: [prompt, first, skillResult, second, bashResult],
        }
      ),
      span('teardown', 38, 40),
      span('passed', 40, 50),
    ]);
  });

  it.each([
    ['recorded prompt', 102, 102],
    ['prompt before run start', 98, 100],
    ['prompt after first event', 109, 108],
  ])('starts task and the first LLM span at the %s', (_, promptTime, at) => {
    const root: RecordedSpan = { children: [] };
    logTranscript(recorder(root), {
      prompt: 'go',
      agentReport: '',
      checks: [],
      judgeCalls: [],
      passed: true,
      modelId: 'm',
      startTime: 100,
      endTime: 120,
      promptTime,
      agentEndTime: 110,
      scoringEndTime: 120,
      toolLabels: [],
      transcript: [
        { type: 'message', role: 'assistant', content: 'a', ts: 108_000 },
      ],
    });
    expect(
      root.children.map(({ name, start, end }) => [name, start, end])
    ).toEqual([
      ['setup', 100, at],
      ['task', at, 108],
      ['teardown', 108, 110],
      ['passed', 110, 120],
    ]);
    expect(root.children[1]?.children[0]).toMatchObject({
      name: 'm',
      start: at,
      end: 108,
    });
  });

  it('ends setup at a leading non-assistant message and starts task there', () => {
    const root: RecordedSpan = { children: [] };
    logTranscript(recorder(root), {
      prompt: '',
      agentReport: '',
      checks: [],
      judgeCalls: [],
      passed: false,
      startTime: 100,
      endTime: 120,
      agentEndTime: 110,
      scoringEndTime: 120,
      toolLabels: [],
      transcript: [
        { type: 'message', role: 'system', content: 'init', ts: 103_000 },
        { type: 'message', role: 'assistant', content: 'a', ts: 108_000 },
      ],
    });
    expect(
      root.children.map(({ name, start, end }) => [name, start, end])
    ).toEqual([
      ['setup', 100, 103],
      ['task', 103, 108],
      ['teardown', 108, 110],
      ['passed', 110, 120],
    ]);
    expect(root.children[1]?.children.map((c) => c.name)).toEqual([
      'system',
      'assistant',
    ]);
  });

  it('keeps a zero-length score at the run end for results without recorded times', () => {
    const root: RecordedSpan = { children: [] };
    logTranscript(recorder(root), {
      prompt: '',
      agentReport: '',
      checks: [],
      judgeCalls: [],
      passed: true,
      startTime: 100,
      endTime: 170,
      toolLabels: [],
      transcript: [
        { type: 'message', role: 'assistant', content: 'a', ts: 104_000 },
      ],
    });
    expect(
      root.children.map(({ name, start, end }) => [name, start, end])
    ).toEqual([
      ['task', 100, 104],
      ['passed', 170, 170],
    ]);
  });
});

describe('judge spans', () => {
  it('nests judge calls under the score span', () => {
    const spans: Record<string, unknown>[] = [];
    const sink = (parentName?: string): SpanSink => ({
      startSpan(args) {
        const span: Record<string, unknown> = { ...args, parentName };
        spans.push(span);
        return {
          ...sink(args?.name),
          log: (event) => Object.assign(span, event),
          end: (end) => Object.assign(span, end),
        };
      },
      log() {},
      end() {},
    });
    logTranscript(sink(), {
      prompt: '',
      agentReport: '',
      checks: [],
      passed: true,
      startTime: 100,
      endTime: 150,
      agentEndTime: 110,
      scoringEndTime: 150,
      toolLabels: [],
      transcript: [],
      judgeCalls: [
        {
          provider: 'openai',
          system: 'sys',
          prompt: 'Rubric:\nr',
          output: { passed: true, notes: 'ok' },
          usage: {
            model: 'gpt-6-sol',
            inputTokens: 100,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 7,
          },
          startedAt: 120_000,
          durationMs: 4000,
        },
      ],
    });
    expect(spans.find((span) => span.name === 'passed')).toMatchObject({
      type: 'score',
      spanAttributes: { purpose: 'scorer' },
    });
    expect(spans.find((span) => span.name === 'gpt-6-sol')).toMatchObject({
      parentName: 'passed',
      type: 'llm',
      spanAttributes: { purpose: 'scorer' },
      startTime: 120,
      endTime: 124,
      input: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Rubric:\nr' },
      ],
      output: { passed: true, notes: 'ok' },
      metrics: { prompt_tokens: 100, completion_tokens: 7, tokens: 107 },
      metadata: { model: 'gpt-6-sol', provider: 'openai' },
    });
  });
});

describe('unwrapShell', () => {
  it("drops Codex's bash -lc wrapper and leaves other commands alone", () => {
    expect(unwrapShell(`/bin/bash -lc "ls -la && cat 'a b'"`)).toBe(
      "ls -la && cat 'a b'"
    );
    expect(unwrapShell(`/bin/bash -lc "apply_patch <<'PATCH' x PATCH'`)).toBe(
      "apply_patch <<'PATCH' x PATCH"
    );
    expect(unwrapShell('supabase status')).toBe('supabase status');
  });
});
