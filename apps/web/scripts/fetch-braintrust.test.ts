import { test } from "vitest"
import assert from "node:assert/strict"
import { assemble, fetchExperiments } from "./fetch-braintrust.ts"

const id = "63331944-8a8c-4396-8add-d6fbe88f80d3"
const experiment: Parameters<typeof assemble>[0][number] = {
  id,
  metadata: {
    experiment: "example",
    expected_runs: 1,
    agent: "codex",
    model_provider: "openai",
    model_id: "gpt-6.1-sol",
  },
}
const root: Parameters<typeof assemble>[1][number] = {
  id: "root",
  experiment_id: id,
  root_span_id: "trace",
  input: "Prompt",
  metadata: {
    eval: "example-eval",
    run: 1,
    source_path: "benchmark/example/example-eval/run-1/result.json",
    interface: "mcp",
    eval_suite: "benchmark",
  },
  scores: { passed: 0 },
  metrics: {},
}
const score: Parameters<typeof assemble>[2][number] = {
  id: "score",
  experiment_id: id,
  root_span_id: "trace",
  span_attributes: { name: "passed" },
  scores: { passed: 0 },
  output: [{ name: "check", passed: false }],
  metrics: {},
}
const task: Parameters<typeof assemble>[2][number] = {
  id: "task",
  experiment_id: id,
  root_span_id: "trace",
  span_attributes: { name: "task" },
  scores: null,
  metrics: { duration: 1.25 },
}
const usage: Parameters<typeof assemble>[3][number] = {
  experiment_id: id,
  root_span_id: "trace",
  input_tokens: 12,
  output_tokens: 3,
}
const make = (roots = [root], children = [score, task], usages = [usage]) =>
  assemble([experiment], roots, children, usages, ["example-eval"])

test("joins failed runs, scorer checks, task duration, and trace usage", () => {
  const [result] = make()
  assert.equal(result.passed, false)
  assert.deepEqual(result.checks, score.output)
  assert.equal(result.agentRunDurationMs, 1250)
  assert.deepEqual(result.traceUsage, { inputTokens: 12, outputTokens: 3 })
})
test("rejects missing, duplicate, and orphaned spans and incomplete sample sets", () => {
  assert.throws(() => make([root], [score]), /Missing or inconsistent/)
  assert.throws(() => make([root], [score, score, task]), /Duplicate child/)
  assert.throws(
    () => make([root], [score, task], [{ ...usage, root_span_id: "other" }]),
    /Orphaned/
  )
  assert.throws(() => make([]), /no results/)
})
test("keeps unavailable usage absent", () => {
  assert.equal(
    make([root], [score, task], [{ ...usage, input_tokens: null }])[0]
      .traceUsage,
    undefined
  )
})

test("follows response cursors and rejects repeated cursors", async () => {
  const { query } = await import("./fetch-braintrust.ts")
  const { z } = await import("zod")
  const calls: string[] = []
  const request = async (_url: string | URL, options?: RequestInit) => {
    calls.push(JSON.parse(String(options?.body)).query)
    const headers = new Headers()
    if (calls.length === 1) headers.set("x-bt-cursor", "next")
    return new Response(JSON.stringify({ data: [calls.length] }), { headers })
  }
  assert.deepEqual(await query(request, "SELECT x LIMIT 1", z.number()), [1, 2])
  assert.match(calls[1], /OFFSET 'next'/)
  const repeated = async () =>
    new Response(JSON.stringify({ data: [] }), {
      headers: { "x-bt-cursor": "same" },
    })
  await assert.rejects(
    query(repeated, "SELECT x", z.number()),
    /repeated cursor/
  )
})

test("bounds aggregate batches and pages a large experiment", async () => {
  const { fetchUsage } = await import("./fetch-braintrust.ts")
  const second = "d2e33ddc-64f1-4392-892c-d4db9f3d0146"
  const experiments = [experiment, { ...experiment, id: second }]
  const roots = [
    ...Array.from({ length: 999 }, () => ({ ...root, experiment_id: id })),
    { ...root, experiment_id: second },
  ]
  const calls: string[] = []
  const request = async (_url: string | URL, options?: RequestInit) => {
    calls.push(JSON.parse(String(options?.body)).query)
    return new Response(JSON.stringify({ data: [] }))
  }
  await fetchUsage(request, experiments, roots)
  assert.equal(calls.length, 2)
  assert.match(calls[0], /LIMIT 1000$/)
  assert.match(calls[1], /LIMIT 2$/)
  calls.length = 0
  await fetchUsage(
    request,
    [experiment],
    Array.from({ length: 1000 }, () => ({ ...root, experiment_id: id }))
  )
  assert.equal(calls.length, 1)
  assert.match(calls[0], /SELECT id, experiment_id, root_span_id, metrics/)
  assert.match(calls[0], /ORDER BY _pagination_key DESC LIMIT 1000$/)
})

test("allows partial publications only when requested", () => {
  const partial = {
    ...experiment,
    metadata: { ...experiment.metadata, expected_runs: undefined },
  }
  assert.throws(
    () =>
      assemble(
        [partial],
        [root],
        [score, task],
        [usage],
        ["example-eval", "another-eval"]
      ),
    /Incomplete/
  )
  const results = assemble(
    [partial],
    [root],
    [score, task],
    [usage],
    ["example-eval", "another-eval"],
    true
  )
  assert.equal(results.length, 1)
  assert.throws(() => assemble([partial], [], [], [], [], true), /no results/)
  assert.throws(
    () => assemble([partial], [root], [score], [], [], true),
    /Missing or inconsistent/
  )
  assert.throws(
    () => assemble([partial], [root, root], [score, task], [], [], true),
    /Duplicate/
  )
})

test("identifies invalid results", () => {
  assert.throws(
    () => make([{ ...root, metadata: { ...root.metadata, stage: "invalid" } }]),
    /Invalid result .*\/trace/
  )
})

test("fetches only pinned experiments and validates their identities", async () => {
  const secondId = "d2e33ddc-64f1-4392-892c-d4db9f3d0146"
  const pinned = { example: id, second: secondId }
  const projectId = "448cc19e-afdf-4e96-b92a-6e02522603a0"
  let requested: URL | undefined
  const request = async (url: string | URL) => {
    requested = new URL(url)
    return Response.json({
      objects: [
        {
          ...experiment,
          id: secondId,
          metadata: { ...experiment.metadata, experiment: "second" },
        },
        experiment,
      ],
    })
  }
  const result = await fetchExperiments(request, projectId, pinned)
  assert.equal(result.length, 2)
  assert.deepEqual(requested?.searchParams.getAll("ids"), [id, secondId])
  assert.equal(requested?.searchParams.get("project_id"), projectId)
  await assert.rejects(
    fetchExperiments(
      async () => Response.json({ objects: [experiment] }),
      projectId,
      pinned
    ),
    /Missing pinned experiments: second/
  )
  await assert.rejects(
    fetchExperiments(
      async () =>
        Response.json({
          objects: [
            {
              ...experiment,
              metadata: { ...experiment.metadata, experiment: "wrong" },
            },
          ],
        }),
      projectId,
      { example: id }
    ),
    /Unexpected experiment/
  )
  await assert.rejects(
    fetchExperiments(request, projectId, { example: id, second: id }),
    /distinct/
  )
})
