import { z } from "zod";

export const evalStageSchema = z.enum([
  "build",
  "deploy",
  "investigate",
  "resolve",
]);
export const EVAL_STAGES = evalStageSchema.options;
export type EvalStage = z.infer<typeof evalStageSchema>;

// Maps to the "Products" hierarchy on https://app.notion.com/p/supabase/Supa-bench-condensed-3675004b775f8066824ce11e9fd06304?source=copy_link#3675004b775f8061ad05e804ec30d425.
export const evalProductSchema = z.enum([
  "database",
  "auth",
  "storage",
  "edge-functions",
  "realtime",
  "cron",
  "queues",
  "vectors",
  "data-api",
]);
export const EVAL_PRODUCTS = evalProductSchema.options;
export type EvalProduct = z.infer<typeof evalProductSchema>;

// Cross-cutting areas agents need to use products effectively. A closed set,
// not freeform: each value is a tracked benchmark dimension.
export const evalTopicSchema = z.enum([
  "rls",
  "security",
  "migrations",
  "sql",
  "sdk",
  "observability",
  "self-hosting",
  "tests",
  "declarative-schema",
]);
export const EVAL_TOPICS = evalTopicSchema.options;
export type EvalTopic = z.infer<typeof evalTopicSchema>;

export const evalSuiteSchema = z.enum(["benchmark", "regression", "other"]);
export const EVAL_SUITES = evalSuiteSchema.options;
export type EvalSuite = z.infer<typeof evalSuiteSchema>;

export const experimentSuiteSchema = z.enum(["benchmark", "no-skills"]);
export const EXPERIMENT_SUITES = experimentSuiteSchema.options;
export type ExperimentSuite = z.infer<typeof experimentSuiteSchema>;

export const agentHarnessIdSchema = z.enum(["ai-sdk", "claude-code", "codex"]);
export type AgentHarnessId = z.infer<typeof agentHarnessIdSchema>;

export const modelProviderSchema = z.enum(["anthropic", "openai"]);
export type ModelProvider = z.infer<typeof modelProviderSchema>;

export const reasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "max",
]);
export type ReasoningEffortLevel = z.infer<typeof reasoningEffortSchema>;

export const experimentDisplayMetadataSchema = z.object({
  agent: agentHarnessIdSchema,
  modelProvider: modelProviderSchema,
  modelId: z.string(),
  reasoningEffort: reasoningEffortSchema.optional(),
});
export type ExperimentDisplayMetadata = z.infer<
  typeof experimentDisplayMetadataSchema
>;

/**
 * Interface(s) the agent uses to act on Supabase — a benchmark dimension
 * (cross-team KPI), not the runtime switch. `mcp` = the platform-lite MCP/tool
 * surface; `cli` = the real Supabase CLI inside a local-stack Docker sandbox.
 *
 * Whether a sandbox boots is decided separately by the presence of a `local/`
 * directory (see the eval runner): `local/` ⇒ sandbox, otherwise the in-memory
 * tools runtime. `interface: cli` additionally forces a sandbox for scenarios
 * that start from an empty workspace (no `local/`).
 */
export const evalInterfaceSchema = z.enum(["mcp", "cli"]);
export const EVAL_INTERFACES = evalInterfaceSchema.options;
export type EvalInterface = z.infer<typeof evalInterfaceSchema>;

export type EvalMetadata = {
  stage: EvalStage;
  product: EvalProduct[];
  topic: EvalTopic[];
  suite: EvalSuite;
  interface?: EvalInterface;
  /**
   * Local-stack services this scenario needs (sandbox evals only); everything
   * else is excluded from `supabase start` to keep boots fast. An empty list
   * (`services: []`) means "only the always-on database, no other services";
   * omit the key entirely for the full stack. Validated against the known
   * service list when the sandbox session starts.
   */
  services?: string[];
  /**
   * Whether the local stack is already running when the agent starts (sandbox
   * evals only). Defaults to true; scenarios where starting the project is
   * part of the task set false.
   */
  projectRunning?: boolean;
  /**
   * Link the sandbox CLI to a mocked hosted project (platform-lite) so hosted
   * workflows (`supabase functions deploy`, `secrets set`) reach it (sandbox
   * evals only). Defaults to false.
   */
  hostedProject?: boolean;
};

export type ParsedEvalMarkdown = {
  metadata: EvalMetadata;
  body: string;
};

