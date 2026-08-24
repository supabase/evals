import { Fragment } from "react"
import { useQueryState } from "nuqs"
import { ChevronRightIcon } from "lucide-react"

import { EvalDetails } from "@/components/results/eval-details"
import { ExperimentLabel } from "@/components/results/experiment-label"
import {
  activateOnKeyDown,
  clickableTableItemClassName,
  passFailClassName,
  passRateClassName,
  sampleSetLabel,
  tableHeadCellClassName,
} from "@/components/results/table-shared"
import {
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  DIMENSIONS,
  DIMENSION_ORDER,
  dimensionCell,
  dimensionShortTitle,
  orderRuns,
  runGroupKey,
  type Dimension,
  type GroupBy,
  type TableSelection,
} from "@/lib/dimensions"
import { scoreResults, type ParsedResult } from "@/lib/eval-results"
import { selectionQueryKeys, selectionQueryParsers } from "@/lib/url-state"
import { cn } from "@/lib/utils"

/** The affordance that a row opens: a chevron that turns as it expands. */
function RowChevron({ expanded }: { expanded: boolean }) {
  return (
    <ChevronRightIcon
      className={cn(
        "size-4 shrink-0 text-muted-foreground/50 transition-transform",
        expanded && "rotate-90"
      )}
      aria-hidden
    />
  )
}

/** How many of a run's checks passed, as a preview of what expanding it shows. */
function checksLabel(run: ParsedResult) {
  if (!run.checks?.length) return null
  const passed = run.checks.filter((check) => check.passed).length
  return `${passed}/${run.checks.length} checks`
}

/**
 * What the sheet expands to when a run inside a sample set is clicked. Closing
 * a run falls back to its group, so collapsing one run does not also collapse
 * the group it was listed under.
 */
export function nextGroupRunExpansion(
  current: string | null,
  groupKey: string,
  sourcePath: string
) {
  return current === sourcePath ? groupKey : sourcePath
}

/** One run's cell on a sheet column; the first column is the row header. */
function RunCell({
  facet,
  run,
  index,
  expanded,
}: {
  facet: Dimension
  run: ParsedResult
  index: number
  expanded?: boolean
}) {
  const content =
    facet.id === "model" ? (
      <ExperimentLabel experiment={run.experiment} />
    ) : (
      dimensionCell(facet, run)
    )

  if (index === 0) {
    return (
      <th
        scope="row"
        className="border-r border-b border-border py-2.5 pr-3 pl-6 text-left font-normal text-foreground"
      >
        <span className="flex items-center gap-2">
          <RowChevron expanded={expanded ?? false} />
          {content}
        </span>
      </th>
    )
  }

  return (
    <td className="border-r border-b border-border px-3 py-2.5 text-muted-foreground">
      {content}
    </td>
  )
}

/** The expanded detail panel for one run, spanning the sheet's columns. */
function DetailsRow({ columns, run }: { columns: number; run: ParsedResult }) {
  return (
    <tr>
      <td
        colSpan={columns + 1}
        className="border-b border-border bg-secondary/35 px-6 py-5"
      >
        <EvalDetails result={run} />
      </td>
    </tr>
  )
}

/**
 * The runs of one pair (agent x eval), in run order, keyed by that pair. Groups
 * keep the order of the first run so the sheet's column sort still drives the
 * list.
 */
export function groupRuns(orderedRuns: ParsedResult[]) {
  const groups = new Map<string, ParsedResult[]>()

  for (const run of orderedRuns) {
    const key = runGroupKey(run)
    const group = groups.get(key)
    if (group) {
      group.push(run)
    } else {
      groups.set(key, [run])
    }
  }

  return Array.from(groups, ([key, runs]) => ({
    key,
    runs: [...runs].sort((a, b) => (a.run ?? 0) - (b.run ?? 0)),
  }))
}

/**
 * Detail view for a clicked row or column, listing the runs behind it. Every
 * axis the selection leaves open becomes a column, so a model selection lists
 * its evals and an eval selection lists the models that ran it. It is the same
 * component either way; the shape depends only on which axis was clicked.
 */
