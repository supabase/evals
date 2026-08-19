import { renderToString } from "react-dom/server"

import { Root } from "./root.tsx"

/** Entry for the `dist-ssr` bundle that `scripts/prerender.ts` renders. */
export function render() {
  return renderToString(<Root />)
}
