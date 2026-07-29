import { Fragment, useState } from "react"

import { EvalDetails } from "@/components/results/eval-details"
import {
  activateOnKeyDown,
  clickableTableItemClassName,
  passFailClassName,
  passRateClassName,
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
  type GroupBy,
  type TableSelection,
} from "@/lib/dimensions"
import { scoreResults, type ParsedResult } from "@/lib/eval-results"
import { cn } from "@/lib/utils"

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
  const { passed, total } = scoreResults(runs)
  const passRate = total ? Math.round((passed / total) * 100) : null
  const [expandedRun, setExpandedRun] = useState<string | null>(
    selection.expandedRun ?? null
  )

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
                <th className={cn(tableHeadCellClassName, "w-20 px-3 py-2")}>
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {orderedRuns.map((run) => {
                const key = run.sourcePath
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
                            passFailClassName(run.passed)
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
                          <EvalDetails result={run} />
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
