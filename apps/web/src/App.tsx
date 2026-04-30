import rawResults, { type EvalResult } from "virtual:supabase-eval-results"
import { useState } from "react"
import { CopyIcon, InfoIcon } from "lucide-react"

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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"

const JOURNEY_STAGES = [
  {
    id: "design",
    label: "Design",
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
    id: "observe",
    label: "Observe",
    description:
      "Measures how well an agent can gather the project and observability context it needs, primarily through the mock management API.",
  },
  {
    id: "detect",
    label: "Detect",
    description:
      "Tests whether an agent can interpret observability data, optionally combine it with code context, and identify the underlying issues.",
  },
  {
    id: "resolve",
    label: "Resolve",
    description:
      "Tests whether an agent can turn detected issues into a solution, either by changing project code or using tools such as database.query.",
  },
] as const

const CLI_COMMAND = "npx skills add supabase/agent-skills"

type JourneyStage = (typeof JOURNEY_STAGES)[number]["id"]

type ParsedResult = EvalResult & {
  category: JourneyStage | "unknown"
  subcategory: string
}

type ExperimentStageSummary = {
  experiment: string
  category: JourneyStage | "overall"
  passed: number
  total: number
}

type ExperimentStageGroup = {
  subcategory: string
  passed: number
  results: ParsedResult[]
  total: number
}

const stageIndex = new Map(
  JOURNEY_STAGES.map((stage, index) => [stage.id, index])
)

function parseResult(result: EvalResult): ParsedResult {
  const [category, subcategory = "uncategorized"] = result.eval.split("-")
  const isKnownStage = JOURNEY_STAGES.some((stage) => stage.id === category)

  return {
    ...result,
    category: isKnownStage ? (category as JourneyStage) : "unknown",
    subcategory,
  }
}

const results = rawResults.map(parseResult)
const experiments = Array.from(
  new Set(results.map((result) => result.experiment))
).sort((a, b) => a.localeCompare(b))

function sortResults(a: ParsedResult, b: ParsedResult) {
  const categoryDelta =
    (stageIndex.get(a.category as JourneyStage) ?? Number.MAX_SAFE_INTEGER) -
    (stageIndex.get(b.category as JourneyStage) ?? Number.MAX_SAFE_INTEGER)

  return (
    categoryDelta ||
    a.subcategory.localeCompare(b.subcategory) ||
    a.eval.localeCompare(b.eval)
  )
}

const sortedResults = [...results].sort(sortResults)

function getStageResults(category: JourneyStage) {
  return sortedResults.filter((result) => result.category === category)
}

function getExperimentResults(experiment: string) {
  return sortedResults.filter((result) => result.experiment === experiment)
}

function getExperimentStageSummary(
  experiment: string,
  category: JourneyStage
): ExperimentStageSummary {
  const stageResults = results.filter(
    (result) =>
      result.experiment === experiment && result.category === category
  )

  return {
    experiment,
    category,
    passed: stageResults.filter((result) => result.passed).length,
    total: stageResults.length,
  }
}

function getExperimentOverallSummary(experiment: string): ExperimentStageSummary {
  const experimentResults = getExperimentResults(experiment)

  return {
    experiment,
    category: "overall",
    passed: experimentResults.filter((result) => result.passed).length,
    total: experimentResults.length,
  }
}

function getExperimentStageGroups(
  experiment: string,
  category: JourneyStage
): ExperimentStageGroup[] {
  const stageResults = getExperimentResults(experiment).filter(
    (result) => result.category === category
  )
  const groupedResults = new Map<string, ParsedResult[]>()

  for (const result of stageResults) {
    const existing = groupedResults.get(result.subcategory)

    if (existing) {
      existing.push(result)
    } else {
      groupedResults.set(result.subcategory, [result])
    }
  }

  return Array.from(groupedResults.entries())
    .map(([subcategory, results]) => ({
      subcategory,
      passed: results.filter((result) => result.passed).length,
      results,
      total: results.length,
    }))
    .sort((a, b) => a.subcategory.localeCompare(b.subcategory))
}

function formatExperiment(experiment: string) {
  return experiment
    .replace(/^openai-/, "OpenAI ")
    .replace(/^claude-/, "Claude ")
    .replaceAll("-", " ")
}

