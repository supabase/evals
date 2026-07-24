// Registers a resolve hook that short-circuits '@sentry/nextjs' to the local
// no-op stub. Injected via NODE_OPTIONS from docs-api.sh; chains with tsx's
// own hooks (ours only intercepts the one specifier).
import { registerHooks } from "node:module";

const stubUrl = new URL("./sentry-stub.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@sentry/nextjs") {
      return { url: stubUrl, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