export function SelectionSheet({
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
  const groups = groupRuns(orderedRuns)
  const { passed, total } = scoreResults(runs)
  const passRate = total ? Math.round((passed / total) * 100) : null
  const [expandedRun, setExpandedRun] = useQueryState(
    selectionQueryKeys.run,
    selectionQueryParsers.run
  )

  const toggleRun = (key: string) => {
    void setExpandedRun((current) => (current === key ? null : key))
  }

  const toggleGroupRun = (groupKey: string, sourcePath: string) => {
    void setExpandedRun((current) =>
      nextGroupRunExpansion(current, groupKey, sourcePath)
    )
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
                <span className={passRateClassName(passRate)}>{passRate}%</span>
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
                <th className={cn(tableHeadCellClassName, "w-28 px-3 py-2")}>
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map(({ key: groupKey, runs: groupRunsList }) => {
                const single = groupRunsList.length === 1

                if (single) {
                  const run = groupRunsList[0]

                  return (
                    <Fragment key={groupKey}>
                      <tr
                        tabIndex={0}
                        aria-expanded={expandedRun === run.sourcePath}
                        className={clickableTableItemClassName}
                        onClick={() => toggleRun(run.sourcePath)}
                        onKeyDown={(event) =>
                          activateOnKeyDown(event, () =>
                            toggleRun(run.sourcePath)
                          )
                        }
                      >
                        {columns.map((facet, index) => (
                          <RunCell
                            key={facet.id}
                            facet={facet}
                            run={run}
                            index={index}
                            expanded={expandedRun === run.sourcePath}
                          />
                        ))}
                        <td className="border-b border-border px-3 py-2.5">
                          <span
                            className={cn(
                              "font-mono text-xs",
                              passFailClassName(run.passed)
                            )}
                          >
                            {run.passed ? "Pass" : "Fail"}
                          </span>
                        </td>
                      </tr>
                      {expandedRun === run.sourcePath ? (
                        <DetailsRow columns={columns.length} run={run} />
                      ) : null}
                    </Fragment>
                  )
                }

                const passedRuns = groupRunsList.filter(
                  (run) => run.passed
                ).length
                const groupExpanded =
                  expandedRun === groupKey ||
                  groupRunsList.some((run) => run.sourcePath === expandedRun)

                return (
                  <Fragment key={groupKey}>
                    <tr
                      tabIndex={0}
                      aria-expanded={groupExpanded}
                      className={clickableTableItemClassName}
                      onClick={() => toggleRun(groupKey)}
                      onKeyDown={(event) =>
                        activateOnKeyDown(event, () => toggleRun(groupKey))
                      }
                    >
                      {columns.map((facet, index) => (
                        <RunCell
                          key={facet.id}
                          facet={facet}
                          run={groupRunsList[0]}
                          index={index}
                          expanded={groupExpanded}
                        />
                      ))}
                      <td className="border-b border-border px-3 py-2.5">
                        <span
                          title={`${passedRuns} of ${groupRunsList.length} runs passed`}
                          className={cn(
                            "font-mono text-xs whitespace-nowrap",
                            passRateClassName(
                              Math.round(
                                (passedRuns / groupRunsList.length) * 100
                              )
                            )
                          )}
                        >
                          {sampleSetLabel(passedRuns, groupRunsList.length)}
                        </span>
                      </td>
                    </tr>
                    {groupExpanded
                      ? groupRunsList.map((run, runIndex) => (
                          <Fragment key={run.sourcePath}>
                            <tr
                              tabIndex={0}
                              aria-expanded={expandedRun === run.sourcePath}
                              className={clickableTableItemClassName}
                              onClick={() =>
                                toggleGroupRun(groupKey, run.sourcePath)
                              }
                              onKeyDown={(event) =>
                                activateOnKeyDown(event, () =>
                                  toggleGroupRun(groupKey, run.sourcePath)
                                )
                              }
                            >
                              <th
                                scope="row"
                                className="border-r border-b border-border py-2 pr-3 pl-12 text-left font-normal text-muted-foreground"
                              >
                                <span className="flex items-center gap-2">
                                  <RowChevron
                                    expanded={expandedRun === run.sourcePath}
                                  />
                                  Run {run.run ?? runIndex + 1}
                                  {checksLabel(run) ? (
                                    <span className="font-mono text-xs text-muted-foreground/70">
                                      {checksLabel(run)}
                                    </span>
                                  ) : null}
                                </span>
                              </th>
                              {columns.slice(1).map((facet) => (
                                <td
                                  key={facet.id}
                                  className="border-r border-b border-border px-3 py-2"
                                />
                              ))}
                              <td className="border-b border-border px-3 py-2">
                                <span
                                  className={cn(
                                    "font-mono text-xs",
                                    passFailClassName(run.passed)
                                  )}
                                >
                                  {run.passed ? "Pass" : "Fail"}
                                </span>
                              </td>
                            </tr>
                            {expandedRun === run.sourcePath ? (
                              <DetailsRow columns={columns.length} run={run} />
                            ) : null}
                          </Fragment>
                        ))
                      : null}
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
