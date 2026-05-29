import type {
  EvalMetadata,
  EvalProduct,
  EvalStage,
} from "@supabase-evals/core/eval-metadata";

export type {
  ScoreResult,
  CheckResult,
  ToolCallRecord,
  TranscriptPart,
  TranscriptSerializationOptions,
  JudgeInput,
  JudgeResult,
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
export {
  check,
  judge,
  serializeTranscript,
} from "@supabase-evals/core";
export type {
  EvalMetadata,
  EvalProduct,
  EvalStage,
} from "@supabase-evals/core/eval-metadata";

export type EvalMode = "tool" | "project";
export type FileEndpoint =
  | "files.list"
  | "files.read"
  | "files.write"
  | "files.edit";

export interface EvalManifest {
  id: string;
  mode: EvalMode;
  metadata: EvalMetadata;
  stage: EvalStage;
  product: EvalProduct[];
  topic: string[];
  dir: string;
  appDir?: string;
  promptPath: string;
  evalPath: string;
  seedDir: string;
}
