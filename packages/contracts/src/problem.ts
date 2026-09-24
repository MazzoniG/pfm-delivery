import * as z from 'zod';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json' as const;

export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  errors: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
});

export type ProblemDetails = z.infer<typeof ProblemDetails>;
