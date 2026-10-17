import * as z from 'zod';
import { ERROR_STATUS, ErrorCode } from './errors.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** RFC 9457 problem details, extended with the closed `code`, the request id and field errors. */
export const Problem = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.int().min(400).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
    code: ErrorCode,
    requestId: z.string(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .meta({ id: 'Problem' });

export type Problem = z.infer<typeof Problem>;

const TITLES: Partial<Record<ErrorCode, string>> = {
  not_implemented: 'Not implemented yet',
};

export function problemType(code: ErrorCode): string {
  return `urn:tribo:problem:${code}`;
}

export function problem(
  code: ErrorCode,
  requestId: string,
  extra: Pick<Problem, 'detail' | 'instance' | 'errors'> = {},
): Problem {
  return {
    type: problemType(code),
    title: TITLES[code] ?? code.replaceAll('_', ' '),
    status: ERROR_STATUS[code],
    code,
    requestId,
    ...extra,
  };
}
