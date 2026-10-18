// Meta schemas: request and response shapes of its operations.
import * as z from 'zod';

/** meta.openapi response: the OpenAPI 3.1 document toOpenApi generates from the registry. */
export const MetaOpenapi = z
  .looseObject({
    openapi: z.string(),
    info: z.looseObject({ title: z.string(), version: z.string() }),
    paths: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'MetaOpenapi' });

export type MetaOpenapi = z.infer<typeof MetaOpenapi>;
