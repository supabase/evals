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

/** Rows are clickable `<tr>`s rather than buttons, so they need their own key handling. */
export function activateOnKeyDown(event: KeyboardEvent, open: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault()
    open()
  }
}
