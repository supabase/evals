// fallow-ignore-file unused-file -- loaded at runtime (spawned/injected by local-docs.ts), never statically imported
// No-op @sentry/nextjs stand-in for the standalone docs content API.
// The route handler calls Sentry.captureException/flush; under plain tsx
// (outside Next's Sentry instrumentation) the real package's ESM build
// resolves without those functions and every request crashes. A local dev
// adapter has no business sending telemetry anyway. Wired up by
// sentry-stub-register.mjs (see local-docs.ts).
export const captureException = () => '';
export const flush = async () => true;
