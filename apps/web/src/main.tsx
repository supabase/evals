import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { NuqsAdapter } from "nuqs/adapters/react"
import { Analytics } from "@vercel/analytics/react"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"

const analyticsPrefix =
  window.location.hostname === "supabase.com" ? "/evals" : ""

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NuqsAdapter>
      <ThemeProvider>
        <App />
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
      </ThemeProvider>
    </NuqsAdapter>
  </StrictMode>
)
