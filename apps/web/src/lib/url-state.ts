import {
  createParser,
  parseAsString,
  parseAsStringLiteral,
  type UrlKeys,
} from "nuqs"

import { GROUP_BY_OPTIONS } from "@/lib/dimensions"
import type { ExperimentSuite } from "@/lib/eval-results"

/**
 * The URL uses "with" and "without" because those are the choices users see,
 * while the data layer keeps its existing experiment-suite names.
 */
const experimentSuiteParser = createParser<ExperimentSuite>({
  parse: (value) => {
    if (value === "with" || value === "benchmark") return "benchmark"
    if (value === "without" || value === "no-skills") return "no-skills"
    return null
  },
  serialize: (value) => (value === "benchmark" ? "with" : "without"),
})

export const resultsQueryParsers = {
  groupBy: parseAsStringLiteral(GROUP_BY_OPTIONS).withDefault("model"),
  experimentSuite: experimentSuiteParser.withDefault("benchmark"),
}

export const resultsQueryKeys = {
  groupBy: "group",
  experimentSuite: "skills",
} satisfies UrlKeys<typeof resultsQueryParsers>

export const selectionQueryParsers = {
  dimension: parseAsStringLiteral(GROUP_BY_OPTIONS),
  key: parseAsString,
  run: parseAsString,
}

export const selectionQueryKeys = {
  dimension: "sheet",
  key: "item",
  run: "run",
} satisfies UrlKeys<typeof selectionQueryParsers>

/**
 * The trace viewer overlay. Set to an eval id to open that run's span tree
 * (lazily fetched from /data/traces/<evalId>.json); empty clears the overlay.
 */
export const traceEvalParser = parseAsString.withDefault("")
export const TRACE_EVAL_QUERY_KEY = "trace"
