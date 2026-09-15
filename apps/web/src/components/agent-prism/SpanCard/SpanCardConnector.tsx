export type SpanCardConnectorType =
  | "horizontal"
  | "vertical"
  | "t-right"
  | "corner-top-right"
  | "empty"

interface SpanCardConnectorProps {
  type: SpanCardConnectorType
}

export const SpanCardConnector = ({ type }: SpanCardConnectorProps) => {
  if (type === "empty") return <div className="w-5 shrink-0 grow" />

  return (
    <div className="relative w-5 shrink-0 grow">
      {(type === "vertical" || type === "t-right") && (
        <div className="absolute inset-y-0 left-1/2 z-10 w-0.5 -translate-x-1/2 bg-agentprism-border-strong" />
      )}

      {type === "t-right" && (
        <div className="absolute top-2.5 left-2.5 h-0.5 w-2.5 translate-y-[-3px] bg-agentprism-border-strong" />
      )}

      {type === "corner-top-right" && (
        <>
          <div className="absolute top-2 left-1/2 size-0.5 -translate-x-1/2 -translate-y-px bg-agentprism-border-strong" />

          <div className="absolute top-2.5 left-1/2 h-0.5 w-2.5 translate-y-[-3px] bg-agentprism-border-strong" />

          <div className="absolute top-0 left-1/2 h-[7px] w-0.5 -translate-x-px bg-agentprism-border-strong" />
        </>
      )}
    </div>
  )
}
