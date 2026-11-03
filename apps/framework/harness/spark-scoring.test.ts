import { afterEach, describe, expect, it, vi } from 'vitest';
import { sparkRestRuntime } from '@supabase-evals/core';
import scorer, {
  checkTasks,
} from '../../../evals/spark/build-database-001-task-due-dates/EVAL.js';

const tasks = [
  {
    id: 1,
    title: 'Write release notes',
    completed: false,
    created_at: '2026-11-01 12:00:00',
    due_date: null,
  },
  {
    id: 2,
    title: 'Ship task tracker',
    completed: false,
    created_at: '2026-11-01 12:01:00',
    due_date: '2026-11-10',
  },
  {
    id: 3,
    title: 'Review schema',
    completed: true,
    created_at: '2026-11-01 12:02:00',
    due_date: null,
  },
  {
    id: 4,
    title: 'Plan next iteration',
    completed: false,
    created_at: '2026-11-01 12:03:00',
    due_date: null,
  },
];

describe('task state checks', () => {
  it('accepts the requested change', () => {
    expect(checkTasks(tasks).every((check) => check.passed)).toBe(true);
  });
  it('rejects missing dates, altered seed data and deleted rows', () => {
    for (const changed of [
      tasks.map((task) => ({ ...task, due_date: null })),
      tasks.map((task) => ({ ...task, title: 'Replaced' })),
      tasks.map((task) => ({ ...task, created_at: '2026-11-02T00:00:00' })),
      tasks.slice(1),
      [],
    ])
      expect(checkTasks(changed).some((check) => !check.passed)).toBe(true);
  });
});

afterEach(() => vi.unstubAllGlobals());

async function score(
  options: {
    columns?: Record<string, unknown>[];
    tableStatus?: number;
    queryStatus?: number;
    reportPasses?: boolean;
  } = {}
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url =
        input instanceof Request ? new URL(input.url) : new URL(input);
      if (url.pathname === '/v1/projects')
        return Response.json({
          ref: 'project',
          url: 'https://project.example',
          api_keys: [
            { type: 'secret', api_key: 'secret' },
            { type: 'publishable', api_key: 'publishable' },
          ],
        });
      if (url.pathname === '/database/query') {
        if (options.queryStatus)
          return new Response('query unavailable', {
            status: options.queryStatus,
          });
        return Response.json(
          options.columns ?? [{ type: 'date', not_null: 0 }]
        );
      }
      expect(url.pathname).toBe('/rest/v1/tasks');
      return options.tableStatus
        ? Response.json(
            { message: 'relation "tasks" does not exist', code: '42P01' },
            { status: options.tableStatus }
          )
        : Response.json(tasks);
    })
  );
  const session = await sparkRestRuntime(
    'https://control.example'
  ).startSession({});
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

describe('hosted task scorer', () => {
  it('accepts the complete result and rejects an incorrect report', async () => {
    expect((await score()).result.passed).toBe(true);
    expect((await score({ reportPasses: false })).result.passed).toBe(false);
  });

  it('rejects missing, non-date and required columns', async () => {
    for (const columns of [
      [],
      [{ type: 'text', not_null: 0 }],
      [{ type: 'date', not_null: 1 }],
    ]) {
      const { result } = await score({ columns });
      expect(result.passed).toBe(false);
      expect(
        result.checks?.find(
          (check) => check.name === 'Optional date column added'
        )?.passed
      ).toBe(false);
    }
  });

  it('records unreadable state and still judges the report', async () => {
    for (const options of [{ tableStatus: 404 }, { queryStatus: 503 }]) {
      const { result, judge } = await score(options);
      expect(result.passed).toBe(false);
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          name: 'Hosted task state readable',
          passed: false,
          notes: expect.any(String),
        })
      );
      expect(judge).toHaveBeenCalledOnce();
    }
  });
});
