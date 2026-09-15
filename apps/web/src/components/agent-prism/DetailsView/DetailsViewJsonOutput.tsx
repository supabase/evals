import type { FC } from "react"
import JSONPretty from "react-json-pretty"

import { agentPrismPrefix } from "../theme"

export interface JsonViewerProps {
  content: unknown
  id: string
  className?: string
}

export const DetailsViewJsonOutput: FC<JsonViewerProps> = ({
  content,
  id,
  className = "",
}) => {
  return (
    <JSONPretty
      // `--agentprism-code-*` vars already hold complete color values (see
      // theme.css) — wrapping them in oklch(...) here would double-wrap and
      // silently fail to parse, so these reference the vars directly.
      booleanStyle={`color: var(--${agentPrismPrefix}-code-number);`}
      className={`overflow-x-hidden rounded-xl p-4 text-left ${className}`}
      data={content}
      id={`json-pretty-${id}`}
      keyStyle={`color: var(--${agentPrismPrefix}-code-key);`}
      mainStyle={`color: var(--${agentPrismPrefix}-code-base); font-size: 12px; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word;`}
      stringStyle={`color: var(--${agentPrismPrefix}-code-string);`}
      valueStyle={`color: var(--${agentPrismPrefix}-code-number);`}
    />
  )
}
