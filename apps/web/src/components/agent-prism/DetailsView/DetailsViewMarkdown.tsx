import type { ReactElement } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

// Hand-styled (no typography plugin, matching the rest of this ported
// component set) — every element maps to the same agentprism-* tokens the
// surrounding trace viewer uses, so a rendered assistant response looks like
// part of the UI, not a foreign markdown blob.
const components: Components = {
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 text-lg font-semibold text-agentprism-foreground first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 text-base font-semibold text-agentprism-foreground first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-sm font-semibold text-agentprism-foreground first:mt-0">
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p className="mb-2 text-sm text-agentprism-foreground last:mb-0">
      {children}
    </p>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-agentprism-brand underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="mb-2 list-disc space-y-1 pl-5 text-sm text-agentprism-foreground">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal space-y-1 pl-5 text-sm text-agentprism-foreground">
      {children}
    </ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  strong: ({ children }) => (
    <strong className="font-semibold text-agentprism-foreground">
      {children}
    </strong>
  ),
  code: ({ children }) => (
    <code className="rounded bg-agentprism-muted px-1 py-0.5 font-mono text-[0.85em] text-agentprism-code-string">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-lg border border-agentprism-border bg-agentprism-muted p-3 font-mono text-xs text-agentprism-foreground">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-agentprism-border pl-3 text-sm text-agentprism-muted-foreground italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-agentprism-border" />,
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto rounded-lg border border-agentprism-border">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-agentprism-muted">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="border-b border-agentprism-border px-3 py-1.5 text-left font-semibold text-agentprism-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-agentprism-border-subtle px-3 py-1.5 text-agentprism-foreground">
      {children}
    </td>
  ),
}

export const DetailsViewMarkdown = ({
  content,
}: {
  content: string
}): ReactElement => (
  <div className="p-1">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  </div>
)
