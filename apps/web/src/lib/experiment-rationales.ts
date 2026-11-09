import { z } from "zod"
import {
  experimentDisplayMetadataSchema,
  type ExperimentDisplayMetadata,
} from "@supabase-evals/core/eval-metadata"
import rawRationales from "../data/experiment-rationales.json" with { type: "json" }

export const experimentRationales = z
  .array(
    z.object({
      experiment: z.string(),
      display: experimentDisplayMetadataSchema,
      rationale: z.object({
        summary: z
          .array(
            z.union([
              z.string().min(1),
              z.object({ text: z.string().min(1), url: z.url() }),
            ])
          )
          .min(1),
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
  experiments: Iterable<[string, { display: ExperimentDisplayMetadata }]>
) {
  return Array.from(experiments)
    .filter(([name]) => name.startsWith("benchmark/"))
    .filter(
      ([name, config]) =>
        !experimentRationales.some(
          (entry) =>
            entry.experiment ===
              name.slice("benchmark/".length).replace(/-no-skills$/, "") &&
            sameExperimentDisplay(entry.display, config.display)
        )
    )
    .map(([name]) => name)
}
