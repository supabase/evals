import { formatDuration, getTimelineData } from "@evilmartians/agent-prism-data"
import type { TraceSpan } from "@evilmartians/agent-prism-types"
import * as Collapsible from "@radix-ui/react-collapsible"
import cn from "classnames"
import type { FC, KeyboardEvent, MouseEvent } from "react"
import { useCallback } from "react"

import type { AvatarProps } from "../Avatar"
import { Avatar } from "../Avatar"
import { BrandLogo } from "../BrandLogo"
import { SpanStatus } from "../SpanStatus"
import { SpanCardBadges } from "./SpanCardBadges"
import type { SpanCardConnectorType } from "./SpanCardConnector"
import { SpanCardConnector } from "./SpanCardConnector"
import { SpanCardTimeline } from "./SpanCardTimeline"
import { SpanCardToggle } from "./SpanCardToggle"

const LAYOUT_CONSTANTS = {
  CONNECTOR_WIDTH: 20,
} as const

type ExpandButtonPlacement = "inside" | "outside"

export type SpanCardViewOptions = {
  withStatus?: boolean
  expandButton?: ExpandButtonPlacement
}

const DEFAULT_VIEW_OPTIONS: Required<SpanCardViewOptions> = {
  withStatus: true,
  expandButton: "inside",
}

interface SpanCardProps {
  data: TraceSpan
  level?: number
  selectedSpan?: TraceSpan
  avatar?: AvatarProps
  onSpanSelect?: (span: TraceSpan) => void
  minStart: number
  maxEnd: number
  isLastChild: boolean
  prevLevelConnectors?: SpanCardConnectorType[]
  expandedSpansIds: string[]
  onExpandSpansIdsChange: (ids: string[]) => void
  viewOptions?: SpanCardViewOptions
}

interface SpanCardState {
  isExpanded: boolean
  hasChildren: boolean
  isSelected: boolean
}

const getGridTemplateColumns = ({
  connectorsColumnWidth,
  expandButton,
}: {
  connectorsColumnWidth: number
  expandButton: ExpandButtonPlacement
}) => {
  if (expandButton === "inside") {
    return `${connectorsColumnWidth}px 1fr`
  }

  return `${connectorsColumnWidth}px 1fr ${LAYOUT_CONSTANTS.CONNECTOR_WIDTH}px`
}

const getConnectorsLayout = ({
  level,
  hasExpandButton,
  isLastChild,
  prevConnectors,
  expandButton,
}: {
  hasExpandButton: boolean
  isLastChild: boolean
  level: number
  prevConnectors: SpanCardConnectorType[]
  expandButton: ExpandButtonPlacement
}): {
  connectors: SpanCardConnectorType[]
  connectorsColumnWidth: number
} => {
  const connectors: SpanCardConnectorType[] = []

  if (level === 0) {
    return {
      connectors: expandButton === "inside" ? [] : ["vertical"],
      connectorsColumnWidth: 20,
    }
  }

  for (let i = 0; i < level - 1; i++) {
    connectors.push("vertical")
  }

  if (!isLastChild) {
    connectors.push("t-right")
  }

  if (isLastChild) {
    connectors.push("corner-top-right")
  }

  let connectorsColumnWidth =
    connectors.length * LAYOUT_CONSTANTS.CONNECTOR_WIDTH

  if (hasExpandButton) {
    connectorsColumnWidth += LAYOUT_CONSTANTS.CONNECTOR_WIDTH
  }

  for (let i = 0; i < prevConnectors.length; i++) {
    if (
      prevConnectors[i] === "empty" ||
      prevConnectors[i] === "corner-top-right"
    ) {
      connectors[i] = "empty"
    }
  }

  return {
    connectors,
    connectorsColumnWidth,
  }
}

