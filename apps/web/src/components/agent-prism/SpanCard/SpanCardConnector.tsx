export type SpanCardConnectorType =
  | "horizontal"
  | "vertical"
  | "t-right"
  | "corner-top-right"
  | "empty"

interface SpanCardConnectorProps {
  type: SpanCardConnectorType
}

// ponytail: connector types are still passed through from getConnectorsLayout
// (SpanCard.tsx) to preserve indentation spacing, but the lines themselves are
// no longer drawn — removed per feedback that the tree guide lines were more
// visual noise than signal.
export const SpanCardConnector = (_props: SpanCardConnectorProps) => {
  return <div className="w-5 shrink-0 grow" />
}
