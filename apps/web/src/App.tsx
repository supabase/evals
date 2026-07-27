import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  FileTextIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import { z } from "zod"
import {
  evalResultSchema,
  type EvalResult,
} from "@supabase-evals/core/eval-metadata"
import rawResults from "@/data/eval-results.json"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { HeroGridPattern } from "@/components/hero-grid-pattern"
import { cn } from "@/lib/utils"

const JOURNEY_STAGES = [
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

const CLI_COMMAND = "npx plugins add supabase-community/supabase-plugin"
const DOCS_URL = "https://supabase.com/docs/guides/ai-tools/plugins"
const CREATE_PROJECT_URL = "https://supabase.com/dashboard/new"
const WEBSITE_URL = "https://supabase.com"
const UNASSIGNED_PRODUCT = "__unassigned_product__"

type JourneyStage = (typeof JOURNEY_STAGES)[number]["id"]
type GroupBy = "model" | "stage" | "product" | "eval"

type ParsedResult = Omit<EvalResult, "product" | "topic"> & {
  category: JourneyStage | "unknown"
  product: string[]
  topic: string[]
  primaryCategory: string
}

type CheckResult = NonNullable<ParsedResult["checks"]>[number]
type DocsResult = NonNullable<ParsedResult["docs"]>
type DocsCall = DocsResult["calls"][number]

const DOCS_CALL_SOURCE_LABEL: Record<DocsCall["source"], string> = {
  search_docs: "MCP",
  web_fetch: "Web Fetch",
  web_search: "Web Search",
}

// Cool color for MCP (our own docs tool), warm for the agent going around it onto the open web.
const DOCS_CALL_SOURCE_CHIP_CLASS: Record<DocsCall["source"], string> = {
  search_docs: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-400",
  web_fetch: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  web_search: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
}

/** Search icon for a bare hit, file icon for a call that actually pulled in page text. */
function docsCallIcon(call: DocsCall) {
  return call.hasContent === false ? SearchIcon : FileTextIcon
}

/** Pulls the quoted search term out of search_docs's raw GraphQL query for display, else returns the query as-is. */
function docsCallQueryLabel(call: DocsCall): string {
  if (call.source === "search_docs") {
    const match = call.query.match(/query:\s*"((?:[^"\\]|\\.)*)"/)
    if (match) return match[1]
  }
  return call.query
}

/** Rough token estimate (chars/4, the standard quick heuristic) for how much text a call pulled into context. */
function docsCallSizeLabel(call: DocsCall): string | undefined {
  if (call.resultChars === undefined) return undefined
  const tokens = Math.round(call.resultChars / 4)
  return tokens < 1000
    ? `~${tokens} tokens`
    : `~${(tokens / 1000).toFixed(1)}k tokens`
}

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

const results: ParsedResult[] = z
  .array(evalResultSchema)
  .parse(rawResults)
  .map(parseResult)

type ExperimentDisplay = NonNullable<EvalResult["experimentDisplay"]>

const AGENT_LABELS = {
  "ai-sdk": "AI SDK",
  "claude-code": "Claude Code",
  codex: "Codex",
} satisfies Record<ExperimentDisplay["agent"], string>

const EXPERIMENT_SUITES = ["benchmark", "no-skills"] as const
type SelectedExperimentSuite = (typeof EXPERIMENT_SUITES)[number]

const EXPERIMENT_SUITE_LABELS = {
  benchmark: "Benchmark",
  "no-skills": "Without skills",
} satisfies Record<SelectedExperimentSuite, string>

const GROUP_BY_OPTIONS = [
  "model",
  "eval",
  "stage",
  "product",
] as const satisfies ReadonlyArray<GroupBy>

