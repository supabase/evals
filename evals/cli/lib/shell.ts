export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const HELP_PAYLOAD_START = '{"_tag":"Help"';

/** Replaces a CLI help-output JSON payload with a short placeholder. */
export function summarizeHelpOutput(text: string): string {
  const start = text.indexOf(HELP_PAYLOAD_START);
  if (start === -1) return text;
  const end = text.lastIndexOf('}');
  return `${text.slice(0, start)}<help output>${end > start ? text.slice(end + 1) : ''}`;
}

export function describeFailure(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): string {
  const detail = summarizeHelpOutput((result.stderr || result.stdout).trim());
  return detail
    ? `exit ${result.exitCode ?? 'null'}: ${truncate(detail, 200)}`
    : `exit ${result.exitCode ?? 'null'}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `cmd` run inside `dir` — `LocalStackEvalContext.exec` has no cwd option. */
export function inProjectDir(dir: string | undefined, cmd: string): string {
  return dir === undefined ? cmd : `cd ${shellQuote(dir)} && ${cmd}`;
}