export const evalMetadataSchema = z.object({
  stage: evalStageSchema,
  product: z.array(evalProductSchema).min(1),
  topic: z.array(evalTopicSchema).min(1),
  suite: evalSuiteSchema,
  interface: evalInterfaceSchema.optional(),
  services: z.array(z.string().min(1)).optional(),
  // Real YAML booleans or quoted string forms ("true"/"false", yes/no/on/off);
  // anything else is rejected. Avoids z.coerce.boolean, which treats every
  // non-empty string as true.
  projectRunning: z.union([z.boolean(), z.stringbool()]).optional(),
  hostedProject: z.union([z.boolean(), z.stringbool()]).optional(),
});

// Collapse a YAML scalar into a comparable token: trim, lowercase, and fold
// runs of whitespace or underscores to a single hyphen. Lets authors write
// `edge functions`, `edge_functions`, or `edge-functions` for the canonical
// `edge-functions`. Enum fields are matched on this.
const normalizeToken = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");

// YAML scalars arrive as string | number | boolean; the metadata layer treats
// them all as tokens. Non-scalars (objects/arrays/null) pass through unchanged
// so the strict schema below rejects them with a clear error.
const toToken = (value: unknown): unknown =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean"
    ? normalizeToken(String(value))
    : value;

// A scalar or a list of scalars becomes a list of tokens with blanks dropped.
// Absent stays absent so the schema can enforce "required, min 1".
const toTokenList = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value : [value])
    .map(toToken)
    .filter((item) => typeof item === "string" && item.length > 0);
};

// `services` are real Supabase CLI service identifiers (e.g. `postgres-meta`,
// `storage-api`, `edge-runtime`), matched verbatim against ALL_SUPABASE_SERVICES
// in @supabase-evals/sandbox. They must NOT go through normalizeToken: folding
// hyphens to underscores would turn `postgres-meta` into `postgres_meta` and
// fail that match. Only trim + lowercase; preserve hyphens. Blanks are dropped.
const toServiceList = (value: unknown): unknown =>
  (Array.isArray(value) ? value : [value])
    .map((item) =>
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
        ? String(item).trim().toLowerCase()
        : item,
    )
    .filter((item) => typeof item === "string" && item.length > 0);

/**
 * Validates raw frontmatter (from gray-matter / YAML) against
 * {@link evalMetadataSchema}, first normalizing it: scalar coercion, token
 * normalization, `product`/`products` and `topic`/`topics` aliasing, and
 * scalar-or-list widening.
 */
export const evalFrontmatterSchema = z.preprocess((raw) => {
  if (raw === null || typeof raw !== "object") return raw;
  const data = raw as Record<string, unknown>;
  return {
    stage: toToken(data.stage),
    product: toTokenList(data.product ?? data.products),
    topic: toTokenList(data.topic ?? data.topics),
    suite: toToken(data.suite),
    interface: toToken(data.interface),
    // `services: []` means database only; an omitted key means the full stack.
    // Only an explicit list is honored — any other value is treated as absent.
    services: Array.isArray(data.services)
      ? toServiceList(data.services)
      : undefined,
    projectRunning: data.projectRunning,
    hostedProject: data.hostedProject,
  };
}, evalMetadataSchema);

export const checkResultSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  notes: z.string().optional(),
  judgeNotes: z.string().optional(),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

export const skillResultSchema = z.object({
  // Skills exposed to the agent for this run.
  available: z.array(z.string()),
  // Skills whose full instructions were actually loaded during the run.
  loaded: z.array(z.string()),
});
export type SkillResult = z.infer<typeof skillResultSchema>;

// Every dimension that has an authoring enum is enforced against that same
// enum here — the enum is the single source of truth for both authoring
// (evalMetadataSchema) and results. Result files are gitignored, regenerated
// artifacts; a snapshot whose value drifts from the current enum (e.g. a
// renamed stage or topic) fails to parse and is dropped from the export rather
// than rendered with a stale value, and is rebuilt on the next run.
const evalResultShape = {
  experiment: z.string(),
  experimentSuite: experimentSuiteSchema.optional(),
  profile: experimentSuiteSchema.optional(),
  experimentDisplay: experimentDisplayMetadataSchema.optional(),
  eval: z.string(),
  stage: evalStageSchema.optional(),
  product: z.array(evalProductSchema).optional(),
  topic: z.array(evalTopicSchema).optional(),
  suite: evalSuiteSchema.optional(),
  interface: evalInterfaceSchema.optional(),
  passed: z.boolean().optional(),
  checks: z.array(checkResultSchema).optional(),
  attempts: z.number().optional(),
  skills: skillResultSchema.optional(),
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
