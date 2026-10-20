/** Tags every CLI run in the sandbox as eval traffic, so CLI telemetry can tell it apart from real usage. */
export const EVAL_ENV = { SUPABASE_EVAL: '1' } as const;
