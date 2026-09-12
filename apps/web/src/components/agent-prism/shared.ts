import type { TraceSpanCategory } from "@evilmartians/agent-prism-types"
import type { LucideIcon } from "lucide-react"

import {
  BarChart2,
  Bot,
  CircleDot,
  HelpCircle,
  Link,
  MoveHorizontal,
  Plus,
  Search,
  ShieldCheck,
  Wrench,
  Zap,
} from "lucide-react"
import { useEffect, useState } from "react"

// TYPES

export type ColorVariant =
  | "purple"
  | "indigo"
  | "orange"
  | "teal"
  | "cyan"
  | "sky"
  | "yellow"
  | "emerald"
  | "red"
  | "gray"

export type ComponentSize =
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "11"
  | "12"
  | "16"

// CONSTANTS

export const ROUNDED_CLASSES = {
  none: "rounded-none",
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  full: "rounded-full",
}

/**
 * Shared configuration for span categories containing label, theme, and icon
 */
export const SPAN_CATEGORY_CONFIG: Record<
  TraceSpanCategory,
  {
    label: string
    theme: ColorVariant
    icon: LucideIcon
  }
> = {
  llm_call: {
    label: "LLM",
    theme: "purple",
    icon: Zap,
  },
  tool_execution: {
    label: "TOOL",
    theme: "orange",
    icon: Wrench,
  },
  agent_invocation: {
    label: "AGENT INVOCATION",
    theme: "indigo",
    icon: Bot,
  },
  chain_operation: {
    label: "CHAIN",
    theme: "teal",
    icon: Link,
  },
  retrieval: {
    label: "RETRIEVAL",
    theme: "cyan",
    icon: Search,
  },
  embedding: {
    label: "EMBEDDING",
    theme: "emerald",
    icon: BarChart2,
  },
  create_agent: {
    label: "CREATE AGENT",
    theme: "sky",
    icon: Plus,
  },
  span: {
    label: "SPAN",
    theme: "cyan",
    icon: MoveHorizontal,
  },
  event: {
    label: "EVENT",
    theme: "emerald",
    icon: CircleDot,
  },
  guardrail: {
    label: "GUARDRAIL",
    theme: "red",
    icon: ShieldCheck,
  },
  unknown: {
    label: "UNKNOWN",
    theme: "gray",
    icon: HelpCircle,
  },
}

// UTILS

/** `164900` -> `"164.9K"`. Under 1,000 renders as-is (no decimals to add). */
export function formatTokenCount(count: number): string {
  const abs = Math.abs(count)
  if (abs < 1_000) return String(count)
  if (abs < 1_000_000) return `${(count / 1_000).toFixed(1)}K`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/**
 * Recursively parses string values that are themselves JSON — common in
 * tool results (e.g. an MCP error payload's `content[0].text` is a
 * JSON-stringified error object). Without this, the JSON viewer renders that
 * inner structure as one long escaped-quote string instead of a real nested
 * object. Only recurses into strings that look like a JSON object/array
 * (trimmed, starts with `{` or `[`) — a plain string that happens to parse
 * as a number/boolean (e.g. `"5"`, `"true"`) is left alone, since collapsing
 * that would just be surprising, not clarifying.
 */
export function deepParseJson(value: unknown, depth = 0): unknown {
  if (depth > 10) return value // guard against pathological nesting
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value
    try {
      return deepParseJson(JSON.parse(trimmed), depth + 1)
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepParseJson(item, depth + 1))
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        deepParseJson(v, depth + 1),
      ])
    )
  }
  return value
}

export function getSpanCategoryTheme(
  category: TraceSpanCategory
): ColorVariant {
  return SPAN_CATEGORY_CONFIG[category].theme
}

export function getSpanCategoryLabel(category: TraceSpanCategory): string {
  return SPAN_CATEGORY_CONFIG[category].label
}

export function getSpanCategoryIcon(category: TraceSpanCategory): LucideIcon {
  return SPAN_CATEGORY_CONFIG[category].icon
}

export const useIsMobile = () => {
  const isMounted = useIsMounted()

  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    // TODO: replace with something more beautiful and correct (tailwind screens?)
    const mediaQuery = window.matchMedia("(max-width: 1023px)")

    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setIsMobile(e.matches)
    }

    handleChange(mediaQuery)

    mediaQuery.addEventListener("change", handleChange)

    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [])

  return isMounted ? isMobile : false
}

export const useIsMounted = () => {
  const [isMounted, setIsMounted] = useState(false)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  return isMounted
}
