import { useState } from "react"

import { EvalOverviewCards } from "@/components/eval-overview-cards"
import { PageContainer } from "@/components/page-container"
import { ResultsTable } from "@/components/results/results-table"
import { SiteFooter } from "@/components/site-footer"
import { SiteHeader } from "@/components/site-header"
import { SiteHero } from "@/components/site-hero"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { GroupBy } from "@/lib/dimensions"
import { sortedResults, type ExperimentSuite } from "@/lib/eval-results"

export function App() {
  const [groupBy, setGroupBy] = useState<GroupBy>("model")
  const [experimentSuite, setExperimentSuite] =
    useState<ExperimentSuite>("benchmark")
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
                onGroupByChange={setGroupBy}
                onExperimentSuiteChange={setExperimentSuite}
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
      </main>
    </TooltipProvider>
  )
}

export default App
