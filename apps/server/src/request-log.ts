import { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import { problemOf } from './errors.js';

/** The design's p95 budgets (Operations, "Performance"): a request over its budget is logged. */
const BUDGET_MS = { read: 300, write: 500 } as const;
const READS = new Set(['GET', 'HEAD']);

/**
 * Fastify's request lines, plus one line for an answer that carries a problem code (a
 * refusal at info, a failure at warn; the stack is on the error handler's own line) and
 * one for a request over its latency budget. Codes and timings only, never values.
 */
export class RequestLog extends LogController {
  override requestCompleted(
    error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
    metadata?: Record<string, unknown>,
  ): void {
    super.requestCompleted(error, request, reply, metadata);
    const status = reply.statusCode;
    const problem = problemOf(reply);
    if (problem !== undefined) {
      const fields = { problem, status };
      if (status >= 500) reply.log.warn(fields, 'request failed');
      else reply.log.info(fields, 'request refused');
    }
    const budgetMs = READS.has(request.method) ? BUDGET_MS.read : BUDGET_MS.write;
    if (reply.elapsedTime > budgetMs) {
      reply.log.warn({ responseTime: reply.elapsedTime, budgetMs }, 'slow request');
    }
  }
}
