import { readFile, readdir, rename, writeFile } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { evalResultSchema } from "@supabase-evals/core/eval-metadata"

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const root = resolve(app, "../..")
const output = resolve(app, "src/data/braintrust-results.json")
const publicationId = "2026-10-29"
const uuid = z.uuid()
const metadataSchema = z
  .object({
    experiment: z.string(),
    expected_runs: z.number().int().positive().optional(),
    temporary_publication_id: z.string().optional(),
  })
  .passthrough()
const experimentSchema = z.object({ id: uuid, metadata: metadataSchema })
const rootSchema = z.object({
  id: z.string(),
  experiment_id: uuid,
  root_span_id: z.string(),
  input: z.string(),
  metadata: z
    .object({
      eval: z.string(),
      run: z.number().int().positive(),
      source_path: z.string(),
      interface: z.string(),
    })
    .passthrough(),
  scores: z.object({ passed: z.union([z.literal(0), z.literal(1)]) }),
  metrics: z.record(z.string(), z.number()).nullable(),
})
const childSchema = z.object({
  id: z.string(),
  experiment_id: uuid,
  root_span_id: z.string(),
  span_attributes: z.object({ name: z.enum(["passed", "task"]) }),
  output: z.unknown().optional(),
  scores: z
    .object({ passed: z.union([z.literal(0), z.literal(1)]).optional() })
    .nullable(),
  metrics: z.record(z.string(), z.number()).nullable(),
})
const usageSchema = z.object({
  experiment_id: uuid,
  root_span_id: z.string(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
})
type Experiment = z.infer<typeof experimentSchema>
type Root = z.infer<typeof rootSchema>
type Child = z.infer<typeof childSchema>
type Usage = z.infer<typeof usageSchema>
type BraintrustRequest = (
  url: string | URL,
  options?: RequestInit
) => Promise<Response>

const keyOf = (r: { experiment_id: string; root_span_id: string }) =>
  `${r.experiment_id}/${r.root_span_id}`

export function assemble(
  experiments: Experiment[],
  roots: Root[],
  children: Child[],
  usages: Usage[],
  evalIds: string[],
  allowPartial = false
) {
  if (!experiments.length || !roots.length)
    throw new Error("Publication has no results")
  const experimentMap = new Map(experiments.map((e) => [e.id, e]))
  const childMap = new Map<string, Child>()
  for (const child of children) {
    const key = `${keyOf(child)}/${child.span_attributes.name}`
    if (childMap.has(key)) throw new Error(`Duplicate child span: ${key}`)
    childMap.set(key, child)
  }
  const usageMap = new Map<string, Usage>()
  for (const usage of usages) {
    const key = keyOf(usage)
    if (usageMap.has(key)) throw new Error(`Duplicate usage: ${key}`)
    usageMap.set(key, usage)
  }
  const spanIds = new Set()
  for (const span of [...roots, ...children]) {
    const id = `${span.experiment_id}/${span.id}`
    if (spanIds.has(id)) throw new Error(`Duplicate span ID: ${id}`)
    spanIds.add(id)
  }
  const results = []
  const pairs = new Map<string, Set<number>>()
  const rootKeys = new Set()
  for (const row of roots) {
    const key = keyOf(row)
    if (rootKeys.has(key)) throw new Error(`Duplicate root span: ${key}`)
    rootKeys.add(key)
    const exp = experimentMap.get(row.experiment_id)
    const score = childMap.get(`${key}/passed`)
    const task = childMap.get(`${key}/task`)
    if (
      !exp ||
      !score ||
      !task ||
      score.scores?.passed !== row.scores.passed ||
      task.metrics?.duration === undefined
    )
      throw new Error(`Missing or inconsistent spans: ${key}`)
    const m = row.metadata,
      em = exp.metadata,
      metrics = row.metrics ?? {},
      usage = usageMap.get(key)
    const expectedPath = `benchmark/${em.experiment}/${m.eval}/run-${m.run}/result.json`
    if (m.eval_suite !== "benchmark" || m.source_path !== expectedPath)
      throw new Error(`Unexpected result path: ${m.source_path}`)
    const pair = `${em.experiment}/${m.eval}`
    const runs = pairs.get(pair) ?? new Set()
    if (runs.has(m.run)) throw new Error(`Duplicate run: ${pair}/${m.run}`)
    runs.add(m.run)
    pairs.set(pair, runs)
    const sandbox =
      metrics.sandbox_memory_mb === undefined
        ? undefined
        : {
            memory: metrics.sandbox_memory_mb,
            activeCpuDurationMs: metrics.sandbox_active_cpu_ms,
            duration: metrics.sandbox_duration_ms,
            ...(metrics.sandbox_ingress_bytes !== undefined &&
            metrics.sandbox_egress_bytes !== undefined
              ? {
                  networkTransfer: {
                    ingress: metrics.sandbox_ingress_bytes,
                    egress: metrics.sandbox_egress_bytes,
                  },
                }
              : {}),
          }
    const parsed = evalResultSchema.safeParse({
      experiment: em.experiment,
      experimentDisplay: {
        agent: em.agent,
        modelProvider: em.model_provider,
        modelId: em.model_id,
        reasoningEffort: em.reasoning_effort,
      },
      eval: m.eval,
      stage: m.stage,
      product: m.product,
      topic: m.topic,
      suite: m.eval_suite,
      interface: m.interface,
      cliVersion: m.cli_version,
      passed: row.scores.passed === 1,
      checks: score.output,
      skills: m.skills,
      docs: m.docs,
      stepCount: metrics.step_count,
      toolCallCount: metrics.tool_call_count,
      agentRunDurationMs: Math.round(task.metrics.duration * 1000),
      sandboxUsage: sandbox,
      prompt: row.input,
      promptSourcePath: `evals/benchmark/${m.eval}/PROMPT.md`,
      run: m.run,
      sourcePath: m.source_path,
      traceUsage:
        usage && usage.input_tokens !== null && usage.output_tokens !== null
          ? {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
            }
          : undefined,
    })
    if (!parsed.success)
      throw new Error(`Invalid result ${key}: ${parsed.error.message}`)
    results.push(parsed.data)
  }
  if (
    children.some((c) => !rootKeys.has(keyOf(c))) ||
    usages.some((u) => !rootKeys.has(keyOf(u)))
  )
    throw new Error("Orphaned span or usage group")
  if (!allowPartial) {
    for (const exp of experiments)
      for (const evalId of evalIds) {
        const pair = `${exp.metadata.experiment}/${evalId}`,
          runs = pairs.get(pair)
        if (
          !exp.metadata.expected_runs ||
          !runs ||
          runs.size !== exp.metadata.expected_runs ||
          Array.from(
            { length: exp.metadata.expected_runs },
            (_, i) => i + 1
          ).some((n) => !runs.has(n))
        )
          throw new Error(`Incomplete results: ${pair}`)
        pairs.delete(pair)
      }
    if (pairs.size)
      throw new Error(`Unexpected results: ${[...pairs.keys()].join(", ")}`)
  }
  return results.sort(
    (a, b) =>
      a.experiment.localeCompare(b.experiment) ||
      a.eval.localeCompare(b.eval) ||
      (a.run ?? 0) - (b.run ?? 0)
  )
}

export async function query<T>(
  request: BraintrustRequest,
  sql: string,
  schema: z.ZodType<T>,
  paginate = true
) {
  let cursor: string | null = null
  const rows: T[] = []
  const seen = new Set<string>()
  do {
    const response = await request("https://api.braintrust.dev/btql", {
      method: "POST",
      body: JSON.stringify({
        query:
          sql + (cursor ? ` OFFSET '${cursor.replaceAll("'", "''")}'` : ""),
        fmt: "json",
      }),
    })
    const page = z
      .object({ data: z.array(schema) })
      .parse(await response.json()).data
    rows.push(...page)
    cursor = paginate
      ? (response.headers.get("x-bt-cursor") ??
        response.headers.get("x-amz-meta-bt_cursor"))
      : null
    if (cursor && seen.has(cursor))
      throw new Error("Braintrust returned a repeated cursor")
    if (cursor) seen.add(cursor)
  } while (cursor)
  return rows
}

const from = (ids: string[]) =>
  `FROM experiment(${ids.map((id) => `'${id}'`).join(", ")})`

export async function fetchUsage(
  request: BraintrustRequest,
  experiments: Experiment[],
  roots: Root[]
) {
  const usages: Usage[] = []
  let batch: string[] = []
  let size = 0
  async function fetchBatch() {
    if (!batch.length) return
    const limit = size + 1
    const rows = await query(
      request,
      `SELECT experiment_id, root_span_id, sum(metrics.prompt_tokens) AS input_tokens, sum(metrics.completion_tokens) AS output_tokens ${from(batch)} WHERE span_attributes.type = 'llm' AND span_attributes.purpose IS NULL GROUP BY experiment_id, root_span_id LIMIT ${limit}`,
      usageSchema,
      false
    )
    if (rows.length >= limit)
      throw new Error("Usage aggregate reached its limit")
    usages.push(...rows)
    batch = []
    size = 0
  }
  for (const exp of experiments) {
    const count = roots.filter((r) => r.experiment_id === exp.id).length
    if (count > 999) {
      await fetchBatch()
      const llmSchema = z.object({
        id: z.string(),
        experiment_id: uuid,
        root_span_id: z.string(),
        metrics: z.record(z.string(), z.number()).nullable(),
      })
      const spans = await query(
        request,
        `SELECT id, experiment_id, root_span_id, metrics ${from([exp.id])} WHERE span_attributes.type = 'llm' AND span_attributes.purpose IS NULL ORDER BY _pagination_key DESC LIMIT 1000`,
        llmSchema
      )
      const groups = new Map<string, Usage>()
      const seenIds = new Set<string>()
      for (const span of spans) {
        if (seenIds.has(span.id))
          throw new Error(`Duplicate LLM span: ${span.id}`)
        seenIds.add(span.id)
        const key = keyOf(span),
          group = groups.get(key) ?? {
            experiment_id: span.experiment_id,
            root_span_id: span.root_span_id,
            input_tokens: null,
            output_tokens: null,
          }
        if (span.metrics?.prompt_tokens !== undefined)
          group.input_tokens =
            (group.input_tokens ?? 0) + span.metrics.prompt_tokens
        if (span.metrics?.completion_tokens !== undefined)
          group.output_tokens =
            (group.output_tokens ?? 0) + span.metrics.completion_tokens
        groups.set(key, group)
      }
      usages.push(...groups.values())
      continue
    }
    if (size + count > 999) await fetchBatch()
    batch.push(exp.id)
    size += count
  }
  await fetchBatch()
  return usages
}

async function main() {
  const allowPartial = process.env.EVALS_ALLOW_PARTIAL === "1"
  if (allowPartial && !process.argv.includes("--dev"))
    throw new Error("EVALS_ALLOW_PARTIAL is only supported by pnpm web")
  if (process.env.VERCEL_ENV === "preview" && !process.env.BRAINTRUST_API_KEY) {
    await writeFile(
      output,
      await readFile(resolve(app, "src/data/eval-results.json"))
    )
    console.log("Using benchmark fixture")
    return
  }
  const startedAt = performance.now()
  console.log(`Loading Braintrust publication ${publicationId}...`)
  const apiKey = process.env.BRAINTRUST_API_KEY,
    projectId = process.env.BRAINTRUST_PROJECT_ID
  if (!apiKey || !projectId)
    throw new Error(
      "Set BRAINTRUST_API_KEY and BRAINTRUST_PROJECT_ID in the repository .env"
    )
  uuid.parse(projectId)
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  }
  async function request(url: string | URL, options: RequestInit = {}) {
    const response = await fetch(url, {
      ...options,
      headers,
      signal: AbortSignal.timeout(30000),
    })
    if (!response.ok)
      throw new Error(
        `Braintrust request failed: ${response.status} ${response.statusText}`
      )
    return response
  }
  const experiments: Experiment[] = []
  let after: string | undefined
  do {
    const url = new URL("https://api.braintrust.dev/v1/experiment")
    url.searchParams.set("project_id", projectId)
    url.searchParams.set("limit", "1000")
    if (after) url.searchParams.set("starting_after", after)
    const data = z
      .object({
        objects: z.array(
          z.object({
            id: uuid,
            metadata: z
              .object({ temporary_publication_id: z.string().optional() })
              .passthrough()
              .nullable(),
          })
        ),
      })
      .parse(await (await request(url)).json())
    for (const e of data.objects)
      if (e.metadata?.temporary_publication_id === publicationId)
        experiments.push(experimentSchema.parse(e))
    after = data.objects.length === 1000 ? data.objects.at(-1)?.id : undefined
  } while (after)
  const experimentNames = (
    await readdir(resolve(root, "experiments/benchmark"))
  )
    .filter((f) => f.endsWith(".experiment.ts"))
    .map((f) => f.slice(0, -".experiment.ts".length))
    .sort()
  const selectedNames = experiments.map((e) => e.metadata.experiment).sort()
  if (
    !allowPartial &&
    JSON.stringify(experimentNames) !== JSON.stringify(selectedNames)
  )
    throw new Error(
      `Pinned experiments do not match active benchmark experiments: ${selectedNames.join(", ")}`
    )
  const evalIds = []
  for (const dir of await readdir(resolve(root, "evals/benchmark"), {
    withFileTypes: true,
  }))
    if (
      dir.isDirectory() &&
      !dir.name.startsWith(".") &&
      !dir.name.startsWith("_")
    ) {
      try {
        await readFile(resolve(root, "evals/benchmark", dir.name, "PROMPT.md"))
        evalIds.push(dir.name)
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error
      }
    }
  if (!evalIds.length) throw new Error("No benchmark evals found")
  const source = from(experiments.map((e) => e.id))
  const roots = await query(
    request,
    `SELECT id, experiment_id, root_span_id, input, metadata, scores, metrics ${source} WHERE is_root = true ORDER BY _pagination_key DESC LIMIT 1000`,
    rootSchema
  )
  const children = await query(
    request,
    `SELECT id, experiment_id, root_span_id, span_attributes, CASE WHEN span_attributes.name = 'passed' THEN output ELSE NULL END AS output, scores, metrics ${source} WHERE (span_attributes.type = 'score' AND span_attributes.name = 'passed') OR (span_attributes.type = 'task' AND span_attributes.name = 'task') ORDER BY _pagination_key DESC LIMIT 1000`,
    childSchema
  )
  const usages = await fetchUsage(request, experiments, roots)
  const results = assemble(
    experiments,
    roots,
    children,
    usages,
    evalIds,
    allowPartial
  )
  if (allowPartial)
    console.log("Partial benchmark results allowed for local development")
  const temp = `${output}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(results, null, 2)}\n`)
  await rename(temp, output)
  console.log(
    `Loaded ${results.length} results from Braintrust publication ${publicationId} in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`
  )
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(
      `Braintrust results: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  })
