import * as z from 'zod';

/**
 * The one closed set of error codes shared by REST and MCP, with the HTTP status each
 * maps to. `internal_error` covers unexpected failures (500, no details). `not_implemented`
 * is dev-only: registry stubs return it until their story lands, and the 1a gate fails if
 * any 1a operation still does.
 */
export const ERROR_STATUS = {
  unauthenticated: 401,
  mfa_required: 403,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  if_match_required: 428,
  version_conflict: 412,
  idempotency_key_reused: 422,
  capacity_exceeded: 409,
  room_double_booked: 409,
  driver_taken: 409,
  invalid_transition: 409,
  masked_field_write: 409,
  rate_limited: 429,
  file_too_large: 413,
  file_type_not_allowed: 415,
  file_purged: 410,
  username_taken: 409,
  invite_invalid: 410,
  already_member: 409,
  claim_conflict: 409,
  person_has_account: 409,
  owner_transfer_required: 409,
  reset_link_used: 410,
  currency_locked: 409,
  trip_archived: 409,
  trip_retired: 410,
  approval_required: 409,
  approval_not_pending: 409,
  internal_error: 500,
  not_implemented: 501,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]];

export const ErrorCode = z.enum(ERROR_CODES).meta({ id: 'ErrorCode' });
