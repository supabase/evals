import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ciRunUrl,
  experimentName,
  judgeMetrics,
  logTranscript,
  relatedPrLines,
  runViewUrl,
  unwrapShell,
  type SpanSink,
  tokenMetrics,
  transcriptSchema,
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

describe('relatedPrLines', () => {
  it('lists related PRs or none', () => {
    expect(
      relatedPrLines([
        'https://github.com/supabase/evals/pull/386',
        'https://github.com/supabase/evals/pull/384',
      ])
    ).toEqual([
      '**Related PRs:**',
      '',
      '- [#386](https://github.com/supabase/evals/pull/386)',
      '- [#384](https://github.com/supabase/evals/pull/384)',
      '',
    ]);
    expect(relatedPrLines([])).toEqual(['**Related PRs:** (none)', '']);
  });
});

describe('ciRunUrl', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('links the CI run when a run ID is present', () => {
    vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');
    vi.stubEnv('GITHUB_REPOSITORY', 'supabase/evals');
    vi.stubEnv('GITHUB_RUN_ID', '123');
    expect(ciRunUrl()).toEqual({
      ci_run_url: 'https://github.com/supabase/evals/actions/runs/123',
    });
    vi.stubEnv('GITHUB_RUN_ID', '');
    expect(ciRunUrl()).toEqual({});
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

  it('starts LLM spans during a backgrounded command at the previous edge', () => {
    const root: RecordedSpan = { children: [] };
    const message = (requestId: string, s: number) => ({
      type: 'message' as const,
      role: 'assistant' as const,
      content: requestId,
      ts: (100 + s) * 1000,
      requestId,
    });
    logTranscript(recorder(root), {
      prompt: 'go',
      agentReport: '',
      checks: [],
      judgeCalls: [],
      passed: true,
      modelId: 'm',
      startTime: 100,
      toolLabels: [],
      transcript: [
        {
          type: 'tool_call',
          name: 'Bash',
          input: {},
          id: 't1',
          ts: 104_000,
          resultTs: 120_000,
          requestId: 'r1',
        },
        message('r2', 8),
        message('r3', 12),
        message('r4', 25),
      ],
    });
    expect(
      root.children[0]?.children.map(({ name, start, end }) => [
        name,
        start,
        end,
      ])
    ).toEqual([
      ['m', 100, 104],
      ['Bash', 104, 120],
      ['m', 104, 108],
      ['m', 108, 112],
      ['m', 120, 125],
    ]);
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

describe('tool span cwd', () => {
  const toolMetadata = (transcript: unknown) => {
    const metadata: unknown[] = [];
    const sink = (): SpanSink => ({
      startSpan: sink,
      log(event) {
        if (event.metadata && 'tool_name' in event.metadata) {
          metadata.push(event.metadata);
        }
      },
      end() {},
    });
    logTranscript(sink(), {
      prompt: 'go',
      agentReport: '',
      checks: [],
      judgeCalls: [],
      passed: true,
      modelId: 'm',
      startTime: 100,
      endTime: 120,
      agentEndTime: 110,
      scoringEndTime: 120,
      toolLabels: [],
      transcript: transcriptSchema.parse(transcript),
    });
    return metadata;
  };

  it('puts a call cwd in tool span metadata and omits it otherwise', () => {
    expect(
      toolMetadata([
        { type: 'tool_call', name: 'Bash', ts: 101_000, cwd: '/work/a' },
        { type: 'tool_call', name: 'Bash', ts: 102_000 },
      ])
    ).toEqual([{ tool_name: 'Bash', cwd: '/work/a' }, { tool_name: 'Bash' }]);
  });

  it('parses transcript parts with and without cwd', () => {
    const parsed = transcriptSchema.parse([
      { type: 'tool_call', name: 'Bash', input: {}, cwd: '/work/a' },
      { type: 'tool_call', name: 'Bash', input: {} },
    ]);
    expect(parsed[0]).toMatchObject({ cwd: '/work/a' });
    expect(parsed[1]).not.toHaveProperty('cwd');
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
          model: 'gpt-6-sol',
          usage: { inputTokens: 100, outputTokens: 7, reasoningTokens: 5 },
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
      metrics: {
        prompt_tokens: 100,
        completion_tokens: 7,
        completion_reasoning_tokens: 5,
        tokens: 107,
      },
      metadata: { model: 'gpt-6-sol', provider: 'openai' },
    });
  });

  it('omits unreported judge token counts', () => {
    expect(judgeMetrics({ outputTokens: 12 })).toEqual({
      completion_tokens: 12,
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
