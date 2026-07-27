import { UNASSIGNED_PRODUCT, type ExperimentDisplay } from "@/lib/eval-results"

/** Turning ids from the exported results into the labels the site shows. */

export const AGENT_LABELS = {
  "ai-sdk": "AI SDK",
  "claude-code": "Claude Code",
  codex: "Codex",
} satisfies Record<ExperimentDisplay["agent"], string>

const PRODUCT_LABELS: Record<string, string> = {
  auth: "Auth",
  cron: "Cron",
  "data-api": "Data API",
  database: "Database",
  "edge-functions": "Edge Functions",
  queues: "Queues",
  realtime: "Realtime",
  storage: "Storage",
  vectors: "Vectors",
}

function capitalize(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value
}

function formatAnthropicModel(modelId: string) {
  const modelParts = modelId
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .split("-")
  const [family = "", ...versionParts] = modelParts

  if (!family || versionParts.length === 0) {
    return modelId
  }

  return `${capitalize(family)} ${versionParts.join(".")}`
}

function formatOpenAiModel(modelId: string) {
  if (!modelId.startsWith("gpt-")) {
    return modelId
  }

  const suffix = modelId.slice("gpt-".length)
  const match = /^(\d+(?:[.-]\d+)*)(?:-(.+))?$/.exec(suffix)
  if (!match) {
    return modelId.toUpperCase()
  }

  const [, version, variant] = match
  return [`GPT-${version.replaceAll("-", ".")}`, variant?.replaceAll("-", " ")]
    .filter(Boolean)
    .join(" ")
}

function formatModel(display: ExperimentDisplay) {
  switch (display.modelProvider) {
    case "anthropic":
      return formatAnthropicModel(display.modelId)
    case "openai":
      return formatOpenAiModel(display.modelId)
  }
}

function formatModelWithModifiers(display: ExperimentDisplay) {
  return [
    formatModel(display),
    display.reasoningEffort ? `(${display.reasoningEffort})` : "",
  ]
    .filter(Boolean)
    .join(" ")
}

/** Agent and model together, for row headers and the sheet title. */
export function formatExperimentLabel(
  display: ExperimentDisplay | undefined,
  fallback: string
) {
  if (!display) {
    return fallback
  }

  return `${AGENT_LABELS[display.agent]} / ${formatModelWithModifiers(display)}`
}

/** Model alone, for column headers where the agent sits in the caption. */
export function formatModelColumnLabel(
  display: ExperimentDisplay | undefined,
  fallback: string
) {
  if (!display) {
    return fallback
  }

  return formatModelWithModifiers(display)
}

/** Upper-cases short words so acronyms like "rls" and "api" read correctly. */
export function formatTagLabel(value: string) {
  return value
    .split(" ")
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part))
    .join(" ")
}

export function formatProductLabel(value: string) {
  if (value === UNASSIGNED_PRODUCT) {
    return "Unassigned"
  }

  return PRODUCT_LABELS[value] ?? formatTagLabel(value)
}

/** `build-cli-002-declarative-schema` reads as `cli 002: declarative schema`. */
export function formatEvalName(evalId: string) {
  const [, subcategory, sequence, ...slug] = evalId.split("-")
  const readableSlug = slug.join(" ")

  if (!subcategory || !sequence || !readableSlug) {
    return evalId.replaceAll("-", " ")
  }

  return `${subcategory} ${sequence}: ${readableSlug}`
}
