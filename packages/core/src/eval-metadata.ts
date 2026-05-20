export const EVAL_STAGES = [
  "design",
  "deploy",
  "observe",
  "detect",
  "resolve",
] as const;
export type EvalStage = (typeof EVAL_STAGES)[number];

export const EVAL_PRODUCTS = [
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
] as const;
export type EvalProduct = (typeof EVAL_PRODUCTS)[number];

export type EvalMetadata = {
  stage: EvalStage;
  product: EvalProduct[];
  topic: string[];
};

export type ParsedEvalMarkdown = {
  metadata: EvalMetadata;
  body: string;
};

const stageSet = new Set<string>(EVAL_STAGES);
const productSet = new Set<string>(EVAL_PRODUCTS);

export function parseEvalMarkdown(
  source: string,
  sourceName = "eval markdown",
): ParsedEvalMarkdown {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error(`${sourceName} is missing eval metadata frontmatter`);
  }

  const raw = parseSimpleFrontmatter(match[1] ?? "", sourceName);
  const stage = normalizeToken(readRequiredScalar(raw, "stage", sourceName));
  if (!stageSet.has(stage)) {
    throw new Error(
      `${sourceName} has invalid stage "${stage}". Expected one of: ${EVAL_STAGES.join(", ")}`,
    );
  }

  const product = readRequiredArray(
    raw,
    ["product", "products"],
    sourceName,
  ).map(normalizeToken);
  const invalidProducts = product.filter((value) => !productSet.has(value));
  if (invalidProducts.length) {
    throw new Error(
      `${sourceName} has invalid product value(s): ${invalidProducts.join(", ")}. ` +
        `Expected one or more of: ${EVAL_PRODUCTS.join(", ")}`,
    );
  }

  const topic = readRequiredArray(raw, ["topic", "topics"], sourceName).map(
    normalizeToken,
  );
  if (topic.some((value) => !value)) {
    throw new Error(`${sourceName} has an empty topic value`);
  }

  return {
    metadata: {
      stage: stage as EvalStage,
      product: product as EvalProduct[],
      topic,
    },
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
