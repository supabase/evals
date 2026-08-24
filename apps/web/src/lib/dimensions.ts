import {
  JOURNEY_STAGES,
  UNASSIGNED_PRODUCT,
  getEvalIds,
  getEvalResults,
  getExperimentDisplay,
  getExperimentResults,
  getProductKeys,
  getProductResults,
  getStageResults,
  getVisibleExperiments,
  sortResults,
  sortedResults,
  type JourneyStage,
  type ParsedResult,
} from "@/lib/eval-results"
import {
  AGENT_LABELS,
  formatEvalName,
  formatExperimentLabel,
  formatModelColumnLabel,
  formatProductLabel,
} from "@/lib/format"

export type GroupBy = "model" | "stage" | "product" | "eval"

/**
 * The sample set a run belongs to: every scored run of one agent against one
 * eval. Runs of the same pair collapse into a single sidebar row.
 */
export function runGroupKey(result: ParsedResult) {
  return `${result.experiment}::${result.eval}`
}

/**
 * What the user clicked: a key on one of the axes, whichever axis it came
 * from, and optionally the run or sample set identified by a score cell.
 */
export type TableSelection = {
  dimension: GroupBy
  key: string
  expandedRun?: string
}

const experimentLabel = new Map(
  getVisibleExperiments(sortedResults).map((experiment) => [
    experiment,
    formatExperimentLabel(getExperimentDisplay(experiment), experiment),
  ])
)

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
export type Dimension = {
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

export const DIMENSIONS: Record<GroupBy, Dimension> = {
  model: {
    id: "model",
    label: "Agent",
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
export const DIMENSION_ORDER = [
  DIMENSIONS.eval,
  DIMENSIONS.model,
  DIMENSIONS.stage,
  DIMENSIONS.product,
]

/** Order the group-by control offers the axes in. */
export const GROUP_BY_OPTIONS = [
  "model",
  "eval",
  "stage",
  "product",
] as const satisfies ReadonlyArray<GroupBy>

export function dimensionCell(dimension: Dimension, result: ParsedResult) {
  return dimension.cell?.(result) ?? dimension.title(dimension.keyOf(result))
}

export function dimensionShortTitle(dimension: Dimension, key: string) {
  return dimension.shortTitle?.(key) ?? dimension.title(key)
}

/**
 * Builds a sheet selection from any table axis. A score cell points at a single
 * run when its row/column intersection is one run, or at that pair's sample set
 * when the cell is the several runs of one agent against one eval; other
 * aggregate cells still open the row's complete sheet.
 */
export function tableSelection(
  dimension: Dimension,
  key: string,
  cellRuns: ParsedResult[] = []
): TableSelection {
  const groups = new Set(cellRuns.map(runGroupKey))

  return {
    dimension: dimension.id,
    key,
    ...(cellRuns.length === 1
      ? { expandedRun: cellRuns[0].sourcePath }
      : groups.size === 1
        ? { expandedRun: runGroupKey(cellRuns[0]) }
        : {}),
  }
}

/**
 * Runs sorted by the sheet's columns, left to right, then by the canonical
 * order. Each column ranks against the whole table rather than the selection,
 * so models read in the same order here as they do in the table's columns.
 */
export function orderRuns(
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
