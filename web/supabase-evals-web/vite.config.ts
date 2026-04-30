import path from "path"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const RESULTS_MODULE_ID = "virtual:supabase-eval-results"
const RESOLVED_RESULTS_MODULE_ID = `\0${RESULTS_MODULE_ID}`

type EvalResult = {
  experiment: string
  eval: string
  passed: boolean
  score?: number
  notes?: string
  prompt?: string
  promptSourcePath?: string
  attempts?: number
  sourcePath: string
}

function readPrompt(evalsDir: string, evalId: string) {
  const promptPath = path.resolve(evalsDir, evalId, "PROMPT.md")
  const normalizedEvalsDir = path.resolve(evalsDir)

  if (!promptPath.startsWith(`${normalizedEvalsDir}${path.sep}`)) {
    return undefined
  }

  if (!existsSync(promptPath)) {
    return undefined
  }

  return {
    prompt: readFileSync(promptPath, "utf8").trim(),
    promptSourcePath: path.relative(path.resolve(__dirname, "../.."), promptPath),
  }
}

function readResultFile(
  filePath: string,
  sourcePath: string,
  evalsDir: string
): EvalResult | null {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<EvalResult>

  if (!parsed.experiment || !parsed.eval) {
    return null
  }

  const promptData = readPrompt(evalsDir, parsed.eval)

  return {
    experiment: parsed.experiment,
    eval: parsed.eval,
    passed: Boolean(parsed.passed),
    score: typeof parsed.score === "number" ? parsed.score : undefined,
    notes: typeof parsed.notes === "string" ? parsed.notes : undefined,
    prompt: promptData?.prompt,
    promptSourcePath: promptData?.promptSourcePath,
    attempts: typeof parsed.attempts === "number" ? parsed.attempts : undefined,
    sourcePath,
  }
}

function loadEvalResults() {
  const resultsDir = path.resolve(__dirname, "../../results")
  const evalsDir = path.resolve(__dirname, "../../evals")

  if (!existsSync(resultsDir)) {
    return []
  }

  return readdirSync(resultsDir)
    .filter((experiment) => !experiment.startsWith(".") && !experiment.startsWith("_"))
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
    .sort((a, b) => a.experiment.localeCompare(b.experiment) || a.eval.localeCompare(b.eval))
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
