import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { BotIcon, CheckIcon, ChevronRightIcon, CopyIcon, FileTextIcon, SearchIcon, XIcon } from "lucide-react"
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

const CLI_COMMAND = "npx skills add supabase/agent-skills"
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
  return tokens < 1000 ? `~${tokens} tokens` : `~${(tokens / 1000).toFixed(1)}k tokens`
}

type ExperimentStageSummary = {
  experiment: string
  category: JourneyStage
  passed: number
  total: number
}

type ModelResultRow = {
  experiment: string
  label: string
  shortLabel: string
  passed: number
  passRate: number
  results: ParsedResult[]
  total: number
}

const stageIndex = new Map(
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

const exportedResults: EvalResult[] = z
  .array(evalResultSchema)
  .parse(rawResults)
const results = exportedResults.map(parseResult)
const experiments = Array.from(
  new Set(results.map((result) => result.experiment))
).sort((a, b) => a.localeCompare(b))

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
  { value: "model", label: "Model" },
  { value: "eval", label: "Eval" },
  { value: "stage", label: "Journey" },
  { value: "product", label: "Product" },
] as const satisfies ReadonlyArray<{ value: GroupBy; label: string }>

const GROUP_BY_ROW_LABEL: Record<GroupBy, string> = {
  model: "Model",
  stage: "Journey",
  product: "Product",
  eval: "Eval",
}

const segmentedControlClassName =
  "inline-grid h-[34px] w-fit rounded-full border border-input bg-card p-0.5 text-sm"

const segmentedControlItemClassName =
  "h-full min-w-24 rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"

