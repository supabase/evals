import path from "path"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import type { EvalResult, AssertionResult } from "@supabase-evals/core"
import { parseEvalMarkdown } from "../../packages/core/src/eval-metadata"

const RESULTS_MODULE_ID = "virtual:supabase-eval-results"
const RESOLVED_RESULTS_MODULE_ID = `\0${RESULTS_MODULE_ID}`

const REPO_ROOT = path.resolve(__dirname, "../..")

function readPrompt(evalsDir: string, evalId: string) {
  const promptPath = path.resolve(evalsDir, evalId, "PROMPT.md")
  const normalizedEvalsDir = path.resolve(evalsDir)

  if (!promptPath.startsWith(`${normalizedEvalsDir}${path.sep}`)) {
    return undefined
  }

  if (!existsSync(promptPath)) {
    return undefined
  }

  const parsed = parseEvalMarkdown(readFileSync(promptPath, "utf8"), promptPath)

  return {
    ...parsed.metadata,
    prompt: parsed.body,
    promptSourcePath: path.relative(REPO_ROOT, promptPath),
  }
}

function readResultFile(
  filePath: string,
  sourcePath: string,
  evalsDir: string
): EvalResult | null {
  const parsed = JSON.parse(
    readFileSync(filePath, "utf8")
  ) as Partial<EvalResult>

  if (!parsed.experiment || !parsed.eval) {
    return null
  }

  const promptData = readPrompt(evalsDir, parsed.eval)

  return {
    experiment: parsed.experiment,
    eval: parsed.eval,
    stage: promptData?.stage ?? parsed.stage,
    product: promptData?.product ?? parsed.product,
    topic: promptData?.topic ?? parsed.topic,
    passed: Boolean(parsed.passed),
    assertions: readAssertions(parsed.assertions),
    prompt: promptData?.prompt,
    promptSourcePath: promptData?.promptSourcePath,
    attempts: typeof parsed.attempts === "number" ? parsed.attempts : undefined,
    sourcePath,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readAssertions(value: unknown): AssertionResult[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const assertions = value.flatMap((item) => {
    const assertion = readAssertion(item)
    return assertion ? [assertion] : []
  })

  return assertions.length > 0 ? assertions : undefined
}

function readAssertion(value: unknown): AssertionResult | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const type = value.type
  const name = value.name
  const passed = value.passed
  const notes = value.notes

  if (
    (type !== "deterministic" && type !== "llm") ||
    typeof name !== "string" ||
    typeof passed !== "boolean"
  ) {
    return undefined
  }

  return {
    type,
    name,
    passed,
    notes: typeof notes === "string" ? notes : undefined,
  }
}

function loadEvalResults() {
  const resultsDir = path.resolve(REPO_ROOT, "results")
  const evalsDir = path.resolve(REPO_ROOT, "evals")

  if (!existsSync(resultsDir)) {
    return []
  }

  return readdirSync(resultsDir)
    .filter(
      (experiment) => !experiment.startsWith(".") && !experiment.startsWith("_")
    )
    .flatMap((experiment) => {
      const experimentDir = path.join(resultsDir, experiment)

      if (!statSync(experimentDir).isDirectory()) {
        return []
      }

      return readdirSync(experimentDir).flatMap((entry) => {
        const entryPath = path.join(experimentDir, entry)
        const relativeEntryPath = path
          .relative(resultsDir, entryPath)
          .split(path.sep)
          .join("/")

        if (statSync(entryPath).isFile() && entry.endsWith(".json")) {
          const result = readResultFile(entryPath, relativeEntryPath, evalsDir)
          return result ? [result] : []
        }

        if (!statSync(entryPath).isDirectory()) {
          return []
        }

        const summaryPath = path.join(entryPath, "summary.json")
        if (!existsSync(summaryPath)) {
          return []
        }

        const result = readResultFile(
          summaryPath,
          `${relativeEntryPath}/summary.json`,
          evalsDir
        )

        return result ? [result] : []
      })
    })
    .sort(
      (a, b) =>
        a.experiment.localeCompare(b.experiment) || a.eval.localeCompare(b.eval)
    )
}

function evalResultsPlugin() {
  return {
    name: "supabase-eval-results",
    resolveId(id: string) {
      if (id === RESULTS_MODULE_ID) {
        return RESOLVED_RESULTS_MODULE_ID
      }
    },
    load(id: string) {
      if (id !== RESOLVED_RESULTS_MODULE_ID) {
        return undefined
      }

      return `export default ${JSON.stringify(loadEvalResults())}`
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), evalResultsPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
