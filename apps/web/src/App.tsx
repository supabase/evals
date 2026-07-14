import { useEffect, useRef, useState, type ReactNode } from "react"
import { BotIcon, CheckIcon, CopyIcon, XIcon } from "lucide-react"
import { type EvalResult } from "@supabase-evals/core/eval-metadata"

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
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
type GroupBy = "stage" | "model" | "product" | "eval"

type ParsedResult = Omit<EvalResult, "product" | "topic"> & {
  category: JourneyStage | "unknown"
  product: string[]
  topic: string[]
  primaryCategory: string
}

type CheckResult = NonNullable<ParsedResult["checks"]>[number]

type ExperimentStageSummary = {
  experiment: string
  category: JourneyStage | "overall"
  passed: number
  total: number
}

type ExperimentStageGroup = {
  category: string
  passed: number
  results: ParsedResult[]
  total: number
}

type ChartBar = {
  label: string
  summary: ExperimentStageSummary
}

function getBarPassRate(bar: ChartBar) {
  const { passed, total } = bar.summary
  return total ? Math.round((passed / total) * 100) : 0
}

function sortBarsByScore(bars: ChartBar[]) {
  return [...bars].sort((a, b) => {
    const scoreDelta = getBarPassRate(b) - getBarPassRate(a)
    return scoreDelta || a.label.localeCompare(b.label)
  })
}

function sortGroupsByPassRate(groups: TimelineGroup[]) {
  return [...groups].sort((a, b) => {
    const scoreDelta = (b.passRate ?? 0) - (a.passRate ?? 0)
    return scoreDelta || a.label.localeCompare(b.label)
  })
}

type TimelineGroup = {
  description?: string
  id: string
  label: string
  meta: string
  passRate?: number
  sourceResults: ParsedResult[]
  bars: ChartBar[]
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

// Runtime-populated result store. Data is loaded from Supabase (see
// data/eval-results.ts) and installed by initResultsStore() before the app is
// mounted, so these module-scope bindings are ready by first render.
let results: ParsedResult[] = []
let experiments: string[] = []
let experimentLabel = new Map<string, string>()
let sortedResults: ParsedResult[] = []

export function initResultsStore(data: EvalResult[]): void {
  results = data.map(parseResult)
  experiments = Array.from(
    new Set(results.map((result) => result.experiment))
  ).sort((a, b) => a.localeCompare(b))
  experimentLabel = new Map(
    experiments.map((experiment) => [experiment, buildExperimentLabel(experiment)])
  )
  sortedResults = [...results].sort(sortResults)
}

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
      className="inline-grid w-fit grid-cols-2 rounded-full border border-border bg-muted/35 p-1"
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
              "h-9 min-w-28 rounded-full px-4 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "bg-foreground text-background shadow-sm"
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
    <ToggleGroup
      type="single"
      variant="outline"
      value={value}
      onValueChange={(nextValue) => {
        if (
          nextValue === "stage" ||
          nextValue === "model" ||
          nextValue === "product" ||
          nextValue === "eval"
        ) {
          onValueChange(nextValue)
        }
      }}
      className="w-fit"
    >
      <ToggleGroupItem value="stage">Group by journey</ToggleGroupItem>
      <ToggleGroupItem value="model">Group by model</ToggleGroupItem>
      <ToggleGroupItem value="product">Group by product</ToggleGroupItem>
      <ToggleGroupItem value="eval">Group by eval</ToggleGroupItem>
    </ToggleGroup>
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

function getVisibleExperiments(sourceResults: ParsedResult[]) {
  return Array.from(
    new Set(sourceResults.map((result) => result.experiment))
  ).sort((a, b) => a.localeCompare(b))
}

function buildExperimentLabel(exp: string): string {
  const r = results.find((r) => r.experiment === exp)
  return formatExperimentLabel(r?.experimentDisplay, exp)
}

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

function getStageResults(
  category: JourneyStage,
  sourceResults = sortedResults
) {
  return sourceResults.filter((result) => result.category === category)
}

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

function getExperimentOverallSummary(
  experiment: string,
  sourceResults = sortedResults
): ExperimentStageSummary {
  const experimentResults = getExperimentResults(experiment, sourceResults)

  return {
    experiment,
    category: "overall",
    passed: experimentResults.filter((result) => result.passed).length,
    total: experimentResults.length,
  }
}

function getEvalResults(evalId: string, sourceResults = sortedResults) {
  return sourceResults.filter((result) => result.eval === evalId)
}

function getExperimentStageGroups(
  experiment: string,
  category: JourneyStage,
  sourceResults = sortedResults
): ExperimentStageGroup[] {
  const stageResults = getExperimentResults(experiment, sourceResults).filter(
    (result) => result.category === category
  )
  const groupedResults = new Map<string, ParsedResult[]>()

  for (const result of stageResults) {
    const existing = groupedResults.get(result.primaryCategory)

    if (existing) {
      existing.push(result)
    } else {
      groupedResults.set(result.primaryCategory, [result])
    }
  }

  return Array.from(groupedResults.entries())
    .map(([category, results]) => ({
      category,
      passed: results.filter((result) => result.passed).length,
      results,
      total: results.length,
    }))
    .sort((a, b) => a.category.localeCompare(b.category))
}

function formatTagLabel(value: string) {
  return value
    .split(" ")
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part))
    .join(" ")
}