function formatExperimentParts(experiment: string) {
  const [provider = "", ...modelParts] = experiment.split("-")
  const providerName =
    provider === "openai"
      ? "OpenAI"
      : provider === "claude"
        ? "Claude"
        : provider.replaceAll("-", " ")

  return {
    provider: providerName,
    model: modelParts.length
      ? modelParts.join(" ").replaceAll("-", " ")
      : experiment.replaceAll("-", " "),
  }
}

function getExperimentProvider(experiment: string) {
  const [provider = ""] = experiment.split("-")
  return provider
}

function getProviderBarClasses(experiment: string) {
  const provider = getExperimentProvider(experiment)

  if (provider === "openai") {
    return {
      track: "bg-white/20",
      fill: "bg-white",
      hoverFill: "group-hover:bg-white/90",
      label: "text-background",
    }
  }

  if (provider === "claude" || provider === "anthropic") {
    return {
      track: "bg-[rgb(217,119,87)]/20",
      fill: "bg-[rgb(217,119,87)]",
      hoverFill: "group-hover:bg-[rgb(217,119,87)]/90",
      label: "text-foreground",
    }
  }

  return {
    track: "bg-sky-500/18",
    fill: "bg-sky-500",
    hoverFill: "group-hover:bg-sky-400",
    label: "text-foreground",
  }
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

function StageBar({ summary }: { summary: ExperimentStageSummary }) {
  const height = summary.total ? `${(summary.passed / summary.total) * 100}%` : "0%"
  const failed = summary.total - summary.passed
  const providerBarClasses = getProviderBarClasses(summary.experiment)
  const passRate = summary.total
    ? Math.round((summary.passed / summary.total) * 100)
    : 0

  return (
    <div className="min-w-7 flex-1">
      <Tooltip>
        <Sheet>
          <TooltipTrigger asChild>
            <SheetTrigger asChild>
              <button
                type="button"
                className="group relative z-10 flex h-full w-full items-stretch text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`${formatExperiment(summary.experiment)} passed ${summary.passed} of ${summary.total} ${summary.category} evals`}
              >
                <div
                  className={cn(
                    "relative flex h-full min-w-7 w-full items-end overflow-hidden",
                    providerBarClasses.track
                  )}
                >
                  {failed > 0 ? (
                    <div
                      className="absolute top-0 right-0 left-0 bg-muted/50"
                      style={{ height: `${(failed / summary.total) * 100}%` }}
                    />
                  ) : null}
                  <div
                    className={cn(
                      "w-full transition-all",
                      providerBarClasses.fill,
                      providerBarClasses.hoverFill
                    )}
                    style={{ height }}
                  />
                  <span
                    className={cn(
                      "pointer-events-none absolute inset-0 flex items-center justify-end pb-2 text-right font-mono text-[11px] leading-none font-medium [writing-mode:vertical-rl]",
                      providerBarClasses.label
                    )}
                  >
                    {formatExperiment(summary.experiment)}
                  </span>
                </div>
              </button>
            </SheetTrigger>
          </TooltipTrigger>
          <ExperimentSheet experiment={summary.experiment} />
        </Sheet>
        <TooltipContent side="top" align="center" className="text-center">
          <div className="font-medium text-foreground">
            {formatExperiment(summary.experiment)}
          </div>
          <div className="text-muted-foreground">{passRate}% passed</div>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function ExperimentSheet({ experiment }: { experiment: string }) {
  const experimentResults = getExperimentResults(experiment)
  const passed = experimentResults.filter((result) => result.passed).length
  const experimentName = formatExperimentParts(experiment)
  const [isScrolled, setIsScrolled] = useState(false)

  return (
    <SheetContent className="max-w-3xl">
      <SheetHeader className="flex-row items-end justify-between gap-6 border-b-0">
        <SheetTitle className="flex flex-col gap-1 pr-0 font-heading tracking-[-0.02em]">
          <span className="text-3xl leading-none font-light text-muted-foreground">
            {experimentName.provider}
          </span>
          <span className="text-3xl leading-none font-light text-foreground">
            {experimentName.model}
          </span>
        </SheetTitle>
        <SheetDescription className="shrink-0 pb-0.5 text-right">
          {passed} of {experimentResults.length} evals passed
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
          const stageGroups = getExperimentStageGroups(experiment, stage.id)

          if (!stageResults.length) {
            return null
          }

          return (
            <section
              key={stage.id}
              className="grid grid-cols-1 gap-3 border-t pt-5 sm:grid-cols-[9rem_1fr] sm:items-baseline"
            >
              <h2 className="font-heading text-xl leading-none font-light tracking-[-0.02em] text-foreground">
                {stage.label}
              </h2>
              <div className="flex min-w-0 flex-col gap-5">
                {stageGroups.map((group) => (
                  <div
                    key={group.subcategory}
                    className="flex min-w-0 flex-col gap-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="rounded-md px-2 py-1 font-sans text-xs font-normal capitalize tracking-wide text-muted-foreground">
                        {group.subcategory}
                      </h3>
                      <span className="text-xs text-muted-foreground">
                        {group.passed}/{group.total}
                      </span>
                    </div>
                    <Accordion type="single" collapsible className="min-w-0">
                      {group.results.map((result) => (
                          <AccordionItem key={result.eval} value={result.eval}>
                          <AccordionTrigger>
                            <div className="flex w-full min-w-0 flex-1 flex-col gap-2">
                              <div className="flex items-start justify-between gap-3">
                                <span className="min-w-0 leading-snug font-normal">
                                  {formatEvalName(result.eval, false)}
                                </span>
                                <span
                                  className={cn(
                                    "shrink-0 text-xs",
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
                          <AccordionContent className="flex flex-col gap-4">
                            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                              <div>
                                <dt className="font-mono tracking-wide text-muted-foreground uppercase">
                                  score
                                </dt>
                                <dd className="text-foreground">
                                  {result.score ?? "-"}
                                </dd>
                              </div>
                              <div>
                                <dt className="font-mono tracking-wide text-muted-foreground uppercase">
                                  attempts
                                </dt>
                                <dd className="text-foreground">
                                  {result.attempts ?? "-"}
                                </dd>
                              </div>
                              <div className="col-span-2">
                                <dt className="font-mono tracking-wide text-muted-foreground uppercase">
                                  source
                                </dt>
                                <dd className="truncate text-foreground">
                                  {result.sourcePath}
                                </dd>
                              </div>
                            </dl>
                            {result.notes ? (
                              <div className="flex flex-col gap-1.5">
                                <div className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
                                  Result details
                                </div>
                                <p className="text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
                                  {result.notes}
                                </p>
                              </div>
                            ) : null}
                            {result.prompt ? (
                              <div className="flex flex-col gap-1.5">
                                <div className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
                                  Prompt
                                </div>
                                <div className="rounded-md border bg-muted/35">
                                  <pre className="max-h-56 overflow-auto px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
                                    {result.prompt}
                                  </pre>
                                </div>
                              </div>
                            ) : null}
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

function TimelineStage({ stage }: { stage: (typeof JOURNEY_STAGES)[number] }) {
  const stageResults = getStageResults(stage.id)
  const evalLineCount = new Set(stageResults.map((result) => result.eval)).size
  const summaries = experiments
    .map((experiment) => getExperimentStageSummary(experiment, stage.id))
    .filter((summary) => summary.total > 0)

  return (
    <section className="group/stage flex min-w-fit flex-1 flex-col border-r last:border-r-0">
      <div className="relative overflow-hidden border-b px-4 py-3">
        <div className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(45deg,transparent_0,transparent_7px,var(--border)_7px,var(--border)_8px)] opacity-35" />
        <div className="relative flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">{stage.label}</h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label={`About the ${stage.label} stage`}
              >
                <InfoIcon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" align="center">
              {stage.description}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="relative flex min-w-fit flex-1 items-stretch gap-2 overflow-visible px-4">
        <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity group-hover/stage:opacity-100">
          {Array.from({ length: evalLineCount }).map((_, index) => (
            <div
              key={index}
              className="absolute inset-x-0 border-t border-border/50"
              style={{
                top: `${100 - ((index + 1) / evalLineCount) * 100}%`,
              }}
            />
          ))}
        </div>
        {summaries.length ? (
          summaries.map((summary) => (
            <StageBar
              key={`${summary.experiment}-${summary.category}`}
              summary={summary}
            />
          ))
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            No results
          </div>
        )}
      </div>
    </section>
  )
}

function TimelineByModel() {
  const summaries = experiments
    .map((experiment) => getExperimentOverallSummary(experiment))
    .filter((summary) => summary.total > 0)
  const totalEvalCount = new Set(sortedResults.map((result) => result.eval)).size

  return (
    <section className="group/stage flex min-w-full flex-1 flex-col">
      <div className="relative overflow-hidden border-b px-4 py-3">
        <div className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(45deg,transparent_0,transparent_7px,var(--border)_7px,var(--border)_8px)] opacity-35" />
        <div className="relative flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Model totals</h2>
          <span className="text-xs text-muted-foreground">
            Across all {totalEvalCount} evals
          </span>
        </div>
      </div>
      <div className="relative flex min-w-[900px] flex-1 items-stretch gap-2 overflow-visible px-4">
        <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity group-hover/stage:opacity-100">
          {Array.from({ length: totalEvalCount }).map((_, index) => (
            <div
              key={index}
              className="absolute inset-x-0 border-t border-border/50"
              style={{
                top: `${100 - ((index + 1) / totalEvalCount) * 100}%`,
              }}
            />
          ))}
        </div>
        {summaries.length ? (
          summaries.map((summary) => (
            <StageBar
              key={`${summary.experiment}-${summary.category}`}
              summary={summary}
            />
          ))
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            No results
          </div>
        )}
      </div>
    </section>
  )
}

function SupabaseLogo() {
  return (
    <svg
      className="h-6 w-auto"
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

function CopyCommandButton() {
  return (
    <button
      type="button"
      className="hidden w-fit items-center justify-between gap-4 rounded-md border bg-muted/25 px-3 py-2 text-left font-mono text-xs text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:flex"
      onClick={() => void navigator.clipboard.writeText(CLI_COMMAND)}
      aria-label={`Copy ${CLI_COMMAND}`}
    >
      <span className="truncate">{CLI_COMMAND}</span>
      <CopyIcon className="size-3.5 shrink-0" />
    </button>
  )
}

export function App() {
  const [timelineView, setTimelineView] = useState<"stage" | "model">("stage")

  return (
    <TooltipProvider delayDuration={150}>
      <main className="flex h-svh flex-col bg-background text-foreground">
        {results.length ? (
          <>
            <div className="flex w-full shrink-0 items-center justify-between border-b border-dotted px-6 py-3 sm:px-8 md:px-12 lg:px-16 xl:px-24">
              <a
                href="https://supabase.com"
                className="group/logo flex w-fit items-center gap-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <SupabaseLogo />
                <span className="-translate-x-2 text-sm text-muted-foreground opacity-0 transition-all duration-200 group-hover/logo:translate-x-0 group-hover/logo:opacity-100 group-focus-visible/logo:translate-x-0 group-focus-visible/logo:opacity-100">
                  Back to Supabase
                </span>
              </a>
              <CopyCommandButton />
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="grid w-full shrink-0 grid-cols-1 gap-6 px-6 py-12 sm:px-8 sm:pt-16 sm:pb-14 md:px-12 md:pt-20 md:pb-16 lg:grid-cols-[1fr_0.95fr] lg:px-16 lg:pt-28 lg:pb-20 xl:px-24 xl:pt-32">
                <h1 className="font-heading text-3xl leading-none font-light tracking-[-0.02em] sm:text-4xl lg:text-5xl">
                  <span className="block">Evaluating agents across</span>
                  <span className="block text-muted-foreground">
                    the Supabase journey.
                  </span>
                </h1>
                <div className="flex max-w-[544px] flex-col gap-4 self-end lg:justify-self-end">
                  <p className="text-sm leading-5 tracking-[-0.011em] text-muted-foreground">
                    We evaluate model experiments against each stage of the
                    Supabase developer journey, from designing application
                    primitives through observing behavior, detecting issues, and
                    resolving production problems with the right project
                    context.
                  </p>
                  <ToggleGroup
                    type="single"
                    value={timelineView}
                    onValueChange={(value) => {
                      if (value === "stage" || value === "model") {
                        setTimelineView(value)
                      }
                    }}
                    className="w-fit"
                  >
                    <ToggleGroupItem value="stage">Group by stage</ToggleGroupItem>
                    <ToggleGroupItem value="model">Group by model</ToggleGroupItem>
                  </ToggleGroup>
                </div>
              </div>
              <div className="flex min-h-0 flex-1 overflow-x-auto border-y bg-muted/25">
                {timelineView === "stage" ? (
                  JOURNEY_STAGES.map((stage) => (
                    <TimelineStage key={stage.id} stage={stage} />
                  ))
                ) : (
                  <TimelineByModel />
                )}
              </div>
            </div>
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
