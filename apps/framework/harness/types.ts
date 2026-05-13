export type {
  ScoreResult,
  ToolCallRecord,
  CommandResult,
  VitestResult,
  ProjectResult,
  EdgeFunctionsInvokeInput,
  EdgeFunctionsInvokeResult,
  ToolEvalContext,
  ProjectEvalContext,
  ToolScorer,
  ProjectScorer,
  ExperimentConfig,
} from "@supabase-evals/core";

export type EvalCategory = "design" | "deploy" | "observe" | "detect" | "resolve";
export type EvalMode = "tool" | "project";
export type FileEndpoint = "files.list" | "files.read" | "files.write" | "files.edit";

export interface EvalManifest {
  id: string;
  mode: EvalMode;
  category: EvalCategory;
  subcategory?: string;
  dir: string;
  appDir?: string;
  promptPath: string;
  evalPath: string;
  seedDir: string;
}
