// fallow-ignore-file unused-file -- registered at runtime by sentry-stub-register.mjs via module.register()
// Loader-thread resolve hook: '@sentry/nextjs' -> the no-op stub.
const stubUrl = new URL('./sentry-stub.mjs', import.meta.url).href;

// fallow-ignore-next-line unused-export -- Node loader-hook contract: the module system calls `resolve`
export async function resolve(specifier, context, next) {
  if (specifier === '@sentry/nextjs') {
    return { url: stubUrl, shortCircuit: true };
  }
  return next(specifier, context);
}
