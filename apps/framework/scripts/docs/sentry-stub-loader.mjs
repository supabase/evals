// Loader-thread resolve hook: '@sentry/nextjs' -> the no-op stub.
const stubUrl = new URL('./sentry-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === '@sentry/nextjs') {
    return { url: stubUrl, shortCircuit: true };
  }
  return next(specifier, context);
}
