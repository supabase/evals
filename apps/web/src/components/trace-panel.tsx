import { useEffect, useState, type ReactElement } from "react"
import { XIcon } from "lucide-react"

import { Badge, type BadgeProps } from "@/components/agent-prism/Badge"
import { TraceViewer } from "@/components/agent-prism/TraceViewer/TraceViewer"
import type { TraceBadge, TraceViewerData } from "@supabase-evals/core"
import type { TraceSpan } from "@evilmartians/agent-prism-types"
import { cn } from "@/lib/utils"

// JSON has no Date type — startTime/endTime round-trip through the exported
// trace file as ISO strings. AgentPrism's duration math does `+span.startTime`,
// which only works on real Date instances (a string coerces to NaN), so every
// span shows "NaNh" latency until these are revived post-fetch.
function reviveSpanDates(span: TraceSpan): TraceSpan {
  return {
    ...span,
    startTime: new Date(span.startTime),
    endTime: new Date(span.endTime),
    children: span.children?.map(reviveSpanDates),
  }
}

// Eager ?url returns a map of "../data/traces/<evalId>.json" -> asset URL string
// (the JSON payload is NOT inlined — only its URL), so the aggregate bundle
// stays lean and a trace is fetched only when its row is opened.
const traceUrls = import.meta.glob("../data/traces/*.json", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>

const TONE_CLASS: Record<TraceBadge["tone"], string> = {
  success:
    "bg-agentprism-success-muted text-agentprism-success-muted-foreground",
  error: "bg-agentprism-error-muted text-agentprism-error-muted-foreground",
  warning:
    "bg-agentprism-warning-muted text-agentprism-warning-muted-foreground",
  neutral:
    "bg-agentprism-badge-default text-agentprism-badge-default-foreground",
}

function traceUrlFor(evalId: string): string | undefined {
  return traceUrls[`../data/traces/${evalId}.json`]
}

export function TracePanel({
  evalId,
  onClose,
}: {
  evalId: string
  onClose: () => void
}): ReactElement {
  const [data, setData] = useState<TraceViewerData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    const url = traceUrlFor(evalId)
    if (!url) {
      setError("No trace recorded for this eval.")
      return
    }
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<TraceViewerData>
      })
      .then((payload) => {
        if (!cancelled) {
          setData({ ...payload, spans: payload.spans.map(reviveSpanDates) })
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [evalId])

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const badges: BadgeProps[] = (data?.badges ?? []).map((b) => ({
    label: b.label,
    size: "5",
    className: cn(TONE_CLASS[b.tone]),
  }))

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-background"
      role="dialog"
      aria-label={`Trace for ${evalId}`}
    >
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="min-w-0 shrink truncate font-mono text-sm text-foreground">
            {evalId}
          </span>
          {badges.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1.5">
              {badges.map((b) => (
                <Badge key={String(b.label)} {...b} />
              ))}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close trace"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1">
        {error ? (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
            {error}
          </div>
        ) : data ? (
          <TraceViewer data={[data]} />
        ) : (
          <div className="grid h-full place-items-center px-6 text-sm text-muted-foreground">
            Loading trace…
          </div>
        )}
      </div>
    </div>
  )
}
