import { afterEach, describe, expect, it, vi } from 'vitest';
import { sparkRuntime } from '../../../experiments/spark/lib/runtime.js';
import scorer from './EVAL.js';

const tasks = [
  'Write release notes',
  'Ship task tracker',
  'Review schema',
  'Plan next iteration',
].map((title, index) => ({
  id: index + 1,
  title,
  completed: index === 2,
  created_at: `2026-11-01 12:0${index}:00`,
  due_date: index === 1 ? '2026-11-10' : null,
}));

afterEach(() => vi.unstubAllGlobals());

async function score(
  options: {
    columns?: Record<string, unknown>[];
    tasks?: unknown;
    tableStatus?: number;
    reportPasses?: boolean;
  } = {}
) {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input);
    if (url.pathname === '/v1/projects')
      return Response.json({
        ref: 'project',
        url: 'https://project.example',
        api_keys: [
          { type: 'secret', api_key: 'secret' },
          { type: 'publishable', api_key: 'publishable' },
        ],
      });
    if (url.pathname === '/database/query')
      return Response.json(
        options.columns ?? [{ name: 'due_date', type: 'date', not_null: 0 }]
      );
    expect(url.pathname).toBe('/rest/v1/tasks');
    return options.tableStatus
      ? Response.json(
          { message: 'table unavailable' },
          { status: options.tableStatus }
        )
      : Response.json(options.tasks ?? tasks);
  });
  const session = await sparkRuntime('https://control.example').startSession(
    {}
  );
  const judge = vi.fn(async () => ({ passed: options.reportPasses ?? true }));
  try {
    const result = await scorer({
      ...session.scoringContext,
      toolCalls: [],
      transcript: [],
      judge,
    });
    return { result, judge };
  } finally {
    await session.close();
  }
}

describe('task state checks', () => {
  it('rejects missing dates, altered seed data and deleted rows', async () => {
    for (const [changed, name] of [
      [
        tasks.map((task) => ({ ...task, due_date: null })),
        'Requested due date saved and other tasks undated',
      ],
      [
        tasks.map((task) => ({ ...task, title: 'Replaced' })),
        'Existing task data preserved',
      ],
      [
        tasks.map((task) => ({ ...task, created_at: '2026-11-02T00:00:00' })),
        'Existing task data preserved',
      ],
      [
        tasks.map((task) => ({ ...task, completed: 'false' })),
        'Existing task data preserved',
      ],
      [tasks.slice(1), 'Existing task data preserved'],
      [[], 'Existing task data preserved'],
    ])
      expect((await score({ tasks: changed })).result.checks).toContainEqual(
        expect.objectContaining({ name, passed: false })
      );
  });
});

describe('hosted task scorer', () => {
  it('accepts the complete result and rejects an incorrect report', async () => {
    expect((await score()).result.passed).toBe(true);
    expect((await score({ reportPasses: false })).result.passed).toBe(false);
  });

  it('accepts a matching date column after an unrelated date column', async () => {
    const renamed = tasks.map(({ due_date, ...task }) => ({
      ...task,
      deadline: due_date,
    }));
    expect(
      (
        await score({
          columns: [
            { name: 'another_date', type: 'date', not_null: 0 },
            { name: 'deadline', type: 'date', not_null: 0 },
          ],
          tasks: renamed,
        })
      ).result.passed
    ).toBe(true);
  });

  it('rejects missing, non-date and required columns', async () => {
    for (const columns of [
      [],
      [{ name: 'due_date', type: 'text', not_null: 0 }],
      [{ name: 'due_date', type: 'date', not_null: 1 }],
    ]) {
      const { result } = await score({ columns });
      expect(result.passed).toBe(false);
      expect(
        result.checks?.find(
          (check) => check.name === 'Nullable date column added'
        )?.passed
      ).toBe(false);
    }
  });

  it('records unreadable state and still judges the report', async () => {
    const { result, judge } = await score({ tableStatus: 404 });
    expect(result.passed).toBe(false);
    expect(result.checks?.map((check) => check.name)).toEqual([
      'Nullable date column added',
      'Existing task data preserved',
      'Requested due date saved and other tasks undated',
      'Open tasks reported in due-date order',
    ]);
    expect(result.checks?.slice(0, 3)).toEqual(
      Array(3).fill(
        expect.objectContaining({ passed: false, notes: expect.any(String) })
      )
    );
    expect(judge).toHaveBeenCalledOnce();
  });
});
