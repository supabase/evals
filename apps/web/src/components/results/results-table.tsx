import { useState, type ReactNode } from "react"
import { useQueryStates } from "nuqs"

import { SelectionSheet } from "@/components/results/selection-sheet"
import {
  activateOnKeyDown,
  clickableTableItemClassName,
  columnHighlightClassName,
  passRateClassName,
  tableHeadCellClassName,
} from "@/components/results/table-shared"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Sheet } from "@/components/ui/sheet"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  DIMENSIONS,
  GROUP_BY_OPTIONS,
  dimensionShortTitle,
  tableSelection,
  type Dimension,
  type GroupBy,
  type TableSelection,
} from "@/lib/dimensions"
import {
  EXPERIMENT_SUITES,
  EXPERIMENT_SUITE_LABELS,
  scoreResults,
  type ExperimentSuite,
  type ParsedResult,
} from "@/lib/eval-results"
import { selectionQueryKeys, selectionQueryParsers } from "@/lib/url-state"
import { cn } from "@/lib/utils"

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
        passRateClassName(passRate)
      )}
    >
      {passRate}%
    </span>
  )
}

/**
 * The results grid. Rows come from the selected group-by axis and columns from
 * the axis it is compared against; clicking either opens the detail sheet.
 */
export function ResultsTable({
  sourceResults,
  groupBy,
  experimentSuite,
  onGroupByChange,
  onExperimentSuiteChange,
}: {
  sourceResults: ParsedResult[]
  groupBy: GroupBy
  experimentSuite: ExperimentSuite
  onGroupByChange: (value: GroupBy) => void
  onExperimentSuiteChange: (value: ExperimentSuite) => void
}) {
  const rowDimension = DIMENSIONS[groupBy]
  // Models are the comparison axis for every grouping except themselves, where
  // the journey stages take over.
  const columnDimension =
    groupBy === "model" ? DIMENSIONS.stage : DIMENSIONS.model
  const modelsAsRows = groupBy === "model"
  const rowKeys = rowDimension.keys(sourceResults)
  const columnKeys = columnDimension.keys(sourceResults)
  const [selectionQuery, setSelectionQuery] = useQueryStates(
    selectionQueryParsers,
    { urlKeys: selectionQueryKeys }
  )
  const [hoveredColumn, setHoveredColumn] = useState<string | null>(null)
  const selection: TableSelection | null =
    selectionQuery.dimension && selectionQuery.key
      ? {
          dimension: selectionQuery.dimension,
          key: selectionQuery.key,
        }
      : null

  const select = (
    dimension: Dimension,
    key: string,
    cellRuns?: ParsedResult[]
  ) => {
    const nextSelection = tableSelection(dimension, key, cellRuns)

    void setSelectionQuery({
      dimension: nextSelection.dimension,
      key: nextSelection.key,
      run: nextSelection.expandedRun ?? null,
    })
  }

  return (
    <Sheet
      open={selection !== null}
      onOpenChange={(open) => {
        if (!open) void setSelectionQuery(null)
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
              value={experimentSuite}
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
                        const cellRuns = columnDimension.filter(
                          columnKey,
                          rowResults
                        )
                        const summary = scoreResults(cellRuns)

                        return (
                          <td
                            key={columnKey}
                            className={cn(
                              "border-r border-b border-border p-0 transition-colors",
                              hoveredColumn === columnKey &&
                                columnHighlightClassName
                            )}
                          >
                            <button
                              type="button"
                              aria-label={`Open ${columnDimension.title(columnKey)} results for ${rowDimension.title(rowKey)}`}
                              className="block w-full cursor-pointer px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                              onClick={(event) => {
                                event.stopPropagation()
                                select(rowDimension, rowKey, cellRuns)
                              }}
                              onKeyDown={(event) => event.stopPropagation()}
                            >
                              <ScoreCell
                                passed={summary.passed}
                                total={summary.total}
                              />
                            </button>
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
