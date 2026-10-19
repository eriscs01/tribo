import { problem, PROBLEM_CONTENT_TYPE, type ErrorCode, type Problem } from '@tribo/contract';
import { ApiError } from '@tribo/platform';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** The problem code each reply answered with, for the request's log line. */
const problems = new WeakMap<FastifyReply, ErrorCode>();

export function problemOf(reply: FastifyReply): ErrorCode | undefined {
  return problems.get(reply);
}

export function sendProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  code: ErrorCode,
  extra: Pick<Problem, 'detail' | 'errors'> = {},
) {
  const body = problem(code, request.id, { ...extra, instance: request.url.split('?')[0] ?? '' });
  problems.set(reply, code);
  return reply.code(body.status).type(PROBLEM_CONTENT_TYPE).send(body);
}

/**
 * Every error leaves as application/problem+json: expected ones with their code, request
 * shape errors as validation_failed, unknown routes as not_found, and anything else as
 * internal_error with no message or stack (those go to the log only).
 */
export function registerErrorHandling(app: FastifyInstance) {
  app.setNotFoundHandler((request, reply) => sendProblem(reply, request, 'not_found'));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) return sendProblem(reply, request, error.code, error.extra);
    if (error.validation) {
      return sendProblem(reply, request, 'validation_failed', {
        errors: error.validation.map((v) => ({
          path: v.instancePath || '/',
          message: v.message ?? 'invalid',
        })),
      });
    }
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return sendProblem(reply, request, 'validation_failed', { detail: error.message });
    }
    request.log.error({ err: error }, 'unhandled error');
    return sendProblem(reply, request, 'internal_error');
  });
}
