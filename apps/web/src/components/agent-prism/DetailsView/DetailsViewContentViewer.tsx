import type { ReactElement } from "react"

import { CopyButton } from "../CopyButton"
import { DetailsViewJsonOutput } from "./DetailsViewJsonOutput"
import { DetailsViewMarkdown } from "./DetailsViewMarkdown"
import { DetailsViewPrettyOutput } from "./DetailsViewPrettyOutput"

export type DetailsViewContentViewMode = "json" | "plain"

export interface DetailsViewContentViewerProps {
  content: string
  parsedContent: unknown
  mode: DetailsViewContentViewMode
  label: string
  id: string
  className?: string
  /**
   * Render plain-mode content as markdown instead of a raw `<pre>` dump.
   * Only pass this for genuinely LLM-authored prose (assistant/user/system
   * text) — tool call args/results are structured data, not markdown, and
   * would render with spurious formatting (stray `_`/`*` in identifiers,
   * error messages, etc.) if forced through a markdown parser.
   */
  renderMarkdown?: boolean
}

export const DetailsViewContentViewer = ({
  content,
  parsedContent,
  mode,
  label,
  id,
  className = "",
  renderMarkdown = false,
}: DetailsViewContentViewerProps): ReactElement => {
  if (!content) {
    return (
      <p className="p-3 text-sm text-agentprism-muted-foreground italic">
        No data available
      </p>
    )
  }

  return (
    <div
      className={`relative rounded-lg border border-agentprism-border ${className}`}
    >
      <div className="absolute top-1.5 right-1.5 z-10">
        <CopyButton label={label} content={content} />
      </div>
      {mode === "json" && parsedContent ? (
        <DetailsViewJsonOutput content={parsedContent} id={id} />
      ) : renderMarkdown ? (
        <div className="rounded-lg bg-agentprism-background p-4">
          <DetailsViewMarkdown content={content} />
        </div>
      ) : parsedContent ? (
        <div className="rounded-lg bg-agentprism-background p-4">
          <DetailsViewPrettyOutput content={parsedContent} />
        </div>
      ) : (
        <div className="rounded-lg bg-agentprism-background p-4">
          <pre className="overflow-x-auto text-left font-mono text-sm whitespace-pre-wrap text-agentprism-foreground">
            {content}
          </pre>
        </div>
      )}
    </div>
  )
}
