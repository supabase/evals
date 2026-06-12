import type {
  EvalMetadata,
  EvalProduct,
  EvalStage,
  EvalSuite,
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
  judge,
  makeRpcAsUser,
  serializeTranscript,
} from "@supabase-evals/core";
export type {
  EvalMetadata,
  EvalProduct,
  EvalStage,
  EvalSuite,
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
  suite: EvalSuite;
  topic: string[];
  dir: string;
  /**
   * `local/` — the agent's starting files (the developer's working
   * directory); for project evals this is the app workspace the agent edits.
   */
  localDir?: string;
  promptPath: string;
  evalPath: string;
  /**
   * `remote/` — the hosted project's starting state, seeded into
   * platform-lite (project.sql, logs.jsonl, functions/).
   */
  remoteDir: string;
}
