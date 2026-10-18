import * as z from 'zod';

/**
 * What a write that declares no input (a DELETE) validates its body against: no body at
 * all, so one sent by mistake is refused rather than ignored. The registry entry leaves
 * `input` out, so the OpenAPI document shows no request body.
 */
export const NoBody = z.undefined();
