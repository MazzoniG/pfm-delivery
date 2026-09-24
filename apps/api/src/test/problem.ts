import { expect } from 'vitest';
import type { Response } from 'supertest';
import { PROBLEM_CONTENT_TYPE, ProblemDetails } from '@pfm/contracts';

export const expectProblem = (
  res: Response,
  status: number,
): ProblemDetails => {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);

  const problem = ProblemDetails.parse(res.body);
  expect(problem.status).toBe(status);
  expect(problem.type).toMatch(/^https?:\/\//);
  expect(problem.title.length).toBeGreaterThan(0);

  return problem;
};

/** A Zod rejection is a 400 that names the field it rejected. */
export const expectValidationProblem = (
  res: Response,
  path?: string,
): ProblemDetails => {
  const problem = expectProblem(res, 400);

  expect(problem.errors).toBeDefined();
  expect(problem.errors?.length ?? 0).toBeGreaterThan(0);
  for (const issue of problem.errors ?? []) {
    expect(typeof issue.path).toBe('string');
    expect(issue.message.length).toBeGreaterThan(0);
  }
  if (path !== undefined) {
    expect(problem.errors?.map((issue) => issue.path)).toContain(path);
  }

  return problem;
};