const useSpanCardEventHandlers = (
  data: TraceSpan,
  onSpanSelect?: (span: TraceSpan) => void
) => {
  const handleCardClick = useCallback((): void => {
    onSpanSelect?.(data)
  }, [data, onSpanSelect])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        handleCardClick()
      }
    },
    [handleCardClick]
  )

  const handleToggleClick = useCallback(
    (e: MouseEvent | KeyboardEvent): void => {
      e.stopPropagation()
    },
    []
  )

  return {
    handleCardClick,
    handleKeyDown,
    handleToggleClick,
  }
}

const SpanCardChildren: FC<{
  data: TraceSpan
  level: number
  selectedSpan?: TraceSpan
  onSpanSelect?: (span: TraceSpan) => void
  minStart: number
  maxEnd: number
  prevLevelConnectors: SpanCardConnectorType[]
  expandedSpansIds: string[]
  onExpandSpansIdsChange: (ids: string[]) => void
  viewOptions?: SpanCardViewOptions
}> = ({
  data,
  level,
  selectedSpan,
  onSpanSelect,
  minStart,
  maxEnd,
  prevLevelConnectors,
  expandedSpansIds,
  onExpandSpansIdsChange,
  viewOptions = DEFAULT_VIEW_OPTIONS,
}) => {
  if (!data.children?.length) return null

  return (
    <div className="relative">
      <Collapsible.Content>
        <ul role="group">
          {data.children.map((child, idx) => {
            const brand = child.metadata?.brand as { type: string } | undefined

            return (
              <SpanCard
                viewOptions={viewOptions}
                key={child.id}
                data={child}
                minStart={minStart}
                maxEnd={maxEnd}
                level={level + 1}
                selectedSpan={selectedSpan}
                onSpanSelect={onSpanSelect}
                isLastChild={idx === (data.children || []).length - 1}
                prevLevelConnectors={prevLevelConnectors}
                expandedSpansIds={expandedSpansIds}
                onExpandSpansIdsChange={onExpandSpansIdsChange}
                avatar={
                  brand
                    ? {
                        children: <BrandLogo brand={brand.type} />,
                        size: "4",
                        rounded: "sm",
                        category: child.type,
                      }
                    : undefined
                }
              />
            )
          })}
        </ul>
      </Collapsible.Content>
    </div>
  )
}

