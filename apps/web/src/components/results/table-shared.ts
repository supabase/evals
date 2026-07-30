import type { KeyboardEvent } from "react"

/** Small pieces the results table and the detail sheet both render with. */

export const clickableTableItemClassName =
  "cursor-pointer bg-card transition-colors outline-none hover:bg-muted/35 focus-visible:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"

export const columnHighlightClassName = "bg-muted/35"

/** Shared by both tables; each supplies its own padding. */
export const tableHeadCellClassName =
  "border-b border-border text-left font-mono text-xs font-normal tracking-wide text-muted-foreground uppercase"

const PASS_CLASS = "text-emerald-600 dark:text-emerald-400"
const FAIL_CLASS = "text-red-600 dark:text-red-400"

/** Red below 50%, amber below 80%, green above. */
export function passRateClassName(passRate: number) {
  if (passRate < 50) {
    return FAIL_CLASS
  }

  if (passRate < 80) {
    return "text-amber-600 dark:text-amber-400"
  }

  return PASS_CLASS
}

/** The same two colors for a single run, which is either passing or not. */
export function passFailClassName(passed: boolean) {
  return passed ? PASS_CLASS : FAIL_CLASS
}

/** Formats aggregate scores as rates and single eval runs as pass or fail. */
export function scoreLabel(
  passed: number,
  total: number,
  showPassFail = false
) {
  if (!total) return null
  if (showPassFail && total === 1) return passed ? "Pass" : "Fail"
  return `${Math.round((passed / total) * 100)}%`
}

/** Formats a run duration: "38s" under a minute, "4m 05s" above. */
export function formatDuration(ms: number) {
  const totalSec = Math.round(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (!min) return `${sec}s`
  return `${min}m ${String(sec).padStart(2, "0")}s`
}

/** Formats a token count compactly: "845", "12k", "1.2M". */
export function formatTokens(count: number) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return `${Math.round(count)}`
}

/** Formats a USD cost, keeping cents-level runs from rounding to $0.00. */
export function formatCost(usd: number) {
  return usd < 0.1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`
}

/** Checks whether a horizontal scroller has content beyond its right edge. */
export function hasMoreContentToRight({
  scrollLeft,
  clientWidth,
  scrollWidth,
}: Pick<HTMLElement, "scrollLeft" | "clientWidth" | "scrollWidth">) {
  return scrollLeft + clientWidth < scrollWidth - 1
}

/** Rows are clickable `<tr>`s rather than buttons, so they need their own key handling. */
export function activateOnKeyDown(event: KeyboardEvent, open: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault()
    open()
  }
}
