import {
  getExperimentDisplay,
  type ExperimentDisplay,
} from "@/lib/eval-results"
import { AGENT_LABELS, formatModelLabel, formatModelName } from "@/lib/format"

type AgentIcon = { dark: string; light?: string }

const AGENT_ICONS: Partial<Record<ExperimentDisplay["agent"], AgentIcon>> = {
  "claude-code": { dark: "agent-claude-icon.svg" },
  codex: {
    dark: "agent-openai-icon.svg",
    light: "agent-openai-icon-light.svg",
  },
  opencode: {
    dark: "agent-opencode-icon.svg",
    light: "agent-opencode-icon-light.svg",
  },
}

const ICON_BASE_PATH = `${import.meta.env.BASE_URL}icons/`

/** Shows an experiment with its agent icon and model. */
export function ExperimentLabel({
  experiment,
  compact = false,
}: {
  experiment: string
  compact?: boolean
}) {
  const display = getExperimentDisplay(experiment)

  if (!display) {
    return experiment
  }

  const icon = AGENT_ICONS[display.agent]

  return (
    <span className="inline-flex items-center gap-1.5">
      {icon && "light" in icon ? (
        <>
          <img
            src={`${ICON_BASE_PATH}${icon.light}`}
            alt=""
            className="size-3.5 shrink-0 object-contain dark:hidden"
          />
          <img
            src={`${ICON_BASE_PATH}${icon.dark}`}
            alt=""
            className="hidden size-3.5 shrink-0 object-contain dark:block"
          />
        </>
      ) : icon ? (
        <img
          src={`${ICON_BASE_PATH}${icon.dark}`}
          alt=""
          className="size-3.5 shrink-0 object-contain"
        />
      ) : null}
      {compact ? (
        <>
          <span className="sr-only">{AGENT_LABELS[display.agent]} / </span>
          <span>{formatModelName(display)}</span>
        </>
      ) : (
        <>
          <span className="text-foreground">{AGENT_LABELS[display.agent]}</span>
          <span className="text-muted-foreground">
            {" / "}
            {formatModelLabel(display)}
          </span>
        </>
      )}
    </span>
  )
}
