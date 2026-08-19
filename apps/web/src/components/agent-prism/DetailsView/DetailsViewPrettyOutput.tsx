import type { ReactElement, ReactNode } from "react"

/**
 * Human-readable render of parsed JSON content — the counterpart to
 * DetailsViewJsonOutput's exact-JSON view. Strings render with their real
 * line breaks (tool call `command`/`stdout` fields are often multi-line
 * shell scripts that are unreadable as an escaped `\n`-riddled JSON string),
 * at the cost of no longer being valid JSON syntax itself.
 */
function renderValue(value: unknown): ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-agentprism-muted-foreground">—</span>
  }

  if (typeof value === "string") {
    return (
      <pre className="overflow-x-auto font-mono text-sm whitespace-pre-wrap text-agentprism-code-string">
        {value}
      </pre>
    )
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return (
      <span className="font-mono text-sm text-agentprism-code-number">
        {String(value)}
      </span>
    )
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-agentprism-muted-foreground">[]</span>
    }

    return (
      <div className="flex flex-col gap-2">
        {value.map((item, index) => (
          <div key={index} className="border-l-2 border-agentprism-border pl-3">
            {renderValue(item)}
          </div>
        ))}
      </div>
    )
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)

    if (entries.length === 0) {
      return <span className="text-agentprism-muted-foreground">{"{}"}</span>
    }

    return (
      <div className="flex flex-col gap-3">
        {entries.map(([key, val]) => (
          <div key={key}>
            <div className="font-mono text-xs font-semibold text-agentprism-code-key">
              {key}
            </div>
            <div className="mt-1">{renderValue(val)}</div>
          </div>
        ))}
      </div>
    )
  }

  return <span className="font-mono text-sm">{String(value)}</span>
}

export const DetailsViewPrettyOutput = ({
  content,
}: {
  content: unknown
}): ReactElement => <div className="text-left">{renderValue(content)}</div>
