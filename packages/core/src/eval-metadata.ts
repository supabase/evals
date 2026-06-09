import { z } from "zod";

export const evalStageSchema = z.enum([
  "design",
  "deploy",
  "observe",
  "detect",
  "resolve",
]);
export const EVAL_STAGES = evalStageSchema.options;
export type EvalStage = z.infer<typeof evalStageSchema>;

export const evalProductSchema = z.enum([
  "database",
  "storage",
  "auth",
  "data api",
  "sdk",
  "realtime",
  "functions",
  "cli",
  "docs",
  "self-hosted",
]);
export const EVAL_PRODUCTS = evalProductSchema.options;
export type EvalProduct = z.infer<typeof evalProductSchema>;

export const evalSuiteSchema = z.enum(["benchmark", "regression"]);
export const EVAL_SUITES = evalSuiteSchema.options;
export type EvalSuite = z.infer<typeof evalSuiteSchema>;

export type EvalMetadata = {
  stage: EvalStage;
  product: EvalProduct[];
  topic: string[];
  suite: EvalSuite;
};

export type ParsedEvalMarkdown = {
  metadata: EvalMetadata;
  body: string;
};

export const evalMetadataSchema = z.object({
  stage: evalStageSchema,
  product: z.array(evalProductSchema).min(1),
  topic: z.array(z.string().min(1)).min(1),
  suite: evalSuiteSchema.default("regression"),
});

export const checkResultSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  notes: z.string().optional(),
  judgeNotes: z.string().optional(),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

const evalResultShape = {
  experiment: z.string(),
  eval: z.string(),
  stage: evalStageSchema.optional(),
  product: z.array(evalProductSchema).optional(),
  topic: z.array(z.string()).optional(),
  suite: evalSuiteSchema.optional(),
  passed: z.boolean().optional(),
  checks: z.array(checkResultSchema).optional(),
  attempts: z.number().optional(),
};

// Raw result files may carry extra fields we don't model; tolerate them.
export const rawEvalResultSchema = z.looseObject(evalResultShape);

// Web-facing result; a clean strict object so its inferred type stays usable.
export const evalResultSchema = z.object({
  ...evalResultShape,
  passed: z.boolean(),
  prompt: z.string().optional(),
  promptSourcePath: z.string().optional(),
  sourcePath: z.string(),
});
export type EvalResult = z.infer<typeof evalResultSchema>;

export function parseEvalMarkdown(
  source: string,
  sourceName = "eval markdown",
): ParsedEvalMarkdown {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error(`${sourceName} is missing eval metadata frontmatter`);
  }

  const raw = parseSimpleFrontmatter(match[1] ?? "", sourceName);
  const rawSuite = readOptionalScalar(raw, "suite");
  const parsedMetadata = evalMetadataSchema.safeParse({
    stage: normalizeToken(readRequiredScalar(raw, "stage", sourceName)),
    product: readRequiredArray(raw, ["product", "products"], sourceName).map(
      normalizeToken,
    ),
    topic: readRequiredArray(raw, ["topic", "topics"], sourceName).map(
      normalizeToken,
    ),
    suite: rawSuite ? normalizeToken(rawSuite) : undefined,
  });

  if (!parsedMetadata.success) {
    throw new Error(
      `${sourceName} has invalid eval metadata: ${formatZodIssues(parsedMetadata.error.issues)}`,
    );
  }

  return {
    metadata: parsedMetadata.data,
    body: source.slice(match[0].length).trim(),
  };
}

function parseSimpleFrontmatter(
  source: string,
  sourceName: string,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let currentListKey: string | undefined;

  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;

    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem) {
      if (!currentListKey) {
        throw new Error(
          `${sourceName} has a list item without a key on metadata line ${index + 1}`,
        );
      }
      const current = out[currentListKey];
      if (!Array.isArray(current)) {
        throw new Error(
          `${sourceName} mixes scalar and list values for "${currentListKey}"`,
        );
      }
      current.push(unquote(listItem[1] ?? ""));
      continue;
    }

    const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!pair) {
      throw new Error(
        `${sourceName} has unsupported metadata syntax on line ${index + 1}`,
      );
    }

    const key = normalizeToken(pair[1] ?? "");
    const value = pair[2]?.trim() ?? "";
    if (!value) {
      out[key] = [];
      currentListKey = key;
      continue;
    }

    out[key] = parseInlineValue(value);
    currentListKey = undefined;
  }

  return out;
}

function parseInlineValue(value: string): string | string[] {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => unquote(item))
      .filter(Boolean);
  }

  return unquote(value);
}

function readRequiredScalar(
  raw: Record<string, string | string[]>,
  key: string,
  sourceName: string,
): string {
  const value = raw[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `${sourceName} is missing required scalar metadata "${key}"`,
    );
  }
  return value;
}

function readRequiredArray(
  raw: Record<string, string | string[]>,
  keys: string[],
  sourceName: string,
): string[] {
  const presentKey = keys.find((key) => raw[key] !== undefined);
  if (!presentKey) {
    throw new Error(`${sourceName} is missing required metadata "${keys[0]}"`);
  }

  const value = raw[presentKey];
  const values = Array.isArray(value) ? value : [value];
  const cleaned = values.map((item) => item.trim()).filter(Boolean);
  if (!cleaned.length) {
    throw new Error(
      `${sourceName} must define at least one "${presentKey}" value`,
    );
  }
  return cleaned;
}

function readOptionalScalar(
  raw: Record<string, string | string[]>,
  key: string,
): string | undefined {
  const value = raw[key];
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
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
  return unquote(value).trim().toLowerCase().replace(/\s+/g, " ");
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
