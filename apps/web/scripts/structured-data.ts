import { execFileSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { Plugin } from "vite"

/**
 * Injects JSON-LD for the leaderboard into the built `index.html`.
 *
 * The graph is generated from the committed results at build time because
 * automation rewrites those results daily, so anything hand-written here would
 * go stale. Everything below is derived from the file: no invented numbers.
 */

/** The page is served at supabase.com/evals, not at the vercel.app origin. */
const CANONICAL_URL = "https://supabase.com/evals"
const ORGANIZATION_ID = "https://supabase.com/#organization"
const RESULTS_RAW_URL =
  "https://raw.githubusercontent.com/supabase/evals/main/apps/web/src/data/eval-results.json"
const DESCRIPTION =
  "See how agents perform on real Supabase tasks in our open-source benchmark for AI coding agents."

type RawResult = {
  experiment?: string
  eval?: string
  stage?: string
  product?: string[]
  topic?: string[]
  passed?: boolean
  checks?: unknown[]
  skills?: unknown
  docs?: unknown
}

type PropertyValue = {
  "@type": "PropertyValue"
  name: string
  description: string
  value?: number
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function unique(values: string[]) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))
}

function readResults(resultsFile: string): RawResult[] {
  const parsed: unknown = JSON.parse(readFileSync(resultsFile, "utf8"))

  return Array.isArray(parsed) ? (parsed as RawResult[]) : []
}

/**
 * The results carry no date, so use the commit that last touched them. Neither
 * lookup may throw: this runs inside the Vercel build.
 */
function getDateModified(resultsFile: string) {
  try {
    const lastCommitted = execFileSync(
      "git",
      ["log", "-1", "--format=%cI", "--", resultsFile],
      {
        cwd: path.dirname(resultsFile),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    ).trim()

    if (lastCommitted) {
      return lastCommitted
    }
  } catch {
    // No git available (or no history for the file): fall back to the mtime.
  }

  try {
    return statSync(resultsFile).mtime.toISOString()
  } catch {
    return undefined
  }
}

function buildVariableMeasured(results: RawResult[]) {
  const totalChecks = results.reduce(
    (total, result) => total + (result.checks?.length ?? 0),
    0
  )
  const variables: PropertyValue[] = [
    {
      "@type": "PropertyValue",
      name: "passed",
      description:
        "Whether an agent run satisfied every check in its eval, recorded per run.",
      value: results.filter((result) => result.passed === true).length,
    },
  ]

  if (totalChecks) {
    variables.push({
      "@type": "PropertyValue",
      name: "checks",
      description:
        "Individual assertions recorded as passed or failed within each run.",
      value: totalChecks,
    })
  }

  if (results.some((result) => result.skills)) {
    variables.push({
      "@type": "PropertyValue",
      name: "skills",
      description:
        "Which Supabase agent skills were available to and loaded by the run.",
    })
  }

  if (results.some((result) => result.docs)) {
    variables.push({
      "@type": "PropertyValue",
      name: "docs",
      description: "The documentation lookups the agent made during the run.",
    })
  }

  return variables
}

function buildGraph(resultsFile: string) {
  const results = readResults(resultsFile)
  const evals = unique(
    results.map((result) => result.eval).filter(isNonEmptyString)
  )
  const experiments = unique(
    results.map((result) => result.experiment).filter(isNonEmptyString)
  )
  const stages = unique(
    results.map((result) => result.stage).filter(isNonEmptyString)
  )
  const products = unique(results.flatMap((result) => result.product ?? []))
  const topics = unique(results.flatMap((result) => result.topic ?? []))
  const dateModified = getDateModified(resultsFile)

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Dataset",
        "@id": `${CANONICAL_URL}#dataset`,
        name: "Supabase Evals results",
        description: `${DESCRIPTION} ${results.length} recorded runs of ${evals.length} evals across ${experiments.length} agent experiments.`,
        url: CANONICAL_URL,
        inLanguage: "en",
        isAccessibleForFree: true,
        license: "https://www.apache.org/licenses/LICENSE-2.0",
        ...(dateModified ? { dateModified } : {}),
        keywords: [...stages, ...products, ...topics],
        size: {
          "@type": "QuantitativeValue",
          value: results.length,
          unitText: "eval runs",
        },
        variableMeasured: buildVariableMeasured(results),
        distribution: {
          "@type": "DataDownload",
          name: "eval-results.json",
          encodingFormat: "application/json",
          contentUrl: RESULTS_RAW_URL,
        },
        creator: {
          "@type": "Organization",
          "@id": ORGANIZATION_ID,
          name: "Supabase",
          url: "https://supabase.com",
        },
      },
      {
        "@type": "WebSite",
        "@id": `${CANONICAL_URL}#website`,
        name: "Supabase Evals",
        description: DESCRIPTION,
        url: CANONICAL_URL,
        inLanguage: "en",
        publisher: { "@id": ORGANIZATION_ID },
        mainEntity: { "@id": `${CANONICAL_URL}#dataset` },
      },
    ],
  }
}

/** `<` keeps a `</script>` inside any string from closing the tag early. */
function serialize(graph: unknown) {
  return JSON.stringify(graph).replace(/</g, "\\u003c")
}

export function structuredData({
  resultsFile,
}: {
  resultsFile: string
}): Plugin {
  let isSsrBuild = false

  return {
    name: "supabase-evals-structured-data",
    configResolved(config) {
      isSsrBuild = Boolean(config.build.ssr)
    },
    transformIndexHtml: {
      order: "post",
      handler(html) {
        if (isSsrBuild) {
          return html
        }

        return {
          html,
          tags: [
            {
              tag: "script",
              attrs: { type: "application/ld+json" },
              children: serialize(buildGraph(resultsFile)),
              injectTo: "head",
            },
          ],
        }
      },
    },
  }
}
