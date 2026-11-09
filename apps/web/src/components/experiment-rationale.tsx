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
        Why we chose the model and effort for each benchmark experiment.
      </p>
      <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-card">
        {experiments.map((experiment) => {
          const rationale = getExperimentRationale(experiment)
          return (
            <li
              key={experiment}
              className="flex flex-col gap-1 px-5 py-3 text-sm"
            >
              <span className="text-foreground">
                <ExperimentLabel experiment={experiment} />
              </span>
              <p className="leading-6 text-muted-foreground">
                {rationale?.summary.map((part, index) =>
                  typeof part === "string" ? (
                    part
                  ) : (
                    <a
                      key={index}
                      href={part.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      {part.text}
                    </a>
                  )
                )}
              </p>
              {rationale && (
                <p className="text-xs text-muted-foreground">
                  As of <time dateTime={rationale.asOf}>{rationale.asOf}</time>
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
