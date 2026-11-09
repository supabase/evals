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
            <li key={experiment} className="flex flex-col gap-2 px-5 py-5">
              <span className="text-sm font-medium text-foreground [&_span]:text-foreground">
                <ExperimentLabel experiment={experiment} />
              </span>
              <p className="text-[13px] leading-6 text-muted-foreground">
                {rationale?.summary.map((part, index) =>
                  typeof part === "string" ? (
                    part
                  ) : (
                    <a
                      key={index}
                      href={part.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline decoration-muted-foreground/40 underline-offset-4 hover:text-foreground hover:decoration-foreground"
                    >
                      {part.text}
                    </a>
                  )
                )}
              </p>
            </li>
          )
        })}
      </ul>
      <details className="mt-4 text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer hover:text-foreground">
          Source review dates
        </summary>
        <p className="mt-3 leading-5">
          When the sources supporting each model and effort choice were last
          reviewed.
        </p>
        <table className="mt-2 text-left">
          <caption className="sr-only">
            Source review dates by experiment
          </caption>
          <tbody>
            {experiments.map((experiment) => {
              const rationale = getExperimentRationale(experiment)
              return (
                <tr key={experiment}>
                  <th scope="row" className="py-1 pr-6 font-normal">
                    <ExperimentLabel experiment={experiment} />
                  </th>
                  <td className="py-1 align-top whitespace-nowrap tabular-nums">
                    <time dateTime={rationale?.asOf}>{rationale?.asOf}</time>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </details>
    </section>
  )
}
