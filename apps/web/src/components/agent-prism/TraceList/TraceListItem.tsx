import type { TraceRecord } from "@evilmartians/agent-prism-types"
import cn from "classnames"
import { Coins } from "lucide-react"
import type { KeyboardEvent } from "react"
import { useCallback } from "react"

import type { AvatarProps } from "../Avatar"
import type { BadgeProps } from "../Badge"

import { Badge } from "../Badge"
import { formatTokenCount } from "../shared"
import { TraceListItemHeader } from "./TraceListItemHeader"

interface TraceListItemProps {
  trace: TraceRecord
  badges?: Array<BadgeProps>
  avatar?: AvatarProps
  onClick?: () => void
  isSelected?: boolean
  showDescription?: boolean
}

export const TraceListItem = ({
  trace,
  avatar,
  onClick,
  badges,
  isSelected,
  showDescription = true,
}: TraceListItemProps) => {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        onClick?.()
      }
    },
    [onClick]
  )

  const { name, agentDescription, totalCost, totalTokens } = trace

  // Pass/fail is the one signal worth a colored pill. Everything else
  // (skills, model, ...) reads as plain metadata below — a wall of same-size
  // badges made every field compete for attention instead of just the status.
  const statusBadge = badges?.find((b) =>
    /^(passed|failed)$/i.test(String(b.label))
  )
  const metaBadges = badges?.filter((b) => b !== statusBadge) ?? []

  return (
    <div
      className={cn(
        "group w-full",
        "flex flex-col gap-1.5 py-3",
        "cursor-pointer",
        isSelected
          ? "bg-agentprism-secondary/75 dark:bg-agentprism-muted/80"
          : "bg-agentprism-background hover:bg-agentprism-secondary/45 dark:hover:bg-agentprism-muted/70"
      )}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      aria-label={`Select trace ${name}`}
    >
      <TraceListItemHeader trace={trace} avatar={avatar} />

      <div className="flex flex-col gap-1 px-2">
        {showDescription && agentDescription && (
          <span className="truncate text-xs text-agentprism-muted-foreground">
            {agentDescription}
          </span>
        )}

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {statusBadge && <Badge size="4" {...statusBadge} />}

          {typeof totalTokens === "number" && (
            <span className="inline-flex items-center gap-1 text-xs text-agentprism-muted-foreground tabular-nums">
              <Coins className="size-3 shrink-0" />
              {formatTokenCount(totalTokens)}
            </span>
          )}

          {typeof totalCost === "number" && (
            <span className="text-xs text-agentprism-muted-foreground tabular-nums">
              ${totalCost}
            </span>
          )}

          {metaBadges.map((badge, index) => (
            <span
              key={index}
              className="text-xs text-agentprism-muted-foreground"
            >
              {badge.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
