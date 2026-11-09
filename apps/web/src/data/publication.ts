import { z } from "zod"
import { experimentRationaleSchema } from "@supabase-evals/core/eval-metadata"

const publicationSchema = z.array(
  z.object({
    experiment: z.string(),
    withSkills: z.uuid().optional(),
    withoutSkills: z.uuid().optional(),
    rationale: experimentRationaleSchema,
  })
)

type Publication = z.infer<typeof publicationSchema>[number]

// Review the rationale whenever either pinned experiment ID changes.
const entries = [
  {
    experiment: "claude-code-opus-5.5",
    withSkills: "c8e0f865-ca59-4703-a19d-507a234e100a",
    withoutSkills: "e0fd16ad-e117-4165-8e30-9346ebe7e835",
    rationale: {
      summary: [
        "Claude Code's ",
        {
          text: "default model",
          url: "https://code.claude.com/docs/en/model-config#default-model-setting",
        },
        " on most plans, at its ",
        {
          text: "default effort",
          url: "https://code.claude.com/docs/en/model-config#adjust-effort-level",
        },
        ".",
      ],
      asOf: "2026-10-26",
    },
  },
  {
    experiment: "claude-code-sonnet-5.5",
    withSkills: "ede84738-9f79-428f-bdfe-9d8adb2a6489",
    withoutSkills: "15a067ef-f04e-44f5-9f94-7b8c0b0e10f1",
    rationale: {
      summary: [
        "Claude Code's ",
        {
          text: "Sonnet model for daily coding tasks",
          url: "https://code.claude.com/docs/en/model-config",
        },
        ", at its ",
        {
          text: "default effort",
          url: "https://code.claude.com/docs/en/model-config#adjust-effort-level",
        },
        ".",
      ],
      asOf: "2026-10-26",
    },
  },
  {
    experiment: "codex-gpt-6-luna",
    withSkills: "b4a9c5ce-60fc-4604-bc99-595269b7fd7d",
    withoutSkills: "123ecf1b-1004-458c-98cf-b17450b65c92",
    rationale: {
      summary: [
        "A cost-effective model for everyday tasks, and the one behind the ",
        {
          text: "Supabase dashboard assistant",
          url: "https://github.com/supabase/supabase/blob/d98c277790766d2ceb905b675eb0a718f25e6345/apps/studio/lib/ai/model.utils.ts#L92",
        },
        ".",
      ],
      asOf: "2026-10-26",
    },
  },
  {
    experiment: "codex-gpt-6.1-sol",
    withSkills: "d2e33ddc-64f1-4392-892c-d4db9f3d0146",
    withoutSkills: "f2a8dad6-2d8b-4088-8f5f-165d00a24058",
    rationale: {
      summary: [
        "Codex's ",
        {
          text: "default model for ChatGPT accounts, at its default effort",
          url: "https://learn.chatgpt.com/docs/models?surface=app#pick-a-reasoning-effort",
        },
        ".",
      ],
      asOf: "2026-11-09",
    },
  },
  {
    experiment: "grok-4.7",
    withSkills: "e986dead-a1d3-4523-b47d-33a82ff1348b",
    withoutSkills: "545924a6-a02c-482c-9ef7-b4dfc1a993c7",
    rationale: {
      summary: [
        "Grok Build's ",
        {
          text: "default model",
          url: "https://docs.x.ai/developers/grok-4-7",
        },
        ", at its ",
        {
          text: "default effort",
          url: "https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/remote/client.rs#L832-L862",
        },
        ".",
      ],
      asOf: "2026-10-26",
    },
  },
  {
    experiment: "opencode-kimi-k3",
    withSkills: "66f84377-4b0d-4be2-8f41-8e0756cbc40a",
    withoutSkills: "63331944-8a8c-4396-8add-d6fbe88f80d3",
    rationale: {
      summary: [
        "Included as an ",
        {
          text: "open-weight option",
          url: "https://opencode.ai/data/moonshotai/kimi-k3",
        },
        " in OpenCode.",
      ],
      asOf: "2026-10-26",
    },
  },
] satisfies Publication[]

export const publication = publicationSchema.parse(entries)
