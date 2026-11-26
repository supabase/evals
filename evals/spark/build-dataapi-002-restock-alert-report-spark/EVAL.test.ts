import { describe, expect, it } from 'vitest';
import {
  SPARK_TEST_KEYS,
  failedChecks,
  sparkScorer,
  stubSandbox,
} from '../../../experiments/spark/lib/runtime-stub.js';
import scorer from './EVAL.js';

// What the SQL endpoint returns for the scorer's expected-alerts query.
const expectedRows = [
  {
    warehouse: 'North DC',
    product: 'Gizmo',
    quantity: 3,
    reorder_threshold: 10,
    supplier_email: 'acme@example.com',
  },
  {
    warehouse: 'North DC',
    product: 'Widget',
    quantity: 5,
    reorder_threshold: 20,
    supplier_email: 'acme@example.com',
  },
  {
    warehouse: 'South DC',
    product: 'Gadget',
    quantity: 2,
    reorder_threshold: 15,
    supplier_email: 'parts@example.com',
  },
  {
    warehouse: 'West DC',
    product: 'Gadget',
    quantity: 0,
    reorder_threshold: 15,
    supplier_email: 'parts@example.com',
  },
];

const report = [
  {
    warehouse: 'North DC',
    product: 'Gizmo',
    quantity: 3,
    reorderThreshold: 10,
    supplierEmail: 'acme@example.com',
  },
  {
    warehouse: 'North DC',
    product: 'Widget',
    quantity: 5,
    reorderThreshold: 20,
    supplierEmail: 'acme@example.com',
  },
  {
    warehouse: 'South DC',
    product: 'Gadget',
    quantity: 2,
    reorderThreshold: 15,
    supplierEmail: 'parts@example.com',
  },
  {
    warehouse: 'West DC',
    product: 'Gadget',
    quantity: 0,
    reorderThreshold: 15,
    supplierEmail: 'parts@example.com',
  },
];

/** A report script that uses the SDK client (the stub) and prints `value`. */
const sdkScript = (value: unknown = report) => `// Restock alert worker
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
            { message: 'permission denied: read on table inventory' },
            { status: 403 }
          );
        return Response.json(
          publishable === 'empty' ? [] : [{ id: 1 }, { id: 2 }]
        );
      },
      {
        sandbox: stubSandbox({
          'app/restock.mjs': options.script ?? sdkScript(),
        }),
      }
    )
  );
}

describe('restock alert scorer', () => {
  it('passes every check for an SDK report with the right output and a locked-down project', async () => {
    // The script exits 2 without the project URL and secret key, so this also
    // proves the scorer sets them.
    expect(await score()).toEqual([]);
  });

  it('rejects wrong output, and a report that is not implemented or prints no JSON array', async () => {
    const name = 'alerts match the database (below threshold, sorted)';
    for (const wrong of [
      report.map((row, i) => (i === 0 ? { ...row, quantity: 4 } : row)),
      report.map((row, i) => (i === 1 ? { ...row, supplierEmail: 'x' } : row)),
      [...report].reverse(),
      // West DC's Widget sits exactly at its threshold: not strictly below.
      [
        ...report,
        {
          warehouse: 'West DC',
          product: 'Widget',
          quantity: 20,
          reorderThreshold: 20,
          supplierEmail: 'acme@example.com',
        },
      ],
      report.slice(1),
    ])
      expect(await score({ script: sdkScript(wrong) })).toEqual([name]);

    const failing = [
      'report runs and prints JSON',
      'alerts match the database (below threshold, sorted)',
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
      `const res = await fetch(process.env.SPARK_PROJECT_URL + '/rest/v1/inventory');\n${printing}\n`,
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
