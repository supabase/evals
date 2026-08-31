import type { ReactNode } from "react"
import {
  CheckIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  FileTextIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"

import { passFailClassName } from "@/components/results/table-shared"
import type { CheckResult, DocsCall, ParsedResult } from "@/lib/eval-results"
import { formatProductLabel, formatTagLabel } from "@/lib/format"
import { cn } from "@/lib/utils"

const DOCS_CALL_SOURCE_LABEL: Record<DocsCall["source"], string> = {
  search_docs: "MCP",
  web_fetch: "Web Fetch",
  web_search: "Web Search",
  shell_fetch: "Shell",
}

// Cool color for MCP (our own docs tool), warm for the agent going around it onto the open web.
const DOCS_CALL_SOURCE_CHIP_CLASS: Record<DocsCall["source"], string> = {
  search_docs: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-400",
  web_fetch: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  web_search: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  shell_fetch: "bg-orange-500/10 text-orange-700 dark:text-orange-400",
}

const docsSourceChipClassName =
  "rounded-md px-2 py-1 font-mono text-xs font-normal uppercase tracking-wide text-muted-foreground"

const evalMetaGridClassName =
  "grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-4 gap-y-4 text-xs"

/** Shows whether page content was read, not read, or cannot be determined. */
function docsCallIcon(call: DocsCall) {
  if (call.hasContent === undefined) return CircleHelpIcon
  return call.hasContent ? FileTextIcon : SearchIcon
}

/** Pulls the quoted search term out of search_docs's raw GraphQL query for display, else returns the query as-is. */
function docsCallQueryLabel(call: DocsCall): string {
  if (call.source === "search_docs") {
    const match = call.query.match(/query:\s*"((?:[^"\\]|\\.)*)"/)
    if (match) return match[1]
  }
  return call.query
}

/** Rough token estimate (chars/4, the standard quick heuristic) for how much text a call pulled into context. */
function docsCallSizeLabel(call: DocsCall): string | undefined {
  if (call.resultChars === undefined) return undefined
  const tokens = Math.round(call.resultChars / 4)
  return tokens < 1000
    ? `~${tokens} tokens`
    : `~${(tokens / 1000).toFixed(1)}k tokens`
}

function EvalMetadataRow({
  label,
  value,
}: {
  label: string
  value: ReactNode
}) {
  return (
    <>
      <dt className="text-muted-foreground capitalize">{label}</dt>
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
        const checkRow = (
          <span className="inline-flex w-full items-start gap-2 pl-6">
            {notes ? (
              <ChevronRightIcon
                className="mt-0.5 -ml-6 size-4 shrink-0 text-muted-foreground/50 transition-transform group-open:rotate-90"
                aria-hidden
              />
            ) : null}
            <StatusIcon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                passFailClassName(check.passed)
              )}
              aria-hidden
            />
            <span className="sr-only">{check.passed ? "Pass" : "Fail"}: </span>
            <span className="min-w-0 whitespace-pre-wrap">{check.name}</span>
          </span>
        )

        if (!notes) {
          return <div key={`${index}-${check.name}`}>{checkRow}</div>
        }

        return (
          <details key={`${index}-${check.name}`} className="group">
            <summary className="cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
              {checkRow}
            </summary>
            <p className="mt-1 ml-12 whitespace-pre-wrap text-muted-foreground">
              {notes}
            </p>
          </details>
        )
      })}
    </div>
  )
}

/** One collapsible row per docs call (see DocsCall), expanding to the pages that call returned. */
function ResultDocsCalls({ calls }: { calls: DocsCall[] }) {
  return (
    <div className="flex flex-col gap-1.5 leading-relaxed text-foreground">
      {calls.map((call, index) => {
        const searchOnly = call.hasContent === false
        const contentUnknown = call.hasContent === undefined
        const Icon = docsCallIcon(call)
        const queryLabel = docsCallQueryLabel(call)
        const sizeLabel = docsCallSizeLabel(call)

        return (
          <details key={index} className="group">
            <summary className="cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
              <span className="inline-flex w-full items-center gap-2">
                <ChevronRightIcon
                  className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-open:rotate-90"
                  aria-hidden
                />
                <span
                  title={contentUnknown ? "Content unknown" : undefined}
                  className="shrink-0"
                >
                  <Icon
                    className={cn(
                      "size-4",
                      searchOnly || contentUnknown
                        ? "text-muted-foreground/60"
                        : "text-muted-foreground"
                    )}
                    aria-hidden
                  />
                </span>
                <span
                  title={queryLabel}
                  className="min-w-0 truncate text-foreground"
                >
                  {queryLabel}
                </span>
                {contentUnknown ? (
                  <span className="sr-only">Content unknown</span>
                ) : null}
                {sizeLabel ? (
                  <span className="shrink-0 font-mono text-xs tracking-wide text-muted-foreground">
                    {sizeLabel}
                  </span>
                ) : null}
                <span
                  className={cn(
                    docsSourceChipClassName,
                    "shrink-0",
                    DOCS_CALL_SOURCE_CHIP_CLASS[call.source]
                  )}
                >
                  {DOCS_CALL_SOURCE_LABEL[call.source]}
                </span>
              </span>
            </summary>
            <div className="mt-1 ml-12 flex flex-col gap-1">
              {call.pages.length > 0 ? (
                call.pages.map((page) => (
                  <a
                    key={page.url}
                    href={page.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {page.title ?? page.url}
                  </a>
                ))
              ) : (
                <span className="text-muted-foreground">
                  No results recovered (the tool's output may have been
                  truncated).
                </span>
              )}
            </div>
          </details>
        )
      })}
    </div>
  )
}

/** Everything recorded about one run, shown when its row in the sheet is expanded. */
export function EvalDetails({ result }: { result: ParsedResult }) {
  return (
    <dl className={evalMetaGridClassName}>
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
      <EvalMetadataRow
        label="Source"
        value={<span className="break-all">{result.sourcePath}</span>}
      />
      <EvalMetadataRow
        label="Product"
        value={
          result.product.length
            ? result.product.map(formatProductLabel).join(", ")
            : "-"
        }
      />
      <EvalMetadataRow
        label="Topic"
        value={result.topic.map(formatTagLabel).join(", ") || "-"}
      />
      {result.checks?.length ? (
        <EvalMetadataRow
          label="Result details"
          value={<ResultChecks checks={result.checks} />}
        />
      ) : null}
      {result.docs?.calls.length ? (
        <EvalMetadataRow
          label="Docs activity"
          value={<ResultDocsCalls calls={result.docs.calls} />}
        />
      ) : null}
    </dl>
  )
}
