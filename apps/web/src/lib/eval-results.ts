import { z } from "zod"
import {
  evalResultSchema,
  type EvalResult,
} from "@supabase-evals/core/eval-metadata"
import rawResults from "@/data/eval-results.json"

/**
 * The exported eval results and the queries the site runs over them. Everything
 * here is plain data: no React, no formatting, no class names.
 */

/** The Supabase developer journey. Every eval is filed under one stage. */
export const JOURNEY_STAGES = [
  {
    id: "build",
    label: "Build",
    description:
      "Tests whether an agent can write strong Supabase code, either directly with tools or through project evals that connect Supabase to a front end.",
  },
  {
    id: "deploy",
    label: "Deploy",
    description:
      "Will measure how well an agent follows Supabase deployment patterns, including declarative schemas and CLI workflows.",
  },
  {
    id: "investigate",
    label: "Investigate",
    description:
      "Tests whether an agent can gather project context, interpret observability data, and identify the underlying issue.",
  },
  {
    id: "resolve",
    label: "Resolve",
    description:
      "Tests whether an agent can turn detected issues into a solution, either by changing project code or using tools such as database.query.",
  },
] as const

export type JourneyStage = (typeof JOURNEY_STAGES)[number]["id"]

/** Bucket key for runs whose eval declares no product. */
export const UNASSIGNED_PRODUCT = "__unassigned_product__"

export const EXPERIMENT_SUITES = ["benchmark", "no-skills"] as const

export type ExperimentSuite = (typeof EXPERIMENT_SUITES)[number]

export const EXPERIMENT_SUITE_LABELS = {
  benchmark: "Benchmark",
  "no-skills": "Without skills",
} satisfies Record<ExperimentSuite, string>

export type ExperimentDisplay = NonNullable<EvalResult["experimentDisplay"]>

/** An exported result with its optional list fields filled in and its stage validated. */
export type ParsedResult = Omit<EvalResult, "product" | "topic"> & {
  category: JourneyStage | "unknown"
  product: string[]
  topic: string[]
  primaryCategory: string
}

export type CheckResult = NonNullable<ParsedResult["checks"]>[number]
export type DocsCall = NonNullable<ParsedResult["docs"]>["calls"][number]

const stageIndex = new Map<string, number>(
  JOURNEY_STAGES.map((stage, index) => [stage.id, index])
)

function parseResult(result: EvalResult): ParsedResult {
  const category = result.stage ?? "unknown"
  const isKnownStage = JOURNEY_STAGES.some((stage) => stage.id === category)
  const product = result.product ?? []
  const topic = result.topic ?? []

  return {
    ...result,
    category: isKnownStage ? (category as JourneyStage) : "unknown",
    product,
    topic,
    primaryCategory: topic[0] ?? "uncategorized",
  }
}

/** Canonical order: journey stage, then topic, then eval id. */
export function sortResults(a: ParsedResult, b: ParsedResult) {
  const categoryDelta =
    (stageIndex.get(a.category) ?? Number.MAX_SAFE_INTEGER) -
    (stageIndex.get(b.category) ?? Number.MAX_SAFE_INTEGER)

  return (
    categoryDelta ||
    a.primaryCategory.localeCompare(b.primaryCategory) ||
    a.eval.localeCompare(b.eval)
  )
}

/** Every exported run, in canonical order. Parsed once at import. */
export const sortedResults: ParsedResult[] = z
  .array(evalResultSchema)
  .parse(rawResults)
  .map(parseResult)
  .sort(sortResults)

export function getVisibleExperiments(sourceResults: ParsedResult[]) {
  return Array.from(
    new Set(sourceResults.map((result) => result.experiment))
  ).sort((a, b) => a.localeCompare(b))
}

export function getExperimentDisplay(experiment: string) {
  return sortedResults.find((result) => result.experiment === experiment)
    ?.experimentDisplay
}

export function getExperimentResults(
  experiment: string,
  sourceResults = sortedResults
) {
  return sourceResults.filter((result) => result.experiment === experiment)
}

export function getProductKeys(sourceResults: ParsedResult[]) {
  const keys = new Set<string>()

  for (const result of sourceResults) {
    if (result.product.length) {
      result.product.forEach((product) => keys.add(product))
    } else {
      keys.add(UNASSIGNED_PRODUCT)
    }
  }

  return Array.from(keys).sort((a, b) => {
    if (a === UNASSIGNED_PRODUCT) return 1
    if (b === UNASSIGNED_PRODUCT) return -1
    return a.localeCompare(b)
  })
}

export function getProductResults(
  product: string,
  sourceResults: ParsedResult[]
) {
  return sourceResults.filter((result) =>
    product === UNASSIGNED_PRODUCT
      ? result.product.length === 0
      : result.product.includes(product)
  )
}

export function getStageResults(
  category: JourneyStage,
  sourceResults: ParsedResult[]
) {
  return sourceResults.filter((result) => result.category === category)
}

export function getEvalResults(evalId: string, sourceResults: ParsedResult[]) {
  return sourceResults.filter((result) => result.eval === evalId)
}

/** Eval ids in the canonical order of `sourceResults` (journey stage, then topic, then id). */
export function getEvalIds(sourceResults: ParsedResult[]) {
  return Array.from(new Set(sourceResults.map((result) => result.eval)))
}

export function scoreResults(sourceResults: ParsedResult[]) {
  const passed = sourceResults.filter((result) => result.passed).length

  return {
    passed,
    total: sourceResults.length,
  }
}

/**
 * Total tokens a run consumed: the harness's own total when it reported one,
 * else input + output (input already includes cache reads across harnesses).
 */
export function runTokens(result: ParsedResult): number | undefined {
  const usage = result.usage
  if (!usage) return undefined
  if (usage.totalTokens !== undefined) return usage.totalTokens
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return undefined
  }
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
}
