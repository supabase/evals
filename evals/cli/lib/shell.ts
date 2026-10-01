export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function describeFailure(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): string {
  const detail = (result.stderr || result.stdout).trim();
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