/** Pill-shaped single-choice control; the options share the row in equal columns. */
function SegmentedControl<Option extends string>({
  label,
  options,
  optionLabel,
  value,
  onValueChange,
}: {
  label: string
  options: readonly Option[]
  optionLabel: (option: Option) => string
  value: Option
  onValueChange: (value: Option) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-grid h-[34px] w-fit auto-cols-fr grid-flow-col rounded-full border border-input bg-card p-0.5 text-sm"
    >
      {options.map((option) => {
        const selected = option === value

        return (
          <button
            key={option}
            type="button"
            aria-pressed={selected}
            onClick={() => onValueChange(option)}
            className={cn(
              "h-full min-w-24 rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {optionLabel(option)}
          </button>
        )
      })}
    </div>
  )
}

/** Header text that truncates to its cell, with an optional tooltip for the full story. */
function TableHeaderLabel({
  children,
  tooltip,
  className,
}: {
  children: ReactNode
  tooltip?: ReactNode
  className?: string
}) {
  const label = (
    <span className={cn("block truncate", className)}>{children}</span>
  )

  if (!tooltip) {
    return label
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  )
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

function formatExperimentLabel(
  display: ExperimentDisplay | undefined,
  fallback: string
) {
  if (!display) {
    return fallback
  }

  return `${AGENT_LABELS[display.agent]} / ${formatModelWithModifiers(display)}`
}

function formatModelColumnLabel(
  display: ExperimentDisplay | undefined,
  fallback: string
) {
  if (!display) {
    return fallback
  }

  return formatModelWithModifiers(display)
}

function getVisibleExperiments(sourceResults: ParsedResult[]) {
  return Array.from(
    new Set(sourceResults.map((result) => result.experiment))
  ).sort((a, b) => a.localeCompare(b))
}

function getExperimentDisplay(experiment: string) {
  return results.find((result) => result.experiment === experiment)
    ?.experimentDisplay
}

const experimentLabel = new Map(
  getVisibleExperiments(results).map((experiment) => [
    experiment,
    formatExperimentLabel(getExperimentDisplay(experiment), experiment),
  ])
)

function sortResults(a: ParsedResult, b: ParsedResult) {
  const categoryDelta =
    (stageIndex.get(a.category) ?? Number.MAX_SAFE_INTEGER) -
    (stageIndex.get(b.category) ?? Number.MAX_SAFE_INTEGER)

  return (
    categoryDelta ||
    a.primaryCategory.localeCompare(b.primaryCategory) ||
    a.eval.localeCompare(b.eval)
  )
}

const sortedResults = [...results].sort(sortResults)

function getExperimentResults(
  experiment: string,
  sourceResults = sortedResults
) {
  return sourceResults.filter((result) => result.experiment === experiment)
}

function formatTagLabel(value: string) {
  return value
    .split(" ")
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part))
    .join(" ")
}

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

function formatProductLabel(value: string) {
  if (value === UNASSIGNED_PRODUCT) {
    return "Unassigned"
  }

  return PRODUCT_LABELS[value] ?? formatTagLabel(value)
}

function formatEvalName(evalId: string) {
  const [, subcategory, sequence, ...slug] = evalId.split("-")
  const readableSlug = slug.join(" ")

  if (!subcategory || !sequence || !readableSlug) {
    return evalId.replaceAll("-", " ")
  }

  return `${subcategory} ${sequence}: ${readableSlug}`
}

const pageContainerClassName = "mx-auto w-full max-w-7xl px-6 lg:px-12 xl:px-24"

const evalMetaGridClassName =
  "grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-4 gap-y-4 text-xs"

const evalMetaLabelClassName = "text-muted-foreground capitalize"

function EvalMetadataRow({
  label,
  value,
}: {
  label: string
  value: ReactNode
}) {
  return (
    <>
      <dt className={evalMetaLabelClassName}>{label}</dt>
      <dd className="min-w-0 text-left text-foreground">{value}</dd>
    </>
  )
}

function ResultChecks({ checks }: { checks: CheckResult[] }) {
  return (
    <div className="flex flex-col gap-1 leading-relaxed text-foreground">
      {checks.map((check, index) => {
        const StatusIcon = check.passed ? CheckIcon : XIcon
        const notes = check.judgeNotes ?? check.notes
        const checkRow = (
          <span className="inline-flex w-full items-start gap-2 pl-6">
            {notes ? (
              <ChevronRightIcon
                className="mt-0.5 -ml-6 size-4 shrink-0 text-muted-foreground/50 transition-transform group-open:rotate-90"
                aria-hidden
              />
            ) : null}
            <StatusIcon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                check.passed
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400"
              )}
              aria-hidden
            />
            <span className="sr-only">{check.passed ? "Pass" : "Fail"}: </span>
            <span className="min-w-0 whitespace-pre-wrap">{check.name}</span>
          </span>
        )

        if (!notes) {
          return <div key={`${index}-${check.name}`}>{checkRow}</div>
        }

        return (
          <details key={`${index}-${check.name}`} className="group">
            <summary className="cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
              {checkRow}
            </summary>
            <p className="mt-1 ml-12 whitespace-pre-wrap text-muted-foreground">
              {notes}
            </p>
          </details>
        )
      })}
    </div>
  )
}

const docsSourceChipClassName =
  "rounded-md px-2 py-1 font-mono text-xs font-normal uppercase tracking-wide text-muted-foreground"

