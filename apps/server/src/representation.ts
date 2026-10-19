import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** A representation's entity tag: the SHA-256 of the bytes sent (rule 4: freshness is derived). */
function representationTag(body: string): string {
  return `"${createHash('sha256').update(body).digest('base64url')}"`;
}

/** True when an If-None-Match header names this tag, or is `*` (RFC 9110, weak comparison). */
function noneMatch(header: string | undefined, tag: string): boolean {
  if (header === undefined) return false;
  return header
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === tag);
}

/**
 * Sends a read with its ETag. A caller whose If-None-Match already names it gets 304 with
 * no body, so polling a per-caller representation costs no transfer when nothing changed.
 */
export function sendRepresentation(request: FastifyRequest, reply: FastifyReply, view: unknown) {
  const body = JSON.stringify(view);
  const tag = representationTag(body);
  reply.header('etag', tag);
  if (noneMatch(request.headers['if-none-match'], tag)) return reply.code(304).send();
  return reply.type('application/json; charset=utf-8').send(body);
}