export const SpanCard: FC<SpanCardProps> = ({
  data,
  level = 0,
  selectedSpan,
  onSpanSelect,
  viewOptions = DEFAULT_VIEW_OPTIONS,
  avatar,
  minStart,
  maxEnd,
  isLastChild,
  prevLevelConnectors = [],
  expandedSpansIds,
  onExpandSpansIdsChange,
}) => {
  const isExpanded = expandedSpansIds.includes(data.id)

  const withStatus = viewOptions.withStatus ?? DEFAULT_VIEW_OPTIONS.withStatus
  const expandButton =
    viewOptions.expandButton || DEFAULT_VIEW_OPTIONS.expandButton

  const handleToggleClick = useCallback(
    (expanded: boolean) => {
      const alreadyExpanded = expandedSpansIds.includes(data.id)

      if (alreadyExpanded && !expanded) {
        onExpandSpansIdsChange(expandedSpansIds.filter((id) => id !== data.id))
      }

      if (!alreadyExpanded && expanded) {
        onExpandSpansIdsChange([...expandedSpansIds, data.id])
      }
    },
    [expandedSpansIds, data.id, onExpandSpansIdsChange]
  )

  const state: SpanCardState = {
    isExpanded,
    hasChildren: Boolean(data.children?.length),
    isSelected: selectedSpan?.id === data.id,
  }

  const eventHandlers = useSpanCardEventHandlers(data, onSpanSelect)

  const { durationMs } = getTimelineData({
    spanCard: data,
    minStart,
    maxEnd,
  })

  const hasExpandButtonAsFirstChild =
    expandButton === "inside" && state.hasChildren

  const { connectors, connectorsColumnWidth } = getConnectorsLayout({
    level,
    hasExpandButton: hasExpandButtonAsFirstChild,
    isLastChild,
    prevConnectors: prevLevelConnectors,
    expandButton,
  })

  const gridTemplateColumns = getGridTemplateColumns({
    connectorsColumnWidth,
    expandButton,
  })

  return (
    <li
      role="treeitem"
      aria-selected={state.isSelected ? true : selectedSpan ? false : undefined}
      aria-expanded={state.hasChildren ? state.isExpanded : undefined}
      className="list-none"
    >
      <Collapsible.Root
        open={state.isExpanded}
        onOpenChange={handleToggleClick}
      >
        <div
          className={cn(
            "relative grid w-full",
            state.isSelected &&
              "before:absolute before:-top-2 before:h-2 before:w-full before:bg-agentprism-muted/75",
            state.isSelected &&
              "bg-gradient-to-b from-agentprism-muted/75 to-agentprism-muted/75"
          )}
          style={{
            gridTemplateColumns,
            backgroundSize: "auto calc(100% - 8px)",
            backgroundPosition: "top",
            backgroundRepeat: "no-repeat",
          }}
          onClick={eventHandlers.handleCardClick}
          onKeyDown={eventHandlers.handleKeyDown}
          tabIndex={0}
          role="button"
          aria-pressed={state.isSelected}
          aria-describedby={`span-card-desc-${data.id}`}
          aria-expanded={state.hasChildren ? state.isExpanded : undefined}
          aria-label={`${state.isSelected ? "Selected" : "Not selected"} span card for ${data.title} at level ${level}`}
        >
          <div className="flex flex-nowrap">
            {connectors.map((connector, idx) => (
              <SpanCardConnector key={`${connector}-${idx}`} type={connector} />
            ))}

            {hasExpandButtonAsFirstChild && (
              <div className="flex w-5 flex-col items-center">
                <SpanCardToggle
                  isExpanded={state.isExpanded}
                  title={data.title}
                  onToggleClick={eventHandlers.handleToggleClick}
                />

                {state.isExpanded && <SpanCardConnector type="vertical" />}
              </div>
            )}
          </div>
          <div
            className={cn(
              "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1",
              "mb-3 min-h-5 w-full cursor-pointer",
              level !== 0 && !hasExpandButtonAsFirstChild && "pl-2",
              level !== 0 && hasExpandButtonAsFirstChild && "pl-1"
            )}
          >
            <div
              className="relative flex min-h-4 min-w-0 flex-wrap items-center gap-1.5"
              style={{ minWidth: 140 }}
            >
              {avatar && <Avatar size="4" {...avatar} />}

              <h3
                className="max-w-full truncate font-mono text-sm leading-[14px] text-agentprism-foreground"
                title={data.title}
              >
                {data.title}
              </h3>

              <SpanCardBadges data={data} />
            </div>

            <div className="flex flex-nowrap items-center justify-end gap-1">
              {expandButton === "outside" && withStatus && (
                <div>
                  <SpanStatus status={data.status} />
                </div>
              )}

              <SpanCardTimeline
                minStart={minStart}
                maxEnd={maxEnd}
                spanCard={data}
              />

              <div className="flex items-center gap-2">
                <span className="inline-block w-14 flex-1 shrink-0 px-1 text-right text-xs whitespace-nowrap text-agentprism-foreground">
                  {formatDuration(durationMs)}
                </span>

                {expandButton === "inside" && withStatus && (
                  <div>
                    <SpanStatus status={data.status} />
                  </div>
                )}
              </div>
            </div>
          </div>

          {expandButton === "outside" &&
            (state.hasChildren ? (
              <SpanCardToggle
                isExpanded={state.isExpanded}
                title={data.title}
                onToggleClick={eventHandlers.handleToggleClick}
              />
            ) : (
              <div />
            ))}
        </div>

        <SpanCardChildren
          minStart={minStart}
          maxEnd={maxEnd}
          viewOptions={viewOptions}
          data={data}
          level={level}
          selectedSpan={selectedSpan}
          onSpanSelect={onSpanSelect}
          prevLevelConnectors={connectors}
          expandedSpansIds={expandedSpansIds}
          onExpandSpansIdsChange={onExpandSpansIdsChange}
        />
      </Collapsible.Root>
    </li>
  )
}
