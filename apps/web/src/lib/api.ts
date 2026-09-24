import { API_PREFIX, PROBLEM_CONTENT_TYPE, ProblemDetails } from '@pfm/contracts';

export type Problem = ProblemDetails & Record<string, unknown>;

/**
 * Carries the server's problem document rather than a string, because the UI
 * renders `detail` as written and the locked-entry dialog reads `lockedAt` and
 * `correction` straight off it.
 */
export class ProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ProblemError';
  }
}

const isProblem = (res: Response): boolean =>
  res.headers.get('content-type')?.includes(PROBLEM_CONTENT_TYPE) ?? false;

export const request = async (
  path: string,
  init?: RequestInit,
): Promise<unknown> => {
  const res = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (res.status === 204) return null;

  if (!res.ok) {
    if (isProblem(res)) {
      const body = (await res.json()) as Problem;
      throw new ProblemError({ ...body, ...ProblemDetails.parse(body) });
    }
    throw new ProblemError({
      type: 'about:blank',
      title: 'Request failed',
      status: res.status,
      detail: `The server answered ${res.status}.`,
    });
  }

  return res.json();
};

export const problemOf = (error: unknown): Problem | null =>
  error instanceof ProblemError ? error.problem : null;