function ExperimentSuiteControl({
  value,
  onValueChange,
}: {
  value: SelectedExperimentSuite
  onValueChange: (value: SelectedExperimentSuite) => void
}) {
  return (
    <div
      role="group"
      aria-label="Experiment suite"
      className={cn(segmentedControlClassName, "grid-cols-2")}
    >
      {EXPERIMENT_SUITES.map((suite) => {
        const selected = suite === value

        return (
          <button
            key={suite}
            type="button"
            aria-pressed={selected}
            onClick={() => onValueChange(suite)}
            className={cn(
              segmentedControlItemClassName,
              selected
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {EXPERIMENT_SUITE_LABELS[suite]}
          </button>
        )
      })}
    </div>
  )
}

function GroupByControl({
  value,
  onValueChange,
}: {
  value: GroupBy
  onValueChange: (value: GroupBy) => void
}) {
  return (
    <div
      role="group"
      aria-label="Group by"
      className={cn(segmentedControlClassName, "grid-cols-4")}
    >
      {GROUP_BY_OPTIONS.map((option) => {
        const selected = option.value === value

        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onValueChange(option.value)}
            className={cn(
              segmentedControlItemClassName,
              selected
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function TableHeaderLabel({
  children,
  tooltip,
}: {
  children: ReactNode
  tooltip?: ReactNode
}) {
  if (!tooltip) {
    return children
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {children}
        </span>
      </TooltipTrigger>
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

function buildExperimentLabel(exp: string): string {
  const r = results.find((r) => r.experiment === exp)
  return formatExperimentLabel(r?.experimentDisplay, exp)
}

const experimentLabel = new Map(
  experiments.map((experiment) => [
    experiment,
    buildExperimentLabel(experiment),
  ])
)

function sortResults(a: ParsedResult, b: ParsedResult) {
  const categoryDelta =
    (stageIndex.get(a.category as JourneyStage) ?? Number.MAX_SAFE_INTEGER) -
    (stageIndex.get(b.category as JourneyStage) ?? Number.MAX_SAFE_INTEGER)

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

function getExperimentStageSummary(
  experiment: string,
  category: JourneyStage,
  sourceResults = sortedResults
): ExperimentStageSummary {
  const stageResults = sourceResults.filter(
    (result) => result.experiment === experiment && result.category === category
  )

  return {
    experiment,
    category,
    passed: stageResults.filter((result) => result.passed).length,
    total: stageResults.length,
  }
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

function formatEvalName(evalId: string, includeSubcategory = true) {
  const [, subcategory, sequence, ...slug] = evalId.split("-")
  const readableSlug = slug.join(" ")

  if (!subcategory || !sequence || !readableSlug) {
    return evalId.replaceAll("-", " ")
  }

  return includeSubcategory
    ? `${subcategory} ${sequence}: ${readableSlug}`
    : `${sequence}: ${readableSlug}`
}

const pageContainerClassName =
  "mx-auto w-full max-w-7xl px-6 lg:px-12 xl:px-24"

const subgroupLabelClassName =
  "rounded-md px-2 py-1 font-mono text-xs font-normal uppercase tracking-wide text-muted-foreground"

const evalMetaGridClassName =
  "grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-4 gap-y-4 text-xs"

const evalMetaLabelClassName =
  "w-[6.5rem] shrink-0 text-muted-foreground capitalize"

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
                className="-ml-6 mt-0.5 size-4 shrink-0 text-muted-foreground/50 transition-transform group-open:rotate-90"
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
            <span className="sr-only">
              {check.passed ? "Pass" : "Fail"}: {" "}
            </span>
            <span className="min-w-0 whitespace-pre-wrap">{check.name}</span>
          </span>
        )

        return (
          notes ? (
            <details key={`${index}-${check.name}`} className="group">
              <summary className="cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
                {checkRow}
              </summary>
              <p className="mt-1 ml-12 whitespace-pre-wrap text-muted-foreground">
                {notes}
              </p>
            </details>
          ) : (
            <div key={`${index}-${check.name}`}>{checkRow}</div>
          )
        )
      })}
    </div>
  )
}

/** One collapsible row per docs call (see DocsCall), expanding to the pages that call returned. */
function ResultDocsCalls({ calls }: { calls: DocsCall[] }) {
  return (
    <div className="flex flex-col gap-1.5 leading-relaxed text-foreground">
      {calls.map((call, index) => {
        const searchOnly = call.hasContent === false
        const Icon = docsCallIcon(call)
        return (
          <details key={index} className="group">
            <summary className="cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
              <span className="inline-flex w-full items-center gap-2">
                <ChevronRightIcon
                  className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-open:rotate-90"
                  aria-hidden
                />
                <Icon
                  className={cn("size-4 shrink-0", searchOnly ? "text-muted-foreground/60" : "text-muted-foreground")}
                  aria-hidden
                />
                <span
                  title={docsCallQueryLabel(call)}
                  className={cn("min-w-0 truncate", searchOnly ? "text-muted-foreground" : "text-foreground")}
                >
                  {docsCallQueryLabel(call)}
                </span>
                {docsCallSizeLabel(call) ? (
                  <span className="shrink-0 font-mono text-xs tracking-wide text-muted-foreground">
                    {docsCallSizeLabel(call)}
                  </span>
                ) : null}
                <span className={cn(subgroupLabelClassName, "shrink-0", DOCS_CALL_SOURCE_CHIP_CLASS[call.source])}>
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
                  No results recovered (the tool's output may have been truncated).
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

function getEvalIds(sourceResults: ParsedResult[]) {
  return Array.from(new Set(sourceResults.map((result) => result.eval))).sort(
    (a, b) => a.localeCompare(b)
  )
}

function getModelRows(sourceResults: ParsedResult[]): ModelResultRow[] {
  return getVisibleExperiments(sourceResults)
    .map((experiment) => {
      const experimentResults = getExperimentResults(experiment, sourceResults)
      const passed = experimentResults.filter((result) => result.passed).length
      const display = results.find(
        (result) => result.experiment === experiment
      )?.experimentDisplay

      return {
        experiment,
        label: experimentLabel.get(experiment) ?? experiment,
        shortLabel: formatModelColumnLabel(display, experiment),
        passed,
        passRate: experimentResults.length
          ? Math.round((passed / experimentResults.length) * 100)
          : 0,
        results: experimentResults,
        total: experimentResults.length,
      }
    })
    .sort(
      (a, b) =>
        b.passRate - a.passRate || a.label.localeCompare(b.label)
    )
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
      title={`${passed} of ${total} evals passed`}
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

const modelColumnHighlightClassName = "bg-muted/35"

function openExperimentKeyDown(
  event: KeyboardEvent,
  open: () => void
) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault()
    open()
  }
}

function ModelColumnCell({
  experiment,
  label,
  highlighted,
  onHoverChange,
  onSelect,
  children,
}: {
  experiment: string
  label: string
  highlighted: boolean
  onHoverChange: (experiment: string | null) => void
  onSelect: (experiment: string) => void
  children: ReactNode
}) {
  return (
    <td
      tabIndex={0}
      aria-label={`Open ${label}`}
      className={cn(
        "border-r border-b border-border px-2.5 py-2 cursor-pointer bg-card transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        highlighted && modelColumnHighlightClassName
      )}
      onMouseEnter={() => onHoverChange(experiment)}
      onClick={() => onSelect(experiment)}
      onKeyDown={(event) =>
        openExperimentKeyDown(event, () => onSelect(experiment))
      }
    >
      {children}
    </td>
  )
}

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
  const modelRows = getModelRows(sourceResults)
  const productKeys = getProductKeys(sourceResults)
  const evalIds = getEvalIds(sourceResults)
  const modelsAsRows = groupBy === "model"
  const [selectedExperiment, setSelectedExperiment] = useState<string | null>(
    null
  )
  const [hoveredExperiment, setHoveredExperiment] = useState<string | null>(
    null
  )

  const openExperiment = (experiment: string) => {
    setSelectedExperiment(experiment)
  }

  return (
    <Sheet
      open={selectedExperiment !== null}
      onOpenChange={(open) => {
        if (!open) setSelectedExperiment(null)
      }}
    >
      <div>
        <section
          aria-label="Results"
          className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_24px_80px_-36px_rgba(0,0,0,0.45),0_8px_28px_-18px_rgba(0,0,0,0.28)]"
        >
          <div className="flex min-h-12 flex-col gap-2 border-b border-border bg-secondary/70 px-2 py-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="w-full overflow-x-auto pb-0.5 lg:w-auto lg:pb-0">
              <GroupByControl
                value={groupBy}
                onValueChange={onGroupByChange}
              />
            </div>
            <div className="w-full overflow-x-auto pb-0.5 lg:w-auto lg:pb-0">
              <ExperimentSuiteControl
                value={selectedExperimentSuite}
                onValueChange={onExperimentSuiteChange}
              />
            </div>
          </div>
          <div className="overflow-x-auto">
            {modelRows.length ? (
              <table
                className={cn(
                  "w-full border-collapse text-[13px]",
                  modelsAsRows ? "min-w-[760px]" : "min-w-[1100px]"
                )}
                onMouseLeave={() => setHoveredExperiment(null)}
              >
                <thead className="bg-secondary/45 text-muted-foreground">
                  <tr>
                    <th
                      scope="col"
                      className={cn(
                        "border-r border-b border-border px-2.5 py-1.5 text-left font-mono text-xs font-normal tracking-wide text-muted-foreground uppercase",
                        groupBy === "eval" ? "min-w-64 w-72" : "w-64"
                      )}
                    >
                      {GROUP_BY_ROW_LABEL[groupBy]}
                    </th>
                    {modelsAsRows
                      ? JOURNEY_STAGES.map((stage) => (
                          <th
                            key={stage.id}
                            scope="col"
                            className="w-24 border-r border-b border-border px-2.5 py-1.5 text-left font-mono text-xs font-normal tracking-wide text-muted-foreground uppercase"
                          >
                            <TableHeaderLabel tooltip={stage.description}>
                              {stage.label}
                            </TableHeaderLabel>
                          </th>
                        ))
                      : modelRows.map((row) => (
                          <th
                            key={row.experiment}
                            scope="col"
                            title={row.label}
                            className={cn(
                              "min-w-28 border-r border-b border-border px-2.5 py-1.5 text-left font-mono text-xs font-normal tracking-wide text-muted-foreground uppercase transition-colors",
                              hoveredExperiment === row.experiment &&
                                modelColumnHighlightClassName
                            )}
                            onMouseEnter={() =>
                              setHoveredExperiment(row.experiment)
                            }
                          >
                            <span className="block truncate">{row.shortLabel}</span>
                          </th>
                        ))}
                    <th
                      scope="col"
                      className="w-20 border-b border-border px-2.5 py-1.5 text-left font-mono text-xs font-normal tracking-wide text-muted-foreground uppercase"
                    >
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody className="[&>tr:last-child>th]:border-b-0 [&>tr:last-child>td]:border-b-0">
                  {modelsAsRows
                    ? modelRows.map((row) => (
                        <tr
                          key={row.experiment}
                          tabIndex={0}
                          className={clickableTableItemClassName}
                          onClick={() => openExperiment(row.experiment)}
                          onKeyDown={(event) =>
                            openExperimentKeyDown(event, () =>
                              openExperiment(row.experiment)
                            )
                          }
                        >
                          <th
                            scope="row"
                            className="border-r border-b border-border px-2.5 py-2 text-left font-normal text-foreground"
                          >
                            <span className="block truncate font-medium">
                              {row.label}
                            </span>
                          </th>
                          {JOURNEY_STAGES.map((stage) => {
                            const summary = getExperimentStageSummary(
                              row.experiment,
                              stage.id,
                              row.results
                            )

                            return (
                              <td
                                key={stage.id}
                                className="border-r border-b border-border px-2.5 py-2"
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
                              passed={row.passed}
                              total={row.total}
                              isTotal
                            />
                          </td>
                        </tr>
                      ))
                    : null}

                  {groupBy === "stage"
                    ? JOURNEY_STAGES.map((stage) => {
                        const stageResults = getStageResults(
                          stage.id,
                          sourceResults
                        )
                        const totalSummary = scoreResults(stageResults)

                        return (
                          <tr key={stage.id} className="bg-card">
                            <th
                              scope="row"
                              className="border-r border-b border-border px-2.5 py-2 text-left font-normal text-foreground"
                            >
                              <TableHeaderLabel tooltip={stage.description}>
                                <span className="font-medium">{stage.label}</span>
                              </TableHeaderLabel>
                            </th>
                            {modelRows.map((row) => {
                              const summary = getExperimentStageSummary(
                                row.experiment,
                                stage.id,
                                row.results
                              )

                              return (
                                <ModelColumnCell
                                  key={row.experiment}
                                  experiment={row.experiment}
                                  label={row.label}
                                  highlighted={
                                    hoveredExperiment === row.experiment
                                  }
                                  onHoverChange={setHoveredExperiment}
                                  onSelect={openExperiment}
                                >
                                  <ScoreCell
                                    passed={summary.passed}
                                    total={summary.total}
                                  />
                                </ModelColumnCell>
                              )
                            })}
                            <td className="border-b border-border px-2.5 py-2">
                              <ScoreCell
                                passed={totalSummary.passed}
                                total={totalSummary.total}
                                isTotal
                              />
                            </td>
                          </tr>
                        )
                      })
                    : null}

                  {groupBy === "product"
                    ? productKeys.map((product) => {
                        const productResults = getProductResults(
                          product,
                          sourceResults
                        )
                        const totalSummary = scoreResults(productResults)

                        return (
                          <tr key={product} className="bg-card">
                            <th
                              scope="row"
                              className="border-r border-b border-border px-2.5 py-2 text-left font-normal text-foreground"
                            >
                              <span className="font-medium">
                                {formatProductLabel(product)}
                              </span>
                            </th>
                            {modelRows.map((row) => {
                              const summary = scoreResults(
                                getProductResults(product, row.results)
                              )

                              return (
                                <ModelColumnCell
                                  key={row.experiment}
                                  experiment={row.experiment}
                                  label={row.label}
                                  highlighted={
                                    hoveredExperiment === row.experiment
                                  }
                                  onHoverChange={setHoveredExperiment}
                                  onSelect={openExperiment}
                                >
                                  <ScoreCell
                                    passed={summary.passed}
                                    total={summary.total}
                                  />
                                </ModelColumnCell>
                              )
                            })}
                            <td className="border-b border-border px-2.5 py-2">
                              <ScoreCell
                                passed={totalSummary.passed}
                                total={totalSummary.total}
                                isTotal
                              />
                            </td>
                          </tr>
                        )
                      })
                    : null}

                  {groupBy === "eval"
                    ? evalIds.map((evalId) => {
                        const evalResults = getEvalResults(
                          evalId,
                          sourceResults
                        )
                        const totalSummary = scoreResults(evalResults)

                        return (
                          <tr key={evalId} className="bg-card">
                            <th
                              scope="row"
                              className="border-r border-b border-border px-2.5 py-2 text-left font-normal text-foreground"
                            >
                              <span
                                className="block truncate font-medium"
                                title={evalId}
                              >
                                {formatEvalName(evalId)}
                                <span className="sr-only"> {evalId}</span>
                              </span>
                            </th>
                            {modelRows.map((row) => {
                              const result = row.results.find(
                                (item) => item.eval === evalId
                              )
                              const summary = {
                                passed: result?.passed ? 1 : 0,
                                total: result ? 1 : 0,
                              }

                              return (
                                <ModelColumnCell
                                  key={row.experiment}
                                  experiment={row.experiment}
                                  label={row.label}
                                  highlighted={
                                    hoveredExperiment === row.experiment
                                  }
                                  onHoverChange={setHoveredExperiment}
                                  onSelect={openExperiment}
                                >
                                  <ScoreCell
                                    passed={summary.passed}
                                    total={summary.total}
                                  />
                                </ModelColumnCell>
                              )
                            })}
                            <td className="border-b border-border px-2.5 py-2">
                              <ScoreCell
                                passed={totalSummary.passed}
                                total={totalSummary.total}
                                isTotal
                              />
                            </td>
                          </tr>
                        )
                      })
                    : null}
                </tbody>
              </table>
            ) : (
              <div className="grid min-h-72 place-items-center px-6 text-center text-sm text-muted-foreground">
                No results match the selected filters.
              </div>
            )}
          </div>
        </section>
      </div>
      {selectedExperiment ? (
        <ExperimentSheet
          experiment={selectedExperiment}
          sourceResults={sourceResults}
        />
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

function ExperimentSheet({
  experiment,
  sourceResults,
}: {
  experiment: string
  sourceResults: ParsedResult[]
}) {
  const experimentResults = getExperimentResults(experiment, sourceResults)
  const passed = experimentResults.filter((result) => result.passed).length
  const passRate = experimentResults.length
    ? Math.round((passed / experimentResults.length) * 100)
    : null
  const r = results.find((result) => result.experiment === experiment)
  const display = r?.experimentDisplay
  const agentLabel = display ? AGENT_LABELS[display.agent] : experiment
  const modelLabel = display ? formatModelWithModifiers(display) : ""
  const [expandedEval, setExpandedEval] = useState<string | null>(null)

  const toggleEval = (evalId: string) => {
    setExpandedEval((current) => (current === evalId ? null : evalId))
  }

  return (
    <SheetContent className="max-w-4xl shadow-none">
      <SheetHeader className="flex-row items-end justify-between gap-6">
        <SheetTitle className="flex flex-col gap-1 pr-0 font-heading tracking-normal">
          <span className="text-xl leading-none font-medium text-muted-foreground">
            {agentLabel}
          </span>
          <span className="text-xl leading-none font-medium text-foreground">
            {modelLabel}
          </span>
        </SheetTitle>
        <SheetDescription className="flex shrink-0 flex-col items-end gap-3 pb-0.5 text-right">
          <span>
            {passed} of {experimentResults.length} evals pass
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
        <table className="w-full min-w-[720px] border-collapse text-[13px]">
          <thead className="sticky top-0 z-10 bg-secondary/95 text-muted-foreground backdrop-blur">
            <tr>
              <th className="w-[38%] border-r border-b border-border pr-3 pl-6 py-2 text-left font-mono text-xs font-normal tracking-wide text-muted-foreground uppercase">
                Evaluation
              </th>
              <th className="w-28 border-r border-b border-border px-3 py-2 text-left font-mono text-xs font-normal tracking-wide text-muted-foreground uppercase">
                Journey
              </th>
              <th className="border-r border-b border-border px-3 py-2 text-left font-mono text-xs font-normal tracking-wide text-muted-foreground uppercase">
                Product
              </th>
              <th className="w-20 border-b border-border px-3 py-2 text-left font-mono text-xs font-normal tracking-wide text-muted-foreground uppercase">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {experimentResults.map((result) => {
              const expanded = expandedEval === result.eval
              const stage =
                JOURNEY_STAGES.find((item) => item.id === result.category)
                  ?.label ?? "Unknown"

              return (
                <Fragment key={result.eval}>
                  <tr
                    tabIndex={0}
                    aria-expanded={expanded}
                    className="cursor-pointer bg-card transition-colors outline-none hover:bg-muted/35 focus-visible:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    onClick={() => toggleEval(result.eval)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        toggleEval(result.eval)
                      }
                    }}
                  >
                    <th className="border-r border-b border-border pr-3 pl-6 py-2.5 text-left font-normal text-foreground">
                      {formatEvalName(result.eval)}
                    </th>
                    <td className="border-r border-b border-border px-3 py-2.5 text-muted-foreground">
                      {stage}
                    </td>
                    <td className="border-r border-b border-border px-3 py-2.5 text-muted-foreground">
                      {result.product.length
                        ? result.product.map(formatProductLabel).join(", ")
                        : "Unassigned"}
                    </td>
                    <td className="border-b border-border px-3 py-2.5">
                      <span
                        className={cn(
                          "font-mono text-xs",
                          result.passed
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"
                        )}
                      >
                        {result.passed ? "Pass" : "Fail"}
                      </span>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="border-b border-border bg-secondary/35 px-6 py-5"
                      >
                        <EvaluationDetails result={result} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </SheetContent>
  )
}

function SupabaseLogo({ className }: { className?: string } = {}) {
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

  return (
    <button
      type="button"
      className="flex h-[38px] w-fit items-center justify-between gap-4 rounded-md border border-input bg-background px-4 py-2 text-left font-mono text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-accent hover:text-foreground focus-visible:outline-4 focus-visible:outline-offset-1 focus-visible:outline-ring"
      onClick={() => {
        void navigator.clipboard.writeText(CLI_COMMAND)
        setCopied(true)
        if (resetTimeoutRef.current !== null) {
          window.clearTimeout(resetTimeoutRef.current)
        }
        resetTimeoutRef.current = window.setTimeout(() => {
          setCopied(false)
          resetTimeoutRef.current = null
        }, COPY_FEEDBACK_MS)
      }}
      aria-label={copied ? "Copied" : `Copy ${CLI_COMMAND}`}
    >
      <span className="truncate">{CLI_COMMAND}</span>
      {copied ? (
        <CheckIcon className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <CopyIcon className="size-3.5 shrink-0" aria-hidden />
      )}
    </button>
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

function EvalOverviewCards() {
  const cards = [
    {
      title: "Real project context",
      description:
        "Each eval pairs a task prompt with the seeded remote state and local workspace the scenario requires.",
      Icon: FileTextIcon,
    },
    {
      title: "Controlled experiments",
      description:
        "Every run fixes the agent, model, runtime, tools, and skills, making benchmark comparisons explicit.",
      Icon: BotIcon,
    },
    {
      title: "Scored outcomes",
      description:
        "Scorers evaluate what the agent changed or reported, with checks and run details kept for review.",
      Icon: CheckIcon,
    },
  ]

  return (
    <section aria-label="How evaluations run">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {cards.map(({ title, description, Icon }) => (
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
                href="https://supabase.com"
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
