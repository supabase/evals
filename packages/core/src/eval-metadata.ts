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
  "cron",
  "queues",
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
