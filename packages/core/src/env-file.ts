import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * Read a `.env`-style file and parse it into a `NAME -> value` map. Parsing is
 * delegated to Node's built-in `util.parseEnv` (so quoting, `export` prefixes,
 * comments, etc. follow dotenv semantics) — this wrapper just adds the file
 * read and a clear error.
 *
 * Scorers use this to read a scenario's seeded `local/.env` so a mock secret is
 * defined in one place (the fixture) rather than duplicated as a literal in the
 * scorer. Pass a path or a `file:` URL (e.g. resolved against `import.meta.url`).
 * Throws if the file cannot be read.
 */
export function readEnvFile(
  filePath: string | URL,
): Record<string, string | undefined> {
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read env file ${String(filePath)}: ${msg}`);
  }
  return parseEnv(contents);
}
