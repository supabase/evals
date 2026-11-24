import { z } from 'zod';

export const customMetadataSchema = z
  .strictObject({
    area: z
      .enum([
        'local-stacks',
        'schema-and-migrations',
        'type-generation',
        'edge-functions',
        'linking-and-login',
        'config-and-secrets',
        'branching',
        'tests-and-lint',
        'diagnostics',
        'storage',
      ])
      .optional(),
    // KPI 2 journey phases, which differ from `stage`.
    journeyPhase: z
      .enum(['design', 'deploy', 'observe', 'detect', 'resolve'])
      .optional(),
  })
  .optional();
