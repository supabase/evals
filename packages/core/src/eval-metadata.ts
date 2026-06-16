import { z } from "zod";

export const evalStageSchema = z.enum([
  "build",
  "deploy",
  "investigate",
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
  topic: string[];
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
  interface: evalInterfaceSchema.optional(),
  // No `.min(1)`: an explicit empty list is meaningful (database only). The
  // distinction between empty and omitted is preserved by the parser.
  services: z.array(z.string().min(1)).optional(),
  projectRunning: z.boolean().optional(),
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
  interface: evalInterfaceSchema.optional(),
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
