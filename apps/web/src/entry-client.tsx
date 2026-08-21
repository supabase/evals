import { createRoot, hydrateRoot } from "react-dom/client"
import { Analytics } from "@vercel/analytics/react"

import "./index.css"
import { Root } from "./root.tsx"

const analyticsPrefix =
  window.location.hostname === "supabase.com" ? "/evals" : ""

const rootElement = document.getElementById("root")!

const tree = (
  <Root>
    {/*
     * On supabase.com, the /_vercel/insights/* routes only exist behind the /evals/* rewrite.
     * On the raw *.vercel.app deployments, only the unprefixed routes resolve.
     * https://vercel.com/docs/analytics/troubleshooting#web-analytics-is-not-working-with-a-proxy-e.g.-cloudflare
     */}
    <Analytics
      scriptSrc={`${analyticsPrefix}/_vercel/insights/script.js`}
      eventEndpoint={`${analyticsPrefix}/_vercel/insights/event`}
      viewEndpoint={`${analyticsPrefix}/_vercel/insights/view`}
    />
  </Root>
)

// `vite build` prerenders the markup into #root; `vite dev` serves it empty.
if (rootElement.hasChildNodes()) {
  hydrateRoot(rootElement, tree)
} else {
  createRoot(rootElement).render(tree)
}
