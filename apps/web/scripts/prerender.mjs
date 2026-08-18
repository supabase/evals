// Renders the app into dist/index.html after `vite build`, so crawlers and
// answer engines get the leaderboard in the HTML response instead of an empty
// root div. Runs unattended in the Vercel build, so every step is asserted:
// a silently empty page is worse than a failed deploy.
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const htmlFile = path.join(appDir, "dist", "index.html")
const serverEntryFile = path.join(appDir, "dist-ssr", "entry-server.js")

const ROOT_DIV = '<div id="root"></div>'
/** The default view renders a header row plus one row per model, so this is a floor. */
const MIN_TABLE_ROWS = 3
/** Rendered by App when the results file parses to nothing. */
const EMPTY_STATE = "No result files found"

function fail(reason) {
  console.error(
    [
      `prerender failed: ${reason}`,
      "",
      "dist/index.html was left untouched, so nothing shipped. Check, in order:",
      "  1. the server bundle exists: vite build --ssr src/entry-server.tsx --outDir dist-ssr",
      "  2. src/entry-server.tsx still renders the table, which means every dependency",
      "     it pulls in (react-dom/server, nuqs, radix-ui) still server-renders after an upgrade",
      "  3. src/data/eval-results.json still contains results",
      `  4. index.html still contains exactly one ${ROOT_DIV}`,
    ].join("\n")
  )
  process.exit(1)
}

let render
try {
  ;({ render } = await import(pathToFileURL(serverEntryFile).href))
} catch (error) {
  fail(`could not import ${path.relative(appDir, serverEntryFile)} (${error.message})`)
}

if (typeof render !== "function") {
  fail(`${path.relative(appDir, serverEntryFile)} does not export render()`)
}

let markup = ""
try {
  markup = await render()
} catch (error) {
  fail(`render() threw (${error.message})`)
}

if (markup.includes(EMPTY_STATE)) {
  fail("the app rendered its empty state, so the results data did not load")
}

const tableRows = markup.match(/<tr\b/g)?.length ?? 0
if (!markup.includes("<table") || tableRows < MIN_TABLE_ROWS) {
  fail(
    `the rendered markup has no results table (found ${tableRows} table rows, expected at least ${MIN_TABLE_ROWS})`
  )
}

const html = readFileSync(htmlFile, "utf8")
if (!html.includes(ROOT_DIV)) {
  fail(`${path.relative(appDir, htmlFile)} has no ${ROOT_DIV} to replace`)
}

const prerendered = html.replace(ROOT_DIV, () => `<div id="root">${markup}</div>`)
if (prerendered.includes(ROOT_DIV)) {
  fail(`${path.relative(appDir, htmlFile)} still has an empty ${ROOT_DIV}`)
}

writeFileSync(htmlFile, prerendered)
console.log(
  `prerender: wrote ${path.relative(appDir, htmlFile)} (${tableRows} table rows, ${markup.length} bytes of markup)`
)
