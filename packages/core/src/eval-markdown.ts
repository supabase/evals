import matter from "gray-matter";
import { z } from "zod";

import {
  evalMetadataSchema,
  type ParsedEvalMarkdown,
} from "./eval-metadata.js";

// Node-only: gray-matter pulls in js-yaml and Buffer, so it lives apart from
// the browser-safe schemas in eval-metadata.ts. Only the eval runner and
// result exporter need to read PROMPT.md files.
export function parseEvalMarkdown(
  source: string,
  sourceName = "eval markdown",
): ParsedEvalMarkdown {
  // matter.test() inspects the raw source for a frontmatter delimiter without
  // parsing. We must check it here rather than reading parsed.matter below:
  // gray-matter caches parsed files keyed by content and returns a shallow
  // Object.assign copy on cache hits, which drops the non-enumerable .matter
  // field (it becomes undefined). Since export-results re-parses the same
  // PROMPT.md once per result file, the second read would otherwise crash on
  // parsed.matter.trim().
  if (!matter.test(source)) {
    throw new Error(`${sourceName} is missing eval metadata frontmatter`);
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(source);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`${sourceName} has invalid frontmatter: ${msg}`);
  }

  const raw = parsed.data as Record<string, unknown>;
  const rawSuite = readOptionalScalar(raw, "suite");
  const rawInterface = readOptionalScalar(raw, "interface");
  // Preserve the empty-vs-absent distinction: `services: []` means database
  // only, while an omitted key means the full stack.
  const rawServices = readOptionalStringArray(raw, "services");
  const parsedMetadata = evalMetadataSchema.safeParse({
    stage: normalizeToken(readRequiredScalar(raw, "stage", sourceName)),
    product: readRequiredArray(raw, ["product", "products"], sourceName).map(
      normalizeToken,
    ),
    topic: readRequiredArray(raw, ["topic", "topics"], sourceName).map(
      normalizeToken,
    ),
    suite: rawSuite ? normalizeToken(rawSuite) : undefined,
    interface: rawInterface ? normalizeToken(rawInterface) : undefined,
    services: rawServices?.map(normalizeToken),
    projectRunning: readOptionalBoolean(raw, "projectRunning"),
  });

  if (!parsedMetadata.success) {
    throw new Error(
      `${sourceName} has invalid eval metadata: ${formatZodIssues(parsedMetadata.error.issues)}`,
    );
  }

  return {
    metadata: parsedMetadata.data,
    body: parsed.content.trim(),
  };
}

function readRequiredScalar(
  raw: Record<string, unknown>,
  key: string,
  sourceName: string,
): string {
  const value = toScalar(raw[key]);
  if (value === undefined || !value.trim()) {
    throw new Error(
      `${sourceName} is missing required scalar metadata "${key}"`,
    );
  }
  return value;
}

function readRequiredArray(
  raw: Record<string, unknown>,
  keys: string[],
  sourceName: string,
): string[] {
  const presentKey = keys.find((key) => raw[key] !== undefined);
  if (!presentKey) {
    throw new Error(`${sourceName} is missing required metadata "${keys[0]}"`);
  }

  const value = raw[presentKey];
  const values = Array.isArray(value) ? value : [value];
  const cleaned = values
    .map((item) => toScalar(item)?.trim() ?? "")
    .filter(Boolean);
  if (!cleaned.length) {
    throw new Error(
      `${sourceName} must define at least one "${presentKey}" value`,
    );
  }
  return cleaned;
}

function readOptionalScalar(
  raw: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = toScalar(raw[key]);
  if (value === undefined || !value.trim()) {
    return undefined;
  }
  return value;
}

// YAML may parse scalars as strings, numbers, or booleans; the metadata layer
// treats them all as tokens, so coerce primitives to string and reject objects.
function toScalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

// Returns the array as-is (incl. an explicit empty array, which is meaningful
// for `services`); absent or non-array values become undefined. Items are
// coerced to scalars and blanks dropped, but an empty input array stays empty.
function readOptionalStringArray(
  raw: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = raw[key];
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => toScalar(item)?.trim() ?? "").filter(Boolean);
}

// YAML parses `true`/`false` as booleans; tolerate string forms too. Absent
// stays undefined; an unparseable value is returned verbatim so the schema
// rejects it with a clear error.
function readOptionalBoolean(
  raw: Record<string, unknown>,
  key: string,
): unknown {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  const token = toScalar(value)?.trim().toLowerCase();
  if (token === "true") return true;
  if (token === "false") return false;
  return value;
}

function formatZodIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
