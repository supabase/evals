import { ExperimentLabel } from "@/components/results/experiment-label"
import {
  getExperimentRationale,
  getExperimentResults,
  getSuiteResults,
  getVisibleExperiments,
} from "@/lib/eval-results"

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
      <div className="mt-6 text-xs text-muted-foreground">
        <h3 className="text-sm font-medium text-foreground">
          Experiment upload dates
        </h3>
        <table className="mt-3 text-left">
          <caption className="sr-only">Experiment upload dates</caption>
          <tbody>
            {experiments.map((experiment) => {
              const createdAt =
                getExperimentResults(experiment)[0]?.experimentCreatedAt
              return (
                <tr key={experiment}>
                  <th scope="row" className="py-1 pr-6 font-normal">
                    <ExperimentLabel experiment={experiment} />
                  </th>
                  <td className="py-1 align-top whitespace-nowrap tabular-nums">
                    <time dateTime={createdAt}>{createdAt?.slice(0, 10)}</time>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
