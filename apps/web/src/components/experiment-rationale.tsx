import { ExperimentLabel } from "@/components/results/experiment-label"
import {
  getExperimentRationale,
  getSuiteResults,
  getVisibleExperiments,
} from "@/lib/eval-results"

/** Why each benchmark experiment uses its model and effort, with links to check it. */
export function ExperimentRationale() {
  const experiments = getVisibleExperiments(
    getSuiteResults("benchmark")
  ).filter((experiment) => getExperimentRationale(experiment))

  if (!experiments.length) {
    return null
  }

  return (
    <section aria-labelledby="experiment-rationale-title">
      <h2
        id="experiment-rationale-title"
        className="text-base font-medium text-foreground"
      >
        Why these experiments
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        Where an agent has a default model and effort, we use it. Where we
        picked one ourselves, we say why.
      </p>
      <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-card">
        {experiments.map((experiment) => {
          const rationale = getExperimentRationale(experiment)
          return (
            <li
              key={experiment}
              className="flex flex-col gap-1 px-5 py-3 text-sm"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                <span className="text-foreground">
                  <ExperimentLabel experiment={experiment} />
                </span>
                <span className="flex flex-wrap gap-x-4 text-xs">
                  {rationale?.sources.map((source) => (
                    <a
                      key={source.url}
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="whitespace-nowrap text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      {source.label}
                    </a>
                  ))}
                </span>
              </div>
              <p className="leading-6 text-muted-foreground">
                {rationale?.summary}
              </p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