function formatProductLabel(value: string) {
  if (value === UNASSIGNED_PRODUCT) {
    return "Unassigned"
  }

  return formatTagLabel(value)
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

function formatPassPercentage(passed: number, total: number) {
  return total ? `${Math.round((passed / total) * 100)}%` : "0%"
}

function formatGroupLabel(label: string) {
  return label ? `${label[0].toUpperCase()}${label.slice(1)}` : label
}

const pageContainerClassName =
  "mx-auto w-full max-w-screen-2xl px-6 sm:px-8 md:px-12 lg:px-8 xl:px-24"

const groupHeadingClassName =
  "font-heading text-[24px] leading-[33px] font-normal tracking-[-0.16px] text-foreground"

const subgroupLabelClassName =
  "rounded-md px-2 py-1 font-mono text-xs font-normal uppercase tracking-wide text-muted-foreground"

const subgroupMetaClassName =
  "mr-3 shrink-0 font-mono text-xs tracking-wide text-muted-foreground"

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
        const hasJudgeNotes = check.judgeNotes !== undefined

        return (
          <div key={`${index}-${check.name}`}>
            <div className="flex items-start gap-2">
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
                {check.passed ? "Pass" : "Fail"}:{" "}
              </span>
              <span className="min-w-0 whitespace-pre-wrap">{check.name}</span>
            </div>
            {notes ? (
              <details className="mt-1 ml-6 text-muted-foreground">
                <summary className="cursor-pointer text-xs tracking-wide uppercase">
                  <span className="inline-flex items-center gap-1.5">
                    {hasJudgeNotes ? (
                      <BotIcon className="size-3.5 text-muted-foreground/70" />
                    ) : null}
                    {hasJudgeNotes ? "Judge notes" : "Notes"}
                  </span>
                </summary>
                <p className="mt-1 whitespace-pre-wrap text-foreground">
                  {notes}
                </p>
              </details>
            ) : null}
          </div>
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

function getTimelineGroups(
  groupBy: GroupBy,
  sourceResults: ParsedResult[]
): TimelineGroup[] {
  const visibleExperiments = getVisibleExperiments(sourceResults)

  if (groupBy === "model") {
    return sortGroupsByPassRate(
      visibleExperiments
        .map((experiment) => {
          const experimentResults = getExperimentResults(
            experiment,
            sourceResults
          )
          const bars = JOURNEY_STAGES.map((stage) => ({
            label: stage.label,
            summary: getExperimentStageSummary(
              experiment,
              stage.id,
              experimentResults
            ),
          })).filter((bar) => bar.summary.total > 0)
          const passed = experimentResults.filter(
            (result) => result.passed
          ).length
          const summary = getExperimentOverallSummary(
            experiment,
            experimentResults
          )

          return {
            id: experiment,
            label: formatGroupLabel(
              experimentLabel.get(experiment) ?? experiment
            ),
            meta: formatPassPercentage(summary.passed, summary.total),
            passRate: experimentResults.length
              ? Math.round((passed / experimentResults.length) * 100)
              : 0,
            sourceResults: experimentResults,
            bars,
          }
        })
        .filter((group) => group.sourceResults.length > 0)
    )
  }

  if (groupBy === "product") {
    return getProductKeys(sourceResults).map((product) => {
      const productResults = getProductResults(product, sourceResults)
      const bars = sortBarsByScore(
        visibleExperiments
          .map((experiment) => ({
            label: experimentLabel.get(experiment) ?? experiment,
            summary: getExperimentOverallSummary(experiment, productResults),
          }))
          .filter((bar) => bar.summary.total > 0)
      )
      const passed = productResults.filter((result) => result.passed).length

      return {
        id: product,
        label: formatGroupLabel(formatProductLabel(product)),
        meta: formatPassPercentage(passed, productResults.length),
        sourceResults: productResults,
        bars,
      }
    })
  }

  if (groupBy === "eval") {
    // Preserve sortedResults order so eval rows follow journey/topic sorting.
    const evalIds = Array.from(
      new Set(sourceResults.map((result) => result.eval))
    )

    return evalIds.map((evalId) => {
      const evalResults = getEvalResults(evalId, sourceResults)
      const bars = sortBarsByScore(
        visibleExperiments
          .map((experiment) => ({
            label: experimentLabel.get(experiment) ?? experiment,
            summary: getExperimentOverallSummary(experiment, evalResults),
          }))
          .filter((bar) => bar.summary.total > 0)
      )
      const passed = evalResults.filter((result) => result.passed).length

      return {
        id: evalId,
        label: formatGroupLabel(formatEvalName(evalId)),
        meta: formatPassPercentage(passed, evalResults.length),
        description: evalId,
        sourceResults: evalResults,
        bars,
      }
    })
  }

  return JOURNEY_STAGES.map((stage) => {
    const stageResults = getStageResults(stage.id, sourceResults)
    const bars = sortBarsByScore(
      visibleExperiments
        .map((experiment) => ({
          label: experimentLabel.get(experiment) ?? experiment,
          summary: getExperimentStageSummary(
            experiment,
            stage.id,
            sourceResults
          ),
        }))
        .filter((bar) => bar.summary.total > 0)
    )
    const passed = stageResults.filter((result) => result.passed).length

    return {
      description: stage.description,
      id: stage.id,
      label: formatGroupLabel(stage.label),
      meta: formatPassPercentage(passed, stageResults.length),
      sourceResults,
      bars,
    }
  })
}

function SummaryBar({
  label,
  sourceResults,
  summary,
  interactive = true,
}: {
  label: string
  sourceResults: ParsedResult[]
  summary: ExperimentStageSummary
  interactive?: boolean
}) {
  const passRate = summary.total
    ? Math.round((summary.passed / summary.total) * 100)
    : 0

  const bar = (
    <div
      className={cn(
        "flex w-full min-w-0 flex-col gap-2 rounded-xl px-3 py-3 text-left outline-none",
        interactive &&
          "transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <span className="truncate font-mono text-sm font-normal text-foreground">
          {label}
        </span>
        <span className="shrink-0 font-mono text-sm font-normal text-foreground">
          {passRate}%
        </span>
      </div>
      <div className="h-[3px] w-full bg-foreground/20">
        <div
          className="h-full bg-foreground transition-all group-hover:bg-foreground/90"
          style={{ width: `${passRate}%` }}
        />
      </div>
    </div>
  )

  if (!interactive) {
    return bar
  }

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          className="w-full text-left outline-none"
          aria-label={`${label}: ${summary.passed} of ${summary.total} evals passed`}
        >
          {bar}
        </button>
      </SheetTrigger>
      <ExperimentSheet
        experiment={summary.experiment}
        sourceResults={sourceResults}
      />
    </Sheet>
  )
}

function TimelineGroupRow({
  group,
  groupBy,
}: {
  group: TimelineGroup
  groupBy: GroupBy
}) {
  const isModelGroup = groupBy === "model" && group.passRate != null

  const rowContent = (
    <div
      className={cn(
        pageContainerClassName,
        "grid grid-cols-1 gap-4 lg:grid-cols-[26rem_minmax(0,1fr)] lg:gap-8"
      )}
    >
      <div className="sticky top-40 z-10 flex min-w-0 flex-col gap-3 self-start pb-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className={groupHeadingClassName}>{group.label}</h2>
          {group.passRate != null ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <p
                className={cn(
                  "text-2xl leading-none font-light tracking-[-0.02em]",
                  getPassRateClass(group.passRate)
                )}
              >
                {group.meta}
              </p>
            </div>
          ) : null}
        </div>
        {group.description ? (
          groupBy === "eval" ? (
            <code
              className="inline-flex max-w-full rounded-md border bg-muted/35 px-2 py-1 font-mono text-xs leading-5 text-muted-foreground"
              title={group.description}
            >
              <span className="truncate">{group.description}</span>
            </code>
          ) : (
            <p className="text-sm leading-5 text-muted-foreground">
              {group.description}
            </p>
          )
        ) : null}
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-col gap-2">
          {group.bars.length ? (
            group.bars.map((bar) => (
              <SummaryBar
                key={`${group.id}-${bar.summary.experiment}-${bar.summary.category}-${bar.label}`}
                label={bar.label}
                sourceResults={group.sourceResults}
                summary={bar.summary}
                interactive={!isModelGroup}
              />
            ))
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              No results
            </div>
          )}
        </div>
      </div>
    </div>
  )

  if (!isModelGroup) {
    return (
      <section className="w-full border-b border-border py-10 md:py-12">
        {rowContent}
      </section>
    )
  }

  return (
    <Sheet>
      <section className="relative w-full border-b border-border py-10 transition-colors hover:bg-muted/50 md:py-12">
        <SheetTrigger asChild>
          <button
            type="button"
            className="absolute inset-0 z-10 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${group.label} model row`}
          />
        </SheetTrigger>
        {rowContent}
      </section>
      <ExperimentSheet
        experiment={group.id}
        sourceResults={group.sourceResults}
      />
    </Sheet>
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
  const r = results.find((result) => result.experiment === experiment)
  const display = r?.experimentDisplay
  const agentLabel = display ? AGENT_LABELS[display.agent] : experiment
  const modelLabel = display ? formatModelWithModifiers(display) : ""
  const [isScrolled, setIsScrolled] = useState(false)

  return (
    <SheetContent className="max-w-3xl">
      <SheetHeader className="flex-row items-end justify-between gap-6 border-b-0">
        <SheetTitle className="flex flex-col gap-1 pr-0 font-heading tracking-[-0.02em]">
          <span className="text-3xl leading-none font-light text-muted-foreground">
            {agentLabel}
          </span>
          <span className="text-3xl leading-none font-light text-foreground">
            {modelLabel}
          </span>
        </SheetTitle>
        <SheetDescription className="flex shrink-0 flex-col items-end gap-3 pb-0.5 text-right">
          <span>
            {passed} of {experimentResults.length} evals passed
          </span>
        </SheetDescription>
      </SheetHeader>
      <div
        className={cn(
          "pointer-events-none relative z-10 h-0 opacity-0 transition-opacity",
          isScrolled && "opacity-100"
        )}
      >
        <div className="absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-background to-transparent" />
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-6 pt-3 pb-6"
        onScroll={(event) => {
          const nextIsScrolled = event.currentTarget.scrollTop > 0
          setIsScrolled((current) =>
            current === nextIsScrolled ? current : nextIsScrolled
          )
        }}
      >
        {JOURNEY_STAGES.map((stage) => {
          const stageResults = experimentResults.filter(
            (result) => result.category === stage.id
          )
          const stageGroups = getExperimentStageGroups(
            experiment,
            stage.id,
            sourceResults
          )

          if (!stageResults.length) {
            return null
          }

          return (
            <section
              key={stage.id}
              className="grid grid-cols-1 gap-3 border-t pt-5 sm:grid-cols-[9rem_1fr] sm:items-baseline"
            >
              <h2 className={groupHeadingClassName}>{stage.label}</h2>
              <div className="flex min-w-0 flex-col gap-5">
                {stageGroups.map((group) => (
                  <div
                    key={group.category}
                    className="flex min-w-0 flex-col gap-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <h3 className={subgroupLabelClassName}>
                        {group.category}
                      </h3>
                      <span className={subgroupMetaClassName}>
                        {group.passed}/{group.total}
                      </span>
                    </div>
                    <Accordion type="single" collapsible className="min-w-0">
                      {group.results.map((result) => (
                        <AccordionItem key={result.eval} value={result.eval}>
                          <AccordionTrigger>
                            <div className="flex w-full min-w-0 flex-1 flex-col gap-2">
                              <div className="flex items-start justify-between gap-3">
                                <span className="min-w-0 font-mono text-sm leading-snug font-normal">
                                  {formatEvalName(result.eval, false)}
                                </span>
                                <span
                                  className={cn(
                                    "shrink-0 font-mono text-xs tracking-wide",
                                    result.passed
                                      ? "text-emerald-600 dark:text-emerald-400"
                                      : "text-red-600 dark:text-red-400"
                                  )}
                                >
                                  {result.passed ? "Pass" : "Fail"}
                                </span>
                              </div>
                              <div
                                className={cn(
                                  "h-[3px] w-full",
                                  result.passed
                                    ? "bg-emerald-500"
                                    : "bg-red-500"
                                )}
                              />
                            </div>
                          </AccordionTrigger>
                          <AccordionContent
                            animated={false}
                            className="flex flex-col gap-4"
                          >
                            <dl className={evalMetaGridClassName}>
                              <EvalMetadataRow
                                label="Attempts"
                                value={result.attempts ?? "-"}
                              />
                              <EvalMetadataRow
                                label="Source"
                                value={
                                  <span className="truncate">
                                    {result.sourcePath}
                                  </span>
                                }
                              />
                              <EvalMetadataRow
                                label="Product"
                                value={result.product.join(", ") || "-"}
                              />
                              <EvalMetadataRow
                                label="Topic"
                                value={result.topic.join(", ") || "-"}
                              />
                              {result.checks?.length ? (
                                <EvalMetadataRow
                                  label="Result details"
                                  value={
                                    <ResultChecks checks={result.checks} />
                                  }
                                />
                              ) : null}
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
                            </dl>
                          </AccordionContent>
                        </AccordionItem>
                      ))}
                    </Accordion>
                  </div>
                ))}
              </div>
            </section>
          )
        })}
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
      className="flex w-fit items-center justify-between gap-4 rounded-md border bg-muted/25 px-3 py-2 text-left font-mono text-xs text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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

function FooterCta() {
  const [patternReplayKey, setPatternReplayKey] = useState(0)

  return (
    <footer
      className="bg-card text-center"
      onMouseEnter={() => setPatternReplayKey((key) => key + 1)}
    >
      <div className="px-6 py-24 sm:py-28 lg:py-36">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-8">
          <SupabaseLogo className="h-8" />
          <h2 className="font-heading text-2xl leading-[1.05] font-light tracking-[-0.03em] sm:text-3xl lg:text-4xl xl:text-5xl">
            <span className="block text-foreground">Set your agent free</span>
            <span className="block text-muted-foreground">
              with a Supabase project
            </span>
          </h2>
          <div className="flex flex-col items-center gap-3 sm:flex-row">
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
  const [groupBy, setGroupBy] = useState<GroupBy>("stage")
  const [selectedExperimentSuite, setSelectedExperimentSuite] =
    useState<SelectedExperimentSuite>("benchmark")
  const experimentSuiteResults = sortedResults.filter(
    (result) => result.experimentSuite === selectedExperimentSuite
  )
  const timelineGroups = getTimelineGroups(groupBy, experimentSuiteResults)

  return (
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
            <HeroGridPattern height={200} />
            <div className="w-full py-12 sm:pt-16 sm:pb-14 md:pt-20 md:pb-16 lg:pt-28 lg:pb-20 xl:pt-32">
              <div
                className={cn(
                  pageContainerClassName,
                  "flex flex-col gap-10 md:gap-12 lg:flex-row lg:items-end lg:justify-between lg:gap-16"
                )}
              >
                <div className="flex max-w-2xl min-w-0 flex-col gap-8 sm:gap-10">
                  <h1 className="font-heading text-3xl leading-[1.05] font-light tracking-[-0.03em] sm:text-4xl lg:text-5xl xl:text-6xl">
                    <span className="block text-foreground">
                      Evaluating agents across
                    </span>
                    <span className="block text-muted-foreground">
                      the Supabase journey.
                    </span>
                  </h1>
                </div>
                <p className="max-w-xl text-base leading-6 tracking-[-0.011em] text-pretty text-muted-foreground lg:max-w-2xl lg:flex-1 lg:pb-1">
                  We evaluate model experiments against each step of the
                  Supabase developer journey, from building application
                  primitives through deploying, investigating issues, and
                  resolving production problems with the right project context.
                </p>
              </div>
            </div>
          </header>
          <div className="sticky top-[57px] z-40 border-b border-border bg-background/95 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/85">
            <div
              className={cn(
                pageContainerClassName,
                "flex flex-wrap items-center gap-3 md:justify-between"
              )}
            >
              <GroupByControl value={groupBy} onValueChange={setGroupBy} />
              <ExperimentSuiteControl
                value={selectedExperimentSuite}
                onValueChange={setSelectedExperimentSuite}
              />
            </div>
          </div>
          <div className="flex flex-col">
            {timelineGroups.length ? (
              timelineGroups.map((group) => (
                <TimelineGroupRow
                  key={group.id}
                  group={group}
                  groupBy={groupBy}
                />
              ))
            ) : (
              <div className="grid min-h-72 place-items-center px-6 text-center text-sm text-muted-foreground">
                No results match the selected filters.
              </div>
            )}
          </div>
          <FooterCta />
        </>
      ) : (
        <div className="grid flex-1 place-items-center px-6 text-center text-sm text-muted-foreground">
          No result files found in the repo results directory.
        </div>
      )}
    </main>
  )
}

export default App
