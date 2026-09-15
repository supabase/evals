import type { TraceSpan } from "@evilmartians/agent-prism-types"
import type { ReactElement } from "react"

import { useState } from "react"
import { CollapsibleSection } from "../CollapsibleSection"
import { deepParseJson } from "../shared"
import { TabSelector } from "../TabSelector"
import type { TabItem } from "../Tabs"
import {
  DetailsViewContentViewer,
  type DetailsViewContentViewMode,
} from "./DetailsViewContentViewer"

interface DetailsViewInputOutputTabProps {
  data: TraceSpan
}

type IOSection = "Input" | "Output"

export const DetailsViewInputOutputTab = ({
  data,
}: DetailsViewInputOutputTabProps): ReactElement => {
  const hasInput = Boolean(data.input)
  const hasOutput = Boolean(data.output)

  if (!hasInput && !hasOutput) {
    return (
      <div className="rounded-md border border-agentprism-border p-4">
        <p className="text-sm text-agentprism-muted-foreground">
          No input or output data available for this span
        </p>
      </div>
    )
  }

  let parsedInput: unknown = null
  let parsedOutput: unknown = null

  if (typeof data.input === "string") {
    try {
      parsedInput = deepParseJson(JSON.parse(data.input))
    } catch {
      parsedInput = null
    }
  }

  if (typeof data.output === "string") {
    try {
      parsedOutput = deepParseJson(JSON.parse(data.output))
    } catch {
      parsedOutput = null
    }
  }

  // llm_call/event/agent_invocation spans (Assistant/System/User/check
  // messages, and the root's final agentReport) carry LLM-authored prose —
  // tool_execution content is structured data (args, results) that
  // shouldn't be markdown-parsed (stray `_`/`*` in identifiers, SQL, etc.).
  const renderMarkdown =
    data.type === "llm_call" ||
    data.type === "event" ||
    data.type === "agent_invocation"

  return (
    <div className="space-y-4">
      {typeof data.input === "string" && (
        <IOSection
          section="Input"
          content={data.input}
          parsedContent={parsedInput}
          renderMarkdown={renderMarkdown}
        />
      )}
      {typeof data.output === "string" && (
        <IOSection
          section="Output"
          content={data.output}
          parsedContent={parsedOutput}
          renderMarkdown={renderMarkdown}
        />
      )}
    </div>
  )
}

interface IOSectionProps {
  section: IOSection
  content: string
  parsedContent: unknown
  renderMarkdown: boolean
}

const IOSection = ({
  section,
  content,
  parsedContent,
  renderMarkdown,
}: IOSectionProps): ReactElement => {
  // "Plain" renders real line breaks (DetailsViewPrettyOutput) — the right
  // default for tool call args/results, which are often multi-line shell
  // commands or command output that read as an unreadable single line of
  // escaped `\n`s under strict JSON. "JSON" stays available for exact syntax.
  const [tab, setTab] = useState<DetailsViewContentViewMode>("plain")

  const tabItems: TabItem<DetailsViewContentViewMode>[] = [
    { value: "json", label: "JSON", disabled: !parsedContent },
    { value: "plain", label: "Plain" },
  ]

  return (
    <CollapsibleSection
      title={section}
      defaultOpen
      rightContent={
        <TabSelector<DetailsViewContentViewMode>
          items={tabItems}
          defaultValue="plain"
          value={tab}
          onValueChange={setTab}
          theme="pill"
          onClick={(event) => event.stopPropagation()}
        />
      }
    >
      <DetailsViewContentViewer
        content={content}
        parsedContent={parsedContent}
        mode={tab}
        label={section}
        id={section}
        renderMarkdown={renderMarkdown}
      />
    </CollapsibleSection>
  )
}
