/// <reference types="vitest/config" />
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import { structuredData } from "./scripts/structured-data"

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // The app is served at supabase.com/evals
  base: "/evals/",
  plugins: [
    react(),
    tailwindcss(),
    structuredData({
      resultsFile: path.resolve(
        __dirname,
        "./src/data/braintrust-results.json"
      ),
    }),
  ],
  resolve: {
    alias: [
      {
        find: /^@\/data\/eval-results\.json$/,
        replacement: path.resolve(
          __dirname,
          mode === "test"
            ? "./src/data/eval-results.json"
            : "./src/data/braintrust-results.json"
        ),
      },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
  test: {
    name: "web",
  },
}))
