import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App, { initResultsStore } from "./App.tsx"
import { fetchEvalResults } from "@/data/eval-results"
import { ThemeProvider } from "@/components/theme-provider.tsx"

// Load results from the Supabase store, install them, then mount. The app reads
// its data from module state that initResultsStore populates before first render.
void fetchEvalResults().then((results) => {
  initResultsStore(results)
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>,
  )
})
