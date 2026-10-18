import type * as z from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Slice = '1a' | 'after-trip' | '1b';
export type Drop = 'A' | 'B';
/** session = web cookie + CSRF; pat:* = personal access token scope (1b); oauth:mcp = MCP tool (1b). */
export type AuthMode = 'public' | 'session' | 'pat:read' | 'pat:write' | 'oauth:mcp';
/** The aggregate counter a write must match in If-Match, or 'no'. */
export type IfMatch = 'no' | 'version' | 'board_version' | 'budget_version' | 'version_or_new';
/** key = takes Idempotency-Key; natural = safe to repeat; no = never replayed. */
export type Idempotency = 'key' | 'natural' | 'no';
/** planned = registered stub answering 501 not_implemented; implemented = has a handler. */
export type OperationStatus = 'planned' | 'implemented';

export interface Operation {
  id: string;
  method: HttpMethod;
  path: string;
  module: string;
  slice: Slice;
  drop: Drop | null;
  auth: readonly AuthMode[];
  roles: string;
  ifMatch: IfMatch;
  idempotent: Idempotency;
  destructive: boolean;
  mcpApproval: boolean;
  mcpTool: string | null;
  notes: string;
  status: OperationStatus;
  /** Query parameters, one per key; GET reads take these instead of a body. */
  query?: z.ZodObject;
  input?: z.ZodType;
  output?: z.ZodType;
}

const ID = /^[a-z]+(\.[a-z][a-zA-Z]*)+$/;
const PATH = /^\/(v1\/[a-z0-9\-/{}A-Za-z.]+|healthz)$/;

/** Declares one operation. Checks the shape here so a bad entry fails at import, not in a route. */
export function defineOperation<const T extends Operation>(op: T): Readonly<T> {
  if (!ID.test(op.id)) throw new Error(`operation id ${op.id} is not <resource>.<verb>`);
  if (!PATH.test(op.path)) throw new Error(`operation ${op.id} has an unexpected path ${op.path}`);
  if (op.slice === '1a' && op.drop === null) throw new Error(`1a operation ${op.id} needs a drop`);
  if (op.slice !== '1a' && op.drop !== null) throw new Error(`${op.id} has a drop outside 1a`);
  if (op.auth.length === 0) throw new Error(`operation ${op.id} declares no auth`);
  return Object.freeze(op);
}

export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '');
}
