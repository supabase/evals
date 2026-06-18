import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * Read a single variable's value from a `.env`-style file, resolved with Node's
 * built-in `util.parseEnv` (so quoting, `export` prefixes, and comments follow
 * dotenv semantics).
 *
 * Scorers use this to read a value a scenario seeds in its `local/.env` so a
 * mock secret is defined in one place (the fixture) rather than duplicated as a
 * literal. Pass a path or a `file:` URL (e.g. resolved against `import.meta.url`).
 * Throws if the file cannot be read or the variable is absent — a caller asking
 * for a named variable expects a value.
 */
export function readEnvVariable(filePath: string | URL, name: string): string {
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read env file ${String(filePath)}: ${msg}`);
  }
  const value = parseEnv(contents)[name];
  if (value === undefined) {
    throw new Error(`${name} not found in env file ${String(filePath)}`);
  }
  return value;
}
