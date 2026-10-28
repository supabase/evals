import { z } from "zod"
import {
  experimentDisplayMetadataSchema,
  experimentRationaleSchema,
  type ExperimentDisplayMetadata,
  type ExperimentSuite,
} from "@supabase-evals/core/eval-metadata"
import rawRationales from "../data/experiment-rationales.json" with { type: "json" }

export const experimentRationales = z
  .array(
    z.object({
      experiment: z.string(),
      display: experimentDisplayMetadataSchema,
      rationale: experimentRationaleSchema.extend({
        summary: z.string().trim().min(1),
        asOf: z.iso.date(),
      }),
    })
  )
  .parse(rawRationales)

export function sameExperimentDisplay(
  a: ExperimentDisplayMetadata,
  b: ExperimentDisplayMetadata
) {
  return (
    a.agent === b.agent &&
    a.modelProvider === b.modelProvider &&
    a.modelId === b.modelId &&
    a.reasoningEffort === b.reasoningEffort
  )
}

export function missingBenchmarkRationales(
  experiments: Iterable<
    [string, { display: ExperimentDisplayMetadata; suites: ExperimentSuite[] }]
  >
) {
  return Array.from(experiments)
    .filter(([, config]) => config.suites.includes("benchmark"))
    .filter(
      ([name, config]) =>
        !experimentRationales.some(
          (entry) =>
            entry.experiment === name &&
            sameExperimentDisplay(entry.display, config.display)
        )
    )
    .map(([name]) => name)
}
