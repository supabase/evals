import { renderToString } from "react-dom/server"

import { DIMENSIONS } from "@/lib/dimensions"
import { getSuiteResults } from "@/lib/eval-results"
import { resultsQueryParsers } from "@/lib/url-state"

import { Root } from "./root.tsx"

/**
 * Data rows the default view puts in the table body: one per key of the
 * default group-by axis over the default experiment suite. Derived from the
 * app's own defaults so `scripts/prerender.ts` can assert an exact count
 * without restating how the table is grouped.
 */
export const expectedTableRows = DIMENSIONS[
  resultsQueryParsers.groupBy.defaultValue
].keys(getSuiteResults(resultsQueryParsers.experimentSuite.defaultValue)).length

/** Entry for the `dist-ssr` bundle that `scripts/prerender.ts` renders. */
export function render() {
  return renderToString(<Root />)
}
