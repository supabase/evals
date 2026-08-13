const OVERVIEW_CARDS = [
  {
    step: "1.",
    title: "Work in a realistic environment",
    description:
      "Agents get a realistic environment to work in, with project state, context, and access to the development tools they need.",
  },
  {
    step: "2.",
    title: "Work through a task",
    description:
      "Agents take on a task from somewhere along the Supabase developer journey, from building and deploying to investigating and resolving issues.",
  },
  {
    step: "3.",
    title: "Results are evaluated",
    description:
      "Scoring draws on SQL checks, client calls made as real users, and the files the agent creates. When broader assessment is needed, an LLM judge reviews the result.",
  },
]

export function EvalOverviewCards() {
  return (
    <section aria-label="How evaluations run">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {OVERVIEW_CARDS.map(({ step, title, description }) => (
          <article
            key={title}
            className="flex flex-col gap-3 rounded-lg border border-border bg-card p-6"
          >
            <span className="text-sm text-muted-foreground" aria-hidden>
              {step}
            </span>
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
