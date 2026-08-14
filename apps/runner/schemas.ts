import { z } from 'zod';

/** Path-safe, since these land in Sandbox command args and result paths. */
const identifier = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);

/** A branch, tag, or commit SHA, rejecting Git's ambiguous `..` syntax. */
const gitRef = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((ref) => !ref.includes('..'))
  .refine((ref) => !ref.endsWith('.') && !ref.endsWith('/'));

export const evalRunInputSchema = z.object({
  experiment: identifier,
  evalId: identifier,
  ref: gitRef.optional(),
});

export const evalBatchSchema = z.object({
  items: z.array(evalRunInputSchema).min(1),
  ref: gitRef.optional(),
  concurrency: z.number().int().positive().optional(),
});

export type EvalRunInput = z.infer<typeof evalRunInputSchema>;
export type EvalBatch = z.infer<typeof evalBatchSchema>;
