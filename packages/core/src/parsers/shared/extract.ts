/**
 * Generic argument extraction for agent transcript parsers.
 *
 * The shared layer stays agnostic: it knows how to pull a value out of a
 * tool-call's args, but NOT which keys a given agent uses. Each harness's parser
 * owns that mapping (its `ArgFieldMap`) and hands it in — mirroring how the
 * tool-name mapping works in `normalize.ts`. So this module's only concern is to
 * extract; the harness-specific knowledge lives with the harness.
 */

/**
 * An agent's arg-key mapping: for each normalized field, the raw arg keys that
 * hold it in that agent's tool calls (tried in order). Owned and supplied by the
 * agent's parser — e.g. Claude Code's Read tool puts the path in `file_path`.
 */
export interface ArgFieldMap {
  path?: readonly string[];
  command?: readonly string[];
  url?: readonly string[];
}

/** Normalized values extracted from a tool call's args. */
export interface ExtractedArgs {
  path?: string;
  command?: string;
  url?: string;
}

// Skill reads can appear as bare paths or quoted shell args in tool-call logs.
// Boundaries are lookarounds (non-consuming) so one command mentioning several
// SKILL.md paths — e.g. a single `cat` of two skills — yields every skill.
const SKILL_ENTRYPOINT_PATTERN =
  /(?<=^|[\s"'`])\S*skills\/([^\s"'`/]+)\/SKILL\.md(?=$|[\s"'`])/g;

/**
 * First arg value among `keys` that is a string — or a string[] joined with
 * spaces (an argv-style command). Undefined if none match.
 */
function firstField(
  args: Record<string, unknown>,
  keys: readonly string[] | undefined
): string | undefined {
  if (!keys) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const joined = value
        .filter((v): v is string => typeof v === 'string')
        .join(' ');
      if (joined) return joined;
    }
  }
  return undefined;
}

/** Extract the normalized fields a parser's `ArgFieldMap` declares from raw args. */
export function extractArgs(
  args: Record<string, unknown>,
  map: ArgFieldMap
): ExtractedArgs {
  return {
    path: firstField(args, map.path),
    command: firstField(args, map.command),
    url: firstField(args, map.url),
  };
}

/** Extracts every loaded skill name from SKILL.md path mentions. */
export function extractLoadedSkillsFromText(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(SKILL_ENTRYPOINT_PATTERN)) {
    names.add(match[1]);
  }
  return [...names];
}
