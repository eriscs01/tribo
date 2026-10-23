import * as z from 'zod';

/** Schemas of shown-once values (R2): the response carries them once, storage never does. */
const secrets = new WeakSet<z.ZodType>();

/** Marks a response field as shown once: an idempotent replay omits it and says `redacted`. */
export function secret<T extends z.ZodType>(schema: T): T {
  secrets.add(schema);
  return schema;
}

function isSecret(field: z.ZodType): boolean {
  if (secrets.has(field)) return true;
  return field instanceof z.ZodOptional || field instanceof z.ZodNullable
    ? isSecret(field.unwrap() as z.ZodType)
    : false;
}

/**
 * A response body as it may be stored for replay: every top-level field the output schema
 * marks secret is dropped, and a body that lost one says `redacted: true` (idempotency_keys,
 * R2). A schema with no secret fields, or none at all, leaves the body as it is.
 */
export function withoutSecrets(
  schema: z.ZodType | undefined,
  body: unknown,
): { body: unknown; redacted: boolean } {
  if (!(schema instanceof z.ZodObject) || typeof body !== 'object' || body === null) {
    return { body, redacted: false };
  }
  const shape = schema.shape as Record<string, z.ZodType>;
  const kept = Object.entries(body).filter(([key]) => {
    const field = shape[key];
    return field === undefined || !isSecret(field);
  });
  if (kept.length === Object.keys(body).length) return { body, redacted: false };
  return { body: { ...Object.fromEntries(kept), redacted: true }, redacted: true };
}
