# Changelog

Notable changes to this repo. Not every commit — see `git log` for that.

## 2026-08-02

### Added

- **AgentPrism trace viewer**: a "View span tree" link on every result row opens a full trace panel — span tree, per-span duration/token badges, tool call input/output, docs activity. Backed by a new `EvalResult → AgentPrism spans` adapter (`packages/core/src/trace-viewer.ts`) and lazy per-eval trace export from `pnpm export-results`.
- Real per-turn token usage surfaced as the trace viewer's token badges (previously only aggregate totals were available).
- `DetailsViewPrettyOutput`: a human-readable "Plain" view for tool call JSON — renders real line breaks instead of forcing multi-line shell commands/output onto one escaped-`\n` line. Now the default view for structured tool call data; exact "JSON" stays available alongside it.

### Fixed

- `--agentprism-secondary` (feeds Button, Avatar, Tabs, SpanCardConnector, TraceListItem, and the trace timeline's track background) inherited the app's own `--secondary` token, which lightens off `--background` — invisible in light mode, where the background is already near-max lightness. Rebased on a foreground-tinted overlay so it stays visible in both themes.
- The trace row's title/timeline split used a hardcoded 600px JS width tuned for a wider reference layout; replaced with a CSS grid (`minmax(0,1fr) auto`) so it adapts to whatever panel width actually exists instead of overflowing or wrapping.
- Per-span-type accent colors (`SPAN_ACCENT_COLORS`) were keyed by short names (`tool`, `agent`, `llm`) against `TraceSpanCategory`'s long-form values (`tool_execution`, `agent_invocation`, `llm_call`) — every span except `event` silently fell back to the same gray "unknown" accent. Since removed in favor of no per-row accent border (see below), but worth noting for anyone re-adding one.
- Removed the per-row `border-l-2` type-accent border (read as visual noise); kept the tree connector guide lines.
