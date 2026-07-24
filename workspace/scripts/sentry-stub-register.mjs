// Registers a resolve hook that short-circuits '@sentry/nextjs' to the local
// no-op stub. Injected via NODE_OPTIONS from docs-api.sh; chains with tsx's
// own hooks (ours only intercepts the one specifier). Uses module.register()
// (Node 20.6+) rather than registerHooks() (22.15+) — mise pins node "22",
// which an older 22.x install satisfies.
import { register } from "node:module";

register("./sentry-stub-loader.mjs", import.meta.url);
