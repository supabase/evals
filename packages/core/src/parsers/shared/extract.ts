/**
 * Shared metadata extractors for agent transcript parsers.
 *
 * Pull structured fields (file paths, commands, URLs) out of tool-call args so
 * the adapter and scorers can display/inspect them without knowing each
 * agent's argument shape.
 */

/** Extract a file path from tool-call args, checking common key names. */
export function extractFilePath(
  args: Record<string, unknown>,
): string | undefined {
  const candidate =
    args.path ??
    args.file_path ??
    args.filePath ??
    args.file ??
    args.filename ??
    args.notebook_path;
  return typeof candidate === "string" ? candidate : undefined;
}

/** Extract a shell command from tool-call args (string or argv array). */
export function extractCommand(
  args: Record<string, unknown>,
): string | undefined {
  if (typeof args.command === "string") return args.command;
  if (Array.isArray(args.command)) return args.command.join(" ");
  if (typeof args.cmd === "string") return args.cmd;
  return undefined;
}

/** Extract a URL from tool-call args. */
export function extractUrl(args: Record<string, unknown>): string | undefined {
  const candidate = args.url ?? args.uri ?? args.href;
  return typeof candidate === "string" ? candidate : undefined;
}

/** Convert an epoch-ms number or ISO string to an ISO string. */
export function toISO(ts: unknown): string | undefined {
  if (typeof ts === "number") return new Date(ts).toISOString();
  if (typeof ts === "string") return ts;
  return undefined;
}
