import { BotIcon, CheckIcon, FileTextIcon } from "lucide-react"

const OVERVIEW_CARDS = [
  {
    title: "Seeded project state",
    description:
      "Each eval seeds the project the agent inherits: schema, rows, logs, and deployed functions, plus the local files it starts from.",
    Icon: FileTextIcon,
  },
  {
    title: "Pinned experiments",
    description:
      "An experiment fixes the agent, model, reasoning effort, skills, and tools: Supabase MCP, the real CLI in a Docker sandbox, or both.",
    Icon: BotIcon,
  },
  {
    title: "Scored on outcomes",
    description:
      "When the agent stops, scorers inspect the state it left with SQL, client calls as real users, and the workspace it built. Report-only tasks get a judge.",
    Icon: CheckIcon,
  },
]

export function EvalOverviewCards() {
  return (
    <section aria-label="How evaluations run">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {OVERVIEW_CARDS.map(({ title, description, Icon }) => (
          <article
            key={title}
            className="flex flex-col gap-3 rounded-lg border border-border bg-card p-6"
          >
            <Icon className="size-5 text-muted-foreground" aria-hidden />
            <h2 className="text-base font-medium text-foreground">{title}</h2>
            <p className="text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </article>
        ))}
      </div>
    </section>
  )
}
