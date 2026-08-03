import { lazy, Suspense } from "react"
import { useQueryState, useQueryStates } from "nuqs"

import { EvalOverviewCards } from "@/components/eval-overview-cards"
import { PageContainer } from "@/components/page-container"
import { ResultsTable } from "@/components/results/results-table"
import { SiteFooter } from "@/components/site-footer"
import { SiteHeader } from "@/components/site-header"
import { SiteHero } from "@/components/site-hero"
import { TooltipProvider } from "@/components/ui/tooltip"
import { sortedResults } from "@/lib/eval-results"
import {
  resultsQueryKeys,
  resultsQueryParsers,
  traceEvalParser,
  TRACE_EVAL_QUERY_KEY,
} from "@/lib/url-state"

// Lazy so the AgentPrism component tree stays out of the main bundle; the
// trace panel is only mounted when a run is opened.
const TracePanel = lazy(() =>
  import("@/components/trace-panel").then((m) => ({ default: m.TracePanel }))
)

export function App() {
  const [{ groupBy, experimentSuite }, setResultsQuery] = useQueryStates(
    resultsQueryParsers,
    {
      urlKeys: resultsQueryKeys,
      clearOnDefault: false,
    }
  )
  const [traceEval, setTraceEval] = useQueryState(
    TRACE_EVAL_QUERY_KEY,
    traceEvalParser
  )
  const suiteResults = sortedResults.filter(
    (result) => result.experimentSuite === experimentSuite
  )

  return (
    <TooltipProvider delayDuration={200}>
      <main className="min-h-svh bg-background text-foreground">
        {sortedResults.length ? (
          <>
            <SiteHeader />
            <SiteHero />
            {/* Overlap the table with the hero while preserving its content spacing. */}
            <PageContainer className="relative z-20 -mt-6 pb-8 md:-mt-8 md:pb-10">
              <ResultsTable
                sourceResults={suiteResults}
                groupBy={groupBy}
                experimentSuite={experimentSuite}
                onGroupByChange={(nextGroupBy) => {
                  void setResultsQuery({ groupBy: nextGroupBy })
                }}
                onExperimentSuiteChange={(nextExperimentSuite) => {
                  void setResultsQuery({
                    experimentSuite: nextExperimentSuite,
                  })
                }}
              />
            </PageContainer>
            <PageContainer className="pb-24 md:pb-28">
              <EvalOverviewCards />
            </PageContainer>
            <SiteFooter />
          </>
        ) : (
          <div className="grid flex-1 place-items-center px-6 text-center text-sm text-muted-foreground">
            No result files found in the repo results directory.
          </div>
        )}
        {traceEval ? (
          <Suspense fallback={null}>
            <TracePanel
              evalId={traceEval}
              onClose={() => void setTraceEval(null)}
            />
          </Suspense>
        ) : null}
      </main>
    </TooltipProvider>
  )
}

export default App
