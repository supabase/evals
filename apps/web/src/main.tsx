import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { NuqsAdapter } from "nuqs/adapters/react"
import { Analytics } from "@vercel/analytics/react"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NuqsAdapter>
      <ThemeProvider>
        <App />
        {/*
         * Manually prefixed so requests survive the supabase.com/evals rewrite, which proxies /evals/* paths.
         * https://vercel.com/docs/analytics/troubleshooting#web-analytics-is-not-working-with-a-proxy-e.g.-cloudflare
         * https://vercel.com/docs/analytics/package
         */}
        <Analytics
          scriptSrc="/evals/_vercel/insights/script.js"
          eventEndpoint="/evals/_vercel/insights/event"
          viewEndpoint="/evals/_vercel/insights/view"
        />
      </ThemeProvider>
    </NuqsAdapter>
  </StrictMode>
)
