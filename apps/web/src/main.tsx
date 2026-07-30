import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { NuqsAdapter } from "nuqs/adapters/react"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { initAnalytics } from "@/lib/analytics.ts"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NuqsAdapter>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </NuqsAdapter>
  </StrictMode>
)

initAnalytics()
