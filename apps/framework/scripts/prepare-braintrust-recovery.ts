import { globSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const rowSchema = z.object({
  suite: identifier,
  experiment: identifier,
  eval: identifier,
  run: z.number().int().positive(),
  passed: z.boolean(),
});
type Row = z.infer<typeof rowSchema>;

export function samples(rows: Row[], expectedRuns: number) {
  const result = new Map<string, boolean>();
  const byEval = new Map<string, Set<number>>();
  for (const row of rows) {
    const runs = byEval.get(row.eval) ?? new Set<number>();
    if (runs.has(row.run))
      throw new Error(`Duplicate result: ${row.eval} run ${row.run}`);
    runs.add(row.run);
    byEval.set(row.eval, runs);
    result.set(`${row.eval}\t${row.run}`, row.passed);
  }
  if (
    !byEval.size ||
    [...byEval.values()].some(
      (runs) =>
        runs.size !== expectedRuns ||
        [...runs].some((run) => run > expectedRuns)
    )
  )
    throw new Error('Artifact contains incomplete sample sets');
  return result;
}

const experimentSchema = z.object({
  id: z.string().uuid(),
  metadata: z
    .object({
      suite: z.string(),
      experiment: z.string(),
      ci_run_url: z.string(),
      expected_runs: z.number().int().positive(),
    })
    .passthrough(),
});
const rootsSchema = z.object({
  data: z.array(
    z.object({
      eval: z.string(),
      run: z.number().int().positive(),
      passed: z.union([z.literal(0), z.literal(1)]),
    })
  ),
});

export async function prepareRecovery(env: NodeJS.ProcessEnv, request = fetch) {
  const {
    RECOVERY_RUN_ID: runId,
    BRAINTRUST_API_KEY: token,
    BRAINTRUST_PROJECT_ID: project,
    GITHUB_SERVER_URL: server,
    GITHUB_REPOSITORY: repository,
  } = env;
  if (
    !runId ||
    !/^\d+$/.test(runId) ||
    !token ||
    !project ||
    !server ||
    !repository
  )
    throw new Error('Missing or invalid recovery configuration');
  const ciUrl = `${server}/${repository}/actions/runs/${runId}`;
  const groups = new Map<string, Row[]>();
  for (const path of globSync(
    'recovery-artifact/raw-results-*/*/run-*/result.json'
  )) {
    const row = rowSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (
      path !==
      `recovery-artifact/raw-results-${row.suite}__${row.experiment}__${row.eval}/${row.eval}/run-${row.run}/result.json`
    )
      throw new Error(`Result does not match its artifact path: ${path}`);
    const key = `${row.suite}\t${row.experiment}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  if (!groups.size) throw new Error('No raw results found in artifact');

  async function get(url: string, body?: object) {
    const response = await request(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(`Braintrust request failed: ${response.status}`);
    return { data: await response.json(), headers: response.headers };
  }

  const experiments = new Map<string, z.infer<typeof experimentSchema>>();
  let after: string | undefined;
  for (;;) {
    const params = new URLSearchParams({ project_id: project, limit: '1000' });
    if (after) params.set('starting_after', after);
    const { data } = await get(
      `https://api.braintrust.dev/v1/experiment?${params}`
    );
    const page = z
      .object({
        objects: z.array(
          z.object({ id: z.string(), metadata: z.unknown().optional() })
        ),
      })
      .parse(data).objects;
    if (!page.length) break;
    for (const item of page) {
      const metadata = z
        .object({ ci_run_url: z.string().optional() })
        .passthrough()
        .safeParse(item.metadata);
      if (!metadata.success || metadata.data.ci_run_url !== ciUrl) continue;
      const experiment = experimentSchema.parse(item);
      const key = `${experiment.metadata.suite}\t${experiment.metadata.experiment}`;
      if (experiments.has(key))
        throw new Error(`Multiple original experiments match ${key}`);
      experiments.set(key, experiment);
    }
    after = page.at(-1)?.id;
  }
  if (
    experiments.size !== groups.size ||
    [...groups.keys()].some((key) => !experiments.has(key))
  )
    throw new Error('Artifact and Braintrust experiment sets differ');

  const plan: string[] = [];
  for (const [key, rows] of [...groups].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const experiment = experiments.get(key);
    if (!experiment) throw new Error(`Missing experiment: ${key}`);
    const wanted = samples(rows, experiment.metadata.expected_runs);
    const found = new Map<string, boolean>();
    let cursor: string | null = null;
    for (;;) {
      let query = `SELECT metadata.eval AS eval, metadata.run AS run, scores.passed AS passed FROM experiment('${experiment.id}') WHERE is_root = true LIMIT 1000`;
      if (cursor) query += ` OFFSET '${cursor}'`;
      const { data, headers } = await get('https://api.braintrust.dev/btql', {
        query,
        fmt: 'json',
      });
      const page = rootsSchema.parse(data).data;
      for (const row of page) {
        const rootKey = `${row.eval}\t${row.run}`;
        if (found.has(rootKey))
          throw new Error(`${key} contains duplicate results`);
        found.set(rootKey, Boolean(row.passed));
      }
      cursor =
        headers.get('x-bt-cursor') ?? headers.get('x-amz-meta-bt_cursor');
      if (!cursor || !page.length) break;
    }
    if (found.size) {
      if (
        found.size !== wanted.size ||
        [...wanted].some(([id, passed]) => found.get(id) !== passed)
      )
        throw new Error(
          `${key} contains partial or conflicting results; inspect before recovery`
        );
      console.error(`Skipping ${key}: all ${found.size} roots already exist`);
    } else {
      plan.push(
        `${key}\t${experiment.id}\t${experiment.metadata.expected_runs}\t${wanted.size}`
      );
    }
  }
  return plan;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.env.GITHUB_WORKSPACE) process.chdir(process.env.GITHUB_WORKSPACE);
  const plan = await prepareRecovery(process.env);
  if (plan.length) console.log(plan.join('\n'));
}
