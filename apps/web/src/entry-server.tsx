import { renderToString } from "react-dom/server"

import { Root } from "./root.tsx"

/** Entry for the `dist-ssr` bundle that `scripts/prerender.mjs` renders. */
export function render() {
  return renderToString(<Root />)
}
