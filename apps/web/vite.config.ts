import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import { structuredData } from "./scripts/structured-data"

// https://vite.dev/config/
export default defineConfig({
  // The app is served at supabase.com/evals
  base: "/evals/",
  plugins: [
    react(),
    tailwindcss(),
    structuredData({
      resultsFile: path.resolve(__dirname, "./src/data/eval-results.json"),
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
