import { describe, expect, it } from 'vitest';
import {
  SPARK_TEST_KEYS,
  failedChecks,
  sparkScorer,
  stubSandbox,
} from '../../../experiments/spark/lib/runtime-stub.js';
import scorer from './EVAL.js';

// What the SQL endpoint returns for the scorer's expected-report query.
const expectedRows = [
  {
    customer: 'Ada Lovelace',
    order_count: 2,
    total_cents: 41900,
    top_product: 'Keyboard',
  },
  {
    customer: 'Grace Hopper',
    order_count: 2,
    total_cents: 15600,
    top_product: 'Cable',
  },
  {
    customer: 'Linus Pauling',
    order_count: 1,
    total_cents: 66500,
    top_product: 'Monitor',
  },
];

const report = [
  {
    customer: 'Ada Lovelace',
    orderCount: 2,
    totalCents: 41900,
    topProduct: 'Keyboard',
  },
  {
    customer: 'Grace Hopper',
    orderCount: 2,
    totalCents: 15600,
    topProduct: 'Cable',
  },
  {
    customer: 'Linus Pauling',
    orderCount: 1,
    totalCents: 66500,
    topProduct: 'Monitor',
  },
];

/** A report script that uses the SDK client (the stub) and prints `value`. */
const sdkScript = (value: unknown = report) => `// Nightly sales report
import { createClient } from '@supabase/supabase-js';
if (!process.env.SPARK_PROJECT_URL || !process.env.SPARK_SECRET_KEY) process.exit(2);
createClient(process.env.SPARK_PROJECT_URL, process.env.SPARK_SECRET_KEY);
console.log(JSON.stringify(${JSON.stringify(value)}, null, 2));
`;

async function score(
  options: {
    script?: string;
    publishable?: 'denied' | 'empty' | 'rows';
  } = {}
) {
  const { publishable = 'denied' } = options;
  return failedChecks(
    await sparkScorer(
      scorer,
      (url, init, request) => {
        if (url.pathname === '/database/query')
          return Response.json(expectedRows);
        const apikey = new Headers(init?.headers ?? request?.headers).get(
          'apikey'
        );
        if (apikey !== SPARK_TEST_KEYS.publishable) return Response.json([]);
        if (publishable === 'denied')
          return Response.json(
            { message: 'permission denied: read on table customers' },
            { status: 403 }
          );
        return Response.json(
          publishable === 'empty' ? [] : [{ id: 1 }, { id: 2 }]
        );
      },
      {
        sandbox: stubSandbox({
          'app/report.mjs': options.script ?? sdkScript(),
        }),
      }
    )
  );
}

describe('relational report scorer', () => {
  it('passes every check for an SDK report with the right output and a locked-down project', async () => {
    // The script exits 2 without the project URL and secret key, so this also
    // proves the scorer sets them.
    expect(await score()).toEqual([]);
  });

  it('rejects wrong output, and a report that is not implemented or prints no JSON array', async () => {
    const name = 'report numbers match the database (per customer, sorted)';
    for (const wrong of [
      report.map((row, i) => (i === 0 ? { ...row, totalCents: 1 } : row)),
      report.map((row, i) => (i === 1 ? { ...row, orderCount: 3 } : row)),
      report.map((row, i) => (i === 2 ? { ...row, topProduct: 'Mouse' } : row)),
      [...report].reverse(),
      [
        ...report,
        {
          customer: 'Alan Turing',
          orderCount: 0,
          totalCents: 0,
          topProduct: null,
        },
      ],
    ])
      expect(await score({ script: sdkScript(wrong) })).toEqual([name]);

    const failing = [
      'report runs and prints JSON',
      'report numbers match the database (per customer, sorted)',
    ];
    expect(
      await score({
        script: `import { createClient } from '@supabase/supabase-js';\nconsole.error('not implemented');\nprocess.exit(1);\n`,
      })
    ).toEqual(failing);
    expect(
      await score({
        script: `import { createClient } from '@supabase/supabase-js';\nconsole.log('Ada ordered the most.');\n`,
      })
    ).toEqual(failing);
  });

  it('fails the lock-down check when a publishable key reads rows, passes on error or empty data', async () => {
    expect(await score({ publishable: 'rows' })).toEqual([
      'tables stay locked down (publishable key reads nothing)',
    ]);
    expect(await score({ publishable: 'denied' })).toEqual([]);
    expect(await score({ publishable: 'empty' })).toEqual([]);
  });

  it('requires a real @supabase/supabase-js import', async () => {
    const name = 'implementation uses @supabase/supabase-js';
    const printing = `console.log(JSON.stringify(${JSON.stringify(report)}));`;
    for (const script of [
      // Plain fetch against the REST API.
      `const res = await fetch(process.env.SPARK_PROJECT_URL + '/rest/v1/customers');\n${printing}\n`,
      // Commented out, or a different package with the same prefix.
      `// import { createClient } from '@supabase/supabase-js';\n${printing}\n`,
      `import { createClient } from '@supabase/supabase-js-not-real';\n${printing}\n`,
    ])
      expect(await score({ script })).toContain(name);
    expect(
      await score({
        script: `const { createClient } = await import('@supabase/supabase-js');\n${printing}\n`,
      })
    ).not.toContain(name);
  });

  it('rejects psql, raw Postgres drivers and the SQL endpoint', async () => {
    const name = 'report queries via the Data API, not raw SQL';
    for (const extra of [
      `const driver = 'pg';`,
      `const driver = "postgres";`,
      `const command = 'psql -c "select 1"';`,
      `const path = '/database/query';`,
    ])
      expect(await score({ script: `${sdkScript()}${extra}\n` })).toEqual([
        name,
      ]);
  });
});
