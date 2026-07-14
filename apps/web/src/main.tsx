import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App, { initResultsStore } from "./App.tsx"
import { fetchEvalResults } from "@/data/eval-results"
import { ThemeProvider } from "@/components/theme-provider.tsx"

function mount() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>,
  )
}

// Load results from the Supabase store, install them, then mount. The app reads
// its data from module state that initResultsStore populates before first render.
// Always mount — even if the fetch rejects — so a store outage renders the empty
// state instead of a blank page.
void fetchEvalResults()
  .then((results) => initResultsStore(results))
  .catch((error: unknown) => {
    console.error("Failed to load eval results:", error)
    initResultsStore([])
  })
  .finally(mount)
