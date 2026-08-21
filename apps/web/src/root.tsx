import { StrictMode, type ReactNode } from "react"
import { NuqsAdapter } from "nuqs/adapters/react"

import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"

/**
 * The tree both entries render. Nothing in here may read browser globals during
 * render: it also runs under `renderToString` for the prerendered HTML.
 */
export function Root({ children }: { children?: ReactNode }) {
  return (
    <StrictMode>
      <NuqsAdapter>
        <ThemeProvider>
          <App />
          {children}
        </ThemeProvider>
      </NuqsAdapter>
    </StrictMode>
  )
}
