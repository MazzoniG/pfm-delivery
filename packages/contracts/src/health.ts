import { z } from 'zod';

export const HealthResponse = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().nonnegative(),
});

export const ReadyResponse = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({ database: z.enum(['up', 'down']) }),
});

export type HealthResponse = z.infer<typeof HealthResponse>;
export type ReadyResponse = z.infer<typeof ReadyResponse>;