/** One collapsible row per docs call (see DocsCall), expanding to the pages that call returned. */
function ResultDocsCalls({ calls }: { calls: DocsCall[] }) {
  return (
    <div className="flex flex-col gap-1.5 leading-relaxed text-foreground">
      {calls.map((call, index) => {
        const searchOnly = call.hasContent === false
        const Icon = docsCallIcon(call)
        const queryLabel = docsCallQueryLabel(call)
        const sizeLabel = docsCallSizeLabel(call)

        return (
          <details key={index} className="group">
            <summary className="cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
              <span className="inline-flex w-full items-center gap-2">
                <ChevronRightIcon
                  className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-open:rotate-90"
                  aria-hidden
                />
                <Icon
                  className={cn(
                    "size-4 shrink-0",
                    searchOnly
                      ? "text-muted-foreground/60"
                      : "text-muted-foreground"
                  )}
                  aria-hidden
                />
                <span
                  title={queryLabel}
                  className={cn(
                    "min-w-0 truncate",
                    searchOnly ? "text-muted-foreground" : "text-foreground"
                  )}
                >
                  {queryLabel}
                </span>
                {sizeLabel ? (
                  <span className="shrink-0 font-mono text-xs tracking-wide text-muted-foreground">
                    {sizeLabel}
                  </span>
                ) : null}
                <span
                  className={cn(
                    docsSourceChipClassName,
                    "shrink-0",
                    DOCS_CALL_SOURCE_CHIP_CLASS[call.source]
                  )}
                >
                  {DOCS_CALL_SOURCE_LABEL[call.source]}
                </span>
              </span>
            </summary>
            <div className="mt-1 ml-12 flex flex-col gap-1">
              {call.pages.length > 0 ? (
                call.pages.map((page) => (
                  <a
                    key={page.url}
                    href={page.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {page.title ?? page.url}
                  </a>
                ))
              ) : (
                <span className="text-muted-foreground">
                  No results recovered (the tool's output may have been
                  truncated).
                </span>
              )}
            </div>
          </details>
        )
      })}
    </div>
  )
}

function getPassRateClass(passRate: number) {
  if (passRate < 50) {
    return "text-red-600 dark:text-red-400"
  }

  if (passRate < 80) {
    return "text-amber-600 dark:text-amber-400"
  }

  return "text-emerald-600 dark:text-emerald-400"
}

function getProductKeys(sourceResults: ParsedResult[]) {
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

function getProductResults(product: string, sourceResults: ParsedResult[]) {
  return sourceResults.filter((result) =>
    product === UNASSIGNED_PRODUCT
      ? result.product.length === 0
      : result.product.includes(product)
  )
}

function getStageResults(
  category: JourneyStage,
  sourceResults: ParsedResult[]
) {
  return sourceResults.filter((result) => result.category === category)
}

function getEvalResults(evalId: string, sourceResults: ParsedResult[]) {
  return sourceResults.filter((result) => result.eval === evalId)
}

/** Eval ids in the canonical order of `sourceResults` (journey stage, then topic, then id). */
function getEvalIds(sourceResults: ParsedResult[]) {
  return Array.from(new Set(sourceResults.map((result) => result.eval)))
}

/** Experiments ranked best first: the order models appear in on either axis. */
function getRankedExperiments(sourceResults: ParsedResult[]) {
  return getVisibleExperiments(sourceResults)
    .map((experiment) => {
      const experimentResults = getExperimentResults(experiment, sourceResults)
      const passed = experimentResults.filter((result) => result.passed).length

      return {
        experiment,
        label: experimentLabel.get(experiment) ?? experiment,
        passRate: experimentResults.length
          ? passed / experimentResults.length
          : 0,
      }
    })
    .sort((a, b) => b.passRate - a.passRate || a.label.localeCompare(b.label))
    .map((row) => row.experiment)
}

/**
 * One axis of the results: models, evals, journey stages, products. Rows,
 * columns and the detail sheet are all rendered from these descriptors, so a
 * new axis is a new entry here rather than another branch in the table.
 */
type Dimension = {
  id: GroupBy
  /** Axis name, used for headers and as the sheet's eyebrow. */
  label: string
  /** Keys present in `sourceResults`, in display order. */
  keys: (sourceResults: ParsedResult[]) => string[]
  /** The runs belonging to one key. */
  filter: (key: string, sourceResults: ParsedResult[]) => ParsedResult[]
  /** The key a single run sits under. */
  keyOf: (result: ParsedResult) => string
  /** Full name of a key: row headers and, unless `shortTitle` exists, the sheet title. */
  title: (key: string) => string
  /** Compact name for column headers and for sheet titles whose `caption` carries the rest. */
  shortTitle?: (key: string) => string
  /** Line above the sheet title; defaults to `label`. */
  caption?: (key: string) => string | undefined
  tooltip?: (key: string) => string | undefined
  /** How a run reads on this axis; defaults to the title of its key. */
  cell?: (result: ParsedResult) => string
  /**
   * Axes that picking this one also pins down, so the sheet drops them as
   * columns: every run of an eval shares its journey stage and products.
   * Deliberately structural rather than measured from the data: a sheet's
   * shape should follow what was clicked, not how many runs sit behind it.
   */
  implies?: GroupBy[]
}

const DIMENSIONS: Record<GroupBy, Dimension> = {
  model: {
    id: "model",
    label: "Model",
    keys: getRankedExperiments,
    filter: getExperimentResults,
    keyOf: (result) => result.experiment,
    title: (key) => experimentLabel.get(key) ?? key,
    shortTitle: (key) => formatModelColumnLabel(getExperimentDisplay(key), key),
    caption: (key) => {
      const display = getExperimentDisplay(key)
      return display ? AGENT_LABELS[display.agent] : undefined
    },
  },
  eval: {
    id: "eval",
    label: "Eval",
    keys: getEvalIds,
    filter: getEvalResults,
    keyOf: (result) => result.eval,
    title: (key) => formatEvalName(key),
    tooltip: (key) => key,
    implies: ["stage", "product"],
  },
  stage: {
    id: "stage",
    label: "Journey",
    // Every stage stays visible, even one no eval covers yet.
    keys: () => JOURNEY_STAGES.map((stage) => stage.id),
    filter: (key, sourceResults) =>
      getStageResults(key as JourneyStage, sourceResults),
    keyOf: (result) => result.category,
    title: (key) =>
      JOURNEY_STAGES.find((stage) => stage.id === key)?.label ?? "Unknown",
    tooltip: (key) =>
      JOURNEY_STAGES.find((stage) => stage.id === key)?.description,
  },
  product: {
    id: "product",
    label: "Product",
    keys: getProductKeys,
    filter: getProductResults,
    keyOf: (result) => result.product[0] ?? UNASSIGNED_PRODUCT,
    title: formatProductLabel,
    // Evals can span products, so a run reads as the full list rather than its key.
    cell: (result) =>
      result.product.length
        ? result.product.map(formatProductLabel).join(", ")
        : formatProductLabel(UNASSIGNED_PRODUCT),
  },
}

/** Left-to-right order the axes appear in as columns of the detail sheet. */
const DIMENSION_ORDER = [
  DIMENSIONS.eval,
  DIMENSIONS.model,
  DIMENSIONS.stage,
  DIMENSIONS.product,
]

function dimensionCell(dimension: Dimension, result: ParsedResult) {
  return dimension.cell?.(result) ?? dimension.title(dimension.keyOf(result))
}

function dimensionShortTitle(dimension: Dimension, key: string) {
  return dimension.shortTitle?.(key) ?? dimension.title(key)
}

/**
 * Runs sorted by the sheet's columns, left to right, then by the canonical
 * order. Each column ranks against the whole table rather than the selection,
 * so models read in the same order here as they do in the table's columns.
 */
function orderRuns(
  runs: ParsedResult[],
  columns: Dimension[],
  sourceResults: ParsedResult[]
) {
  const ranks = columns.map((column) => {
    const rank = new Map(
      column.keys(sourceResults).map((key, index) => [key, index])
    )

    return (result: ParsedResult) =>
      rank.get(column.keyOf(result)) ?? Number.MAX_SAFE_INTEGER
  })

  return [...runs].sort((a, b) => {
    for (const rankOf of ranks) {
      const delta = rankOf(a) - rankOf(b)
      if (delta) return delta
    }

    return sortResults(a, b)
  })
}

function scoreResults(sourceResults: ParsedResult[]) {
  const passed = sourceResults.filter((result) => result.passed).length

  return {
    passed,
    total: sourceResults.length,
  }
}

function ScoreCell({
  passed,
  total,
  isTotal = false,
}: {
  passed: number
  total: number
  isTotal?: boolean
}) {
  if (!total) {
    return <span className="text-muted-foreground/50">—</span>
  }

  const passRate = Math.round((passed / total) * 100)

  return (
    <span
      title={`${passed} of ${total} runs passed`}
      className={cn(
        "font-mono text-xs",
        isTotal && "font-semibold",
        getPassRateClass(passRate)
      )}
    >
      {passRate}%
    </span>
  )
}

const clickableTableItemClassName =
  "cursor-pointer bg-card transition-colors outline-none hover:bg-muted/35 focus-visible:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"

const columnHighlightClassName = "bg-muted/35"

/** Shared by both tables; each supplies its own padding. */
const tableHeadCellClassName =
  "border-b border-border text-left font-mono text-xs font-normal tracking-wide text-muted-foreground uppercase"

/** Rows are clickable `<tr>`s rather than buttons, so they need their own key handling. */
function activateOnKeyDown(event: KeyboardEvent, open: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault()
    open()
  }
}

/** What the user clicked: a key on one of the axes, whichever axis it came from. */
type TableSelection = { dimension: GroupBy; key: string }

function ResultsTable({
  sourceResults,
  groupBy,
  selectedExperimentSuite,
  onGroupByChange,
  onExperimentSuiteChange,
}: {
  sourceResults: ParsedResult[]
  groupBy: GroupBy
  selectedExperimentSuite: SelectedExperimentSuite
  onGroupByChange: (value: GroupBy) => void
  onExperimentSuiteChange: (value: SelectedExperimentSuite) => void
}) {
  const rowDimension = DIMENSIONS[groupBy]
  // Models are the comparison axis for every grouping except themselves, where
  // the journey stages take over.
  const columnDimension =
    groupBy === "model" ? DIMENSIONS.stage : DIMENSIONS.model
  const modelsAsRows = groupBy === "model"
  const rowKeys = rowDimension.keys(sourceResults)
  const columnKeys = columnDimension.keys(sourceResults)
  const [selection, setSelection] = useState<TableSelection | null>(null)
  const [hoveredColumn, setHoveredColumn] = useState<string | null>(null)

  const select = (dimension: Dimension, key: string) => {
    setSelection({ dimension: dimension.id, key })
  }

  return (
    <Sheet
      open={selection !== null}
      onOpenChange={(open) => {
        if (!open) setSelection(null)
      }}
    >
      <section
        aria-label="Results"
        className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_24px_80px_-36px_rgba(0,0,0,0.45),0_8px_28px_-18px_rgba(0,0,0,0.28)]"
      >
        <div className="flex min-h-12 flex-col gap-2 border-b border-border bg-secondary/70 px-2 py-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="w-full overflow-x-auto pb-0.5 lg:w-auto lg:pb-0">
            <SegmentedControl
              label="Group by"
              options={GROUP_BY_OPTIONS}
              optionLabel={(option) => DIMENSIONS[option].label}
              value={groupBy}
              onValueChange={onGroupByChange}
            />
          </div>
          <div className="w-full overflow-x-auto pb-0.5 lg:w-auto lg:pb-0">
            <SegmentedControl
              label="Experiment suite"
              options={EXPERIMENT_SUITES}
              optionLabel={(suite) => EXPERIMENT_SUITE_LABELS[suite]}
              value={selectedExperimentSuite}
              onValueChange={onExperimentSuiteChange}
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          {sourceResults.length ? (
            <table
              className={cn(
                "w-full border-collapse text-[13px]",
                modelsAsRows ? "min-w-[760px]" : "min-w-[1100px]"
              )}
            >
              <thead className="bg-secondary/45 text-muted-foreground">
                <tr>
                  <th
                    scope="col"
                    className={cn(
                      tableHeadCellClassName,
                      "border-r px-2.5 py-1.5",
                      groupBy === "eval" ? "w-72 min-w-64" : "w-64"
                    )}
                  >
                    {rowDimension.label}
                  </th>
                  {columnKeys.map((columnKey) => {
                    const tooltip = columnDimension.tooltip?.(columnKey)

                    return (
                      <th
                        key={columnKey}
                        scope="col"
                        className={cn(
                          tableHeadCellClassName,
                          "border-r p-0 transition-colors",
                          modelsAsRows ? "w-24" : "min-w-28",
                          hoveredColumn === columnKey &&
                            columnHighlightClassName
                        )}
                        onMouseEnter={() => setHoveredColumn(columnKey)}
                        onMouseLeave={() => setHoveredColumn(null)}
                      >
                        <button
                          type="button"
                          title={
                            tooltip
                              ? undefined
                              : columnDimension.title(columnKey)
                          }
                          onClick={() => select(columnDimension, columnKey)}
                          className="block w-full cursor-pointer px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                        >
                          <TableHeaderLabel tooltip={tooltip}>
                            {dimensionShortTitle(columnDimension, columnKey)}
                          </TableHeaderLabel>
                        </button>
                      </th>
                    )
                  })}
                  <th
                    scope="col"
                    className={cn(tableHeadCellClassName, "w-20 px-2.5 py-1.5")}
                  >
                    Total
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:last-child>td]:border-b-0 [&>tr:last-child>th]:border-b-0">
                {rowKeys.map((rowKey) => {
                  const rowResults = rowDimension.filter(rowKey, sourceResults)
                  const rowTotal = scoreResults(rowResults)

                  return (
                    <tr
                      key={rowKey}
                      tabIndex={0}
                      aria-label={`Open ${rowDimension.title(rowKey)}`}
                      className={clickableTableItemClassName}
                      onClick={() => select(rowDimension, rowKey)}
                      onKeyDown={(event) =>
                        activateOnKeyDown(event, () =>
                          select(rowDimension, rowKey)
                        )
                      }
                    >
                      <th
                        scope="row"
                        className="border-r border-b border-border px-2.5 py-2 text-left font-normal text-foreground"
                      >
                        <TableHeaderLabel
                          tooltip={rowDimension.tooltip?.(rowKey)}
                          className="font-medium"
                        >
                          {rowDimension.title(rowKey)}
                        </TableHeaderLabel>
                      </th>
                      {columnKeys.map((columnKey) => {
                        const summary = scoreResults(
                          columnDimension.filter(columnKey, rowResults)
                        )

                        return (
                          <td
                            key={columnKey}
                            className={cn(
                              "border-r border-b border-border px-2.5 py-2 transition-colors",
                              hoveredColumn === columnKey &&
                                columnHighlightClassName
                            )}
                          >
                            <ScoreCell
                              passed={summary.passed}
                              total={summary.total}
                            />
                          </td>
                        )
                      })}
                      <td className="border-b border-border px-2.5 py-2">
                        <ScoreCell
                          passed={rowTotal.passed}
                          total={rowTotal.total}
                          isTotal
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <div className="grid min-h-72 place-items-center px-6 text-center text-sm text-muted-foreground">
              No results match the selected filters.
            </div>
          )}
        </div>
      </section>
      {selection ? (
        <SelectionSheet selection={selection} sourceResults={sourceResults} />
      ) : null}
    </Sheet>
  )
}

function EvaluationDetails({ result }: { result: ParsedResult }) {
  return (
    <dl className={evalMetaGridClassName}>
      {result.prompt ? (
        <EvalMetadataRow
          label="Prompt"
          value={
            <div className="rounded-md border bg-muted/35">
              <pre className="max-h-56 overflow-auto px-3 py-2 leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {result.prompt}
              </pre>
            </div>
          }
        />
      ) : null}
      <EvalMetadataRow label="Attempts" value={result.attempts ?? "-"} />
      <EvalMetadataRow
        label="Source"
        value={<span className="break-all">{result.sourcePath}</span>}
      />
      <EvalMetadataRow
        label="Product"
        value={
          result.product.length
            ? result.product.map(formatProductLabel).join(", ")
            : "-"
        }
      />
      <EvalMetadataRow
        label="Topic"
        value={result.topic.map(formatTagLabel).join(", ") || "-"}
      />
      {result.checks?.length ? (
        <EvalMetadataRow
          label="Result details"
          value={<ResultChecks checks={result.checks} />}
        />
      ) : null}
      {result.docs?.calls.length ? (
        <EvalMetadataRow
          label="Docs activity"
          value={<ResultDocsCalls calls={result.docs.calls} />}
        />
      ) : null}
    </dl>
  )
}

function runKey(result: ParsedResult) {
  return `${result.experiment}::${result.eval}`
}

/**
 * Detail view for a clicked row or column, listing the runs behind it. Every
 * axis the selection leaves open becomes a column, so a model selection lists
 * its evals and an eval selection lists the models that ran it. It is the same
 * component either way; the shape depends only on which axis was clicked.
 */
function SelectionSheet({
  selection,
  sourceResults,
}: {
  selection: TableSelection
  sourceResults: ParsedResult[]
}) {
  const dimension = DIMENSIONS[selection.dimension]
  const runs = dimension.filter(selection.key, sourceResults)
  const pinned = new Set<GroupBy>([dimension.id, ...(dimension.implies ?? [])])
  const columns = DIMENSION_ORDER.filter((facet) => !pinned.has(facet.id))
  const orderedRuns = orderRuns(runs, columns, sourceResults)
  const { passed, total } = scoreResults(runs)
  const passRate = total ? Math.round((passed / total) * 100) : null
  const [expandedRun, setExpandedRun] = useState<string | null>(null)

  const toggleRun = (key: string) => {
    setExpandedRun((current) => (current === key ? null : key))
  }

  return (
    <SheetContent className="max-w-4xl shadow-none">
      <SheetHeader className="flex-row items-end justify-between gap-6">
        <SheetTitle className="flex min-w-0 flex-col gap-1 pr-0 font-heading tracking-normal">
          <span className="text-xl leading-none font-medium text-muted-foreground">
            {dimension.caption?.(selection.key) ?? dimension.label}
          </span>
          <span className="text-xl leading-tight font-medium text-foreground">
            {dimensionShortTitle(dimension, selection.key)}
          </span>
        </SheetTitle>
        <SheetDescription className="flex shrink-0 flex-col items-end gap-3 pb-0.5 text-right">
          <span>
            {passed} of {total} runs pass
            {passRate !== null ? (
              <>
                {" / "}
                <span className={getPassRateClass(passRate)}>{passRate}%</span>
              </>
            ) : null}
          </span>
        </SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {orderedRuns.length ? (
          <table
            className={cn(
              "w-full border-collapse text-[13px]",
              columns.length > 2 && "min-w-[720px]"
            )}
          >
            <thead className="sticky top-0 z-10 bg-secondary/95 text-muted-foreground backdrop-blur">
              <tr>
                {columns.map((facet, index) => (
                  <th
                    key={facet.id}
                    className={cn(
                      tableHeadCellClassName,
                      "border-r px-3 py-2",
                      index === 0 && "pr-3 pl-6",
                      // Only worth pinning once there are enough columns to crowd.
                      index === 0 && columns.length > 2 && "w-[38%]"
                    )}
                  >
                    {facet.label}
                  </th>
                ))}
                <th className={cn(tableHeadCellClassName, "w-20 px-3 py-2")}>
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {orderedRuns.map((run) => {
                const key = runKey(run)
                const expanded = expandedRun === key

                return (
                  <Fragment key={key}>
                    <tr
                      tabIndex={0}
                      aria-expanded={expanded}
                      className={clickableTableItemClassName}
                      onClick={() => toggleRun(key)}
                      onKeyDown={(event) =>
                        activateOnKeyDown(event, () => toggleRun(key))
                      }
                    >
                      {columns.map((facet, index) =>
                        index === 0 ? (
                          <th
                            key={facet.id}
                            scope="row"
                            className="border-r border-b border-border py-2.5 pr-3 pl-6 text-left font-normal text-foreground"
                          >
                            {dimensionCell(facet, run)}
                          </th>
                        ) : (
                          <td
                            key={facet.id}
                            className="border-r border-b border-border px-3 py-2.5 text-muted-foreground"
                          >
                            {dimensionCell(facet, run)}
                          </td>
                        )
                      )}
                      <td className="border-b border-border px-3 py-2.5">
                        <span
                          className={cn(
                            "font-mono text-xs",
                            run.passed
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-red-600 dark:text-red-400"
                          )}
                        >
                          {run.passed ? "Pass" : "Fail"}
                        </span>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr>
                        <td
                          colSpan={columns.length + 1}
                          className="border-b border-border bg-secondary/35 px-6 py-5"
                        >
                          <EvaluationDetails result={run} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="grid min-h-48 place-items-center px-6 text-center text-sm text-muted-foreground">
            No runs recorded for this selection yet.
          </div>
        )}
      </div>
    </SheetContent>
  )
}

function SupabaseLogo({ className }: { className?: string }) {
  return (
    <svg
      className={cn("h-6 w-auto", className)}
      viewBox="0 0 109 113"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Supabase"
      role="img"
    >
      <path
        d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z"
        fill="url(#supabase-logo-paint0)"
      />
      <path
        d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z"
        fill="url(#supabase-logo-paint1)"
        fillOpacity="0.2"
      />
      <path
        d="M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.041L54.4849 72.2922H9.83113C1.64038 72.2922 -2.92775 62.8321 2.1655 56.4175L45.317 2.07103Z"
        fill="#3ECF8E"
      />
      <defs>
        <linearGradient
          id="supabase-logo-paint0"
          x1="53.9738"
          y1="54.974"
          x2="94.1635"
          y2="71.8295"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#249361" />
          <stop offset="1" stopColor="#3ECF8E" />
        </linearGradient>
        <linearGradient
          id="supabase-logo-paint1"
          x1="36.1558"
          y1="30.578"
          x2="54.4844"
          y2="65.0806"
          gradientUnits="userSpaceOnUse"
        >
          <stop />
          <stop offset="1" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}

const COPY_FEEDBACK_MS = 2000

function CopyCommandButton() {
  const [copied, setCopied] = useState(false)
  const resetTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current)
      }
    }
  }, [])

  const copyCommand = () => {
    void navigator.clipboard.writeText(CLI_COMMAND)
    setCopied(true)

    if (resetTimeoutRef.current !== null) {
      window.clearTimeout(resetTimeoutRef.current)
    }

    resetTimeoutRef.current = window.setTimeout(() => {
      setCopied(false)
      resetTimeoutRef.current = null
    }, COPY_FEEDBACK_MS)
  }

  return (
    <Button
      variant="secondary"
      className="justify-between gap-4 font-mono text-xs text-muted-foreground hover:text-foreground"
      onClick={copyCommand}
      aria-label={copied ? "Copied" : `Copy ${CLI_COMMAND}`}
    >
      <span className="truncate">{CLI_COMMAND}</span>
      {copied ? (
        <CheckIcon className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <CopyIcon className="size-3.5 shrink-0" aria-hidden />
      )}
    </Button>
  )
}

function ReadDocsButton() {
  return (
    <Button variant="secondary" asChild>
      <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
        AI Tools
      </a>
    </Button>
  )
}

const OVERVIEW_CARDS = [
  {
    title: "Seeded project state",
    description:
      "Each eval seeds the project the agent inherits: schema, rows, logs, and deployed functions, plus the local files it starts from.",
    Icon: FileTextIcon,
  },
  {
    title: "Pinned experiments",
    description:
      "An experiment fixes the agent, model, reasoning effort, skills, and tools: Supabase MCP, the real CLI in a Docker sandbox, or both.",
    Icon: BotIcon,
  },
  {
    title: "Scored on outcomes",
    description:
      "When the agent stops, scorers inspect the state it left with SQL, client calls as real users, and the workspace it built. Report-only tasks get a judge.",
    Icon: CheckIcon,
  },
]

function EvalOverviewCards() {
  return (
    <section aria-label="How evaluations run">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {OVERVIEW_CARDS.map(({ title, description, Icon }) => (
          <article
            key={title}
            className="flex flex-col gap-3 rounded-lg border border-border bg-card p-6"
          >
            <Icon className="size-5 text-muted-foreground" aria-hidden />
            <h2 className="text-base font-medium text-foreground">{title}</h2>
            <p className="text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </article>
        ))}
      </div>
    </section>
  )
}

function FooterCta() {
  const [patternReplayKey, setPatternReplayKey] = useState(0)

  return (
    <footer
      className="text-center"
      onMouseEnter={() => setPatternReplayKey((key) => key + 1)}
    >
      <div className="px-6 pb-24 sm:pb-28 lg:pb-36">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-6">
          <h2 className="font-heading text-4xl leading-[1.2] font-medium tracking-normal">
            <span className="block text-foreground">Set your agent free</span>
            <span className="block text-muted-foreground">
              with a Supabase project
            </span>
          </h2>
          <div className="flex flex-col items-center gap-2 sm:flex-row">
            <Button asChild>
              <a
                href={CREATE_PROJECT_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Create Project
              </a>
            </Button>
            <Button variant="secondary" asChild>
              <a href={WEBSITE_URL} target="_blank" rel="noopener noreferrer">
                Learn more
              </a>
            </Button>
          </div>
        </div>
      </div>
      <HeroGridPattern
        key={patternReplayKey}
        height={200}
        color="var(--muted)"
      />
    </footer>
  )
}

export function App() {
  const [groupBy, setGroupBy] = useState<GroupBy>("model")
  const [selectedExperimentSuite, setSelectedExperimentSuite] =
    useState<SelectedExperimentSuite>("benchmark")
  const experimentSuiteResults = sortedResults.filter(
    (result) => result.experimentSuite === selectedExperimentSuite
  )

  return (
    <TooltipProvider delayDuration={200}>
      <main className="min-h-svh bg-background text-foreground">
        {results.length ? (
          <>
            <div className="sticky top-0 z-50 border-b border-dotted bg-background">
              <div
                className={cn(
                  pageContainerClassName,
                  "flex items-center justify-between py-3"
                )}
              >
                <a
                  href={WEBSITE_URL}
                  className="group/logo flex w-fit items-center gap-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <SupabaseLogo />
                  <span className="-translate-x-2 text-sm text-muted-foreground opacity-0 transition-all duration-200 group-hover/logo:translate-x-0 group-hover/logo:opacity-100 group-focus-visible/logo:translate-x-0 group-focus-visible/logo:opacity-100">
                    Back to Supabase
                  </span>
                </a>
                <div className="hidden items-center gap-2 sm:flex">
                  <CopyCommandButton />
                  <ReadDocsButton />
                </div>
              </div>
            </div>
            <header className="border-b border-border">
              <div className="w-full pt-24 pb-20 sm:pb-24 md:pb-28 lg:pb-28">
                <div
                  className={cn(
                    pageContainerClassName,
                    "flex flex-col gap-10 md:gap-12 lg:flex-row lg:items-end lg:justify-between lg:gap-16"
                  )}
                >
                  <div className="flex max-w-2xl min-w-0 flex-col gap-8 sm:gap-10">
                    <h1 className="font-heading text-4xl font-medium tracking-normal sm:text-5xl sm:leading-none">
                      <span className="block text-foreground">
                        Evaluating agents
                      </span>
                      <span className="block text-muted-foreground">
                        across Supabase
                      </span>
                    </h1>
                  </div>
                  <p className="max-w-md text-base leading-6 text-pretty text-muted-foreground lg:flex-none lg:pb-1">
                    We evaluate model experiments across the Supabase developer
                    journey, from building and deploying to investigating and
                    resolving production issues, with real project context.
                  </p>
                </div>
              </div>
            </header>
            <div
              className={cn(
                pageContainerClassName,
                "relative z-20 -mt-10 pb-8 md:-mt-16 md:pb-10"
              )}
            >
              <ResultsTable
                sourceResults={experimentSuiteResults}
                groupBy={groupBy}
                selectedExperimentSuite={selectedExperimentSuite}
                onGroupByChange={setGroupBy}
                onExperimentSuiteChange={setSelectedExperimentSuite}
              />
            </div>
            <div className={cn(pageContainerClassName, "pb-24 md:pb-28")}>
              <EvalOverviewCards />
            </div>
            <FooterCta />
          </>
        ) : (
          <div className="grid flex-1 place-items-center px-6 text-center text-sm text-muted-foreground">
            No result files found in the repo results directory.
          </div>
        )}
      </main>
    </TooltipProvider>
  )
}

export default App
