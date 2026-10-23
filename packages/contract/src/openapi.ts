import * as z from 'zod';
import { honoursIdempotencyKey } from './drop-limits.js';
import { ErrorCode } from './errors.js';
import { PATH_PARAM_PREFIX, typeIdPattern } from './ids.js';
import { pathParams, type AuthMode, type Operation } from './operation.js';
import { Problem, PROBLEM_CONTENT_TYPE } from './problem.js';
import { isRateLimited } from './rate-limits.js';
import { SESSION_COOKIE } from './session.js';

type Json = Record<string, unknown>;

const PROBLEM_REF = { $ref: '#/components/schemas/Problem' };
const problemResponse = (description: string) => ({
  description,
  content: { [PROBLEM_CONTENT_TYPE]: { schema: PROBLEM_REF } },
});

const RATE_LIMITED = {
  ...problemResponse('Too many writes in this window (rate_limited)'),
  headers: {
    'Retry-After': {
      description: 'Seconds until the window resets',
      schema: { type: 'integer', minimum: 1 },
    },
  },
};

const ETAG_HEADER = {
  representation: {
    description: 'SHA-256 (base64url) of this representation, as sent to this caller',
    schema: { type: 'string' },
  },
} as const;

/** A stored file's bytes, under the type sniffed when it was uploaded. */
const FILE_RESPONSE = {
  description: "The file's bytes, under the Content-Type its upload was recognised as",
  headers: {
    'Content-Disposition': {
      description: 'attachment, with the file name (RFC 6266, RFC 8187 for non-ASCII names)',
      schema: { type: 'string' },
    },
  },
  content: { '*/*': { schema: { type: 'string', contentMediaType: 'application/octet-stream' } } },
};

/**
 * A form's text fields and its one `file` part. The form itself is inlined, as the part is
 * not a JSON value, so it carries no id; schemas its fields name still go to components.
 */
function formBody(form: z.ZodObject, components: Components): Json {
  const fields = jsonSchema(form, 'input', components) as Json & {
    properties?: Json;
    required?: string[];
  };
  if (fields.properties === undefined) throw new Error('a form schema must be inlined (no id)');
  return {
    schema: {
      ...fields,
      properties: {
        ...fields.properties,
        file: { type: 'string', contentMediaType: 'application/octet-stream' },
      },
      required: [...(fields.required ?? []), 'file'],
    },
  };
}

/** Named schemas shared through components.schemas, keyed by their Zod `meta({ id })`. */
type Components = Map<string, Json>;

function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      key === '$ref' && typeof v === 'string'
        ? v.replace('#/$defs/', '#/components/schemas/')
        : rewriteRefs(v),
    ]),
  );
}

/**
 * JSON Schema 2020-12 (OpenAPI 3.1's dialect) for a Zod schema. Schemas with an id move to
 * components.schemas and are referenced from there; two different schemas with one id fail.
 */
function jsonSchema(schema: z.ZodType, io: 'input' | 'output', components: Components): Json {
  const {
    $schema: _dialect,
    $defs: defs = {},
    ...rest
  } = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'throw' }) as Json & {
    $defs?: Record<string, Json>;
  };
  for (const [id, def] of Object.entries(defs)) {
    const shared = rewriteRefs(def) as Json;
    const existing = components.get(id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(shared)) {
      throw new Error(`schema id ${id} has two different ${io} shapes`);
    }
    components.set(id, shared);
  }
  return rewriteRefs(rest) as Json;
}

/** OpenAPI security requirements for the REST surface; oauth:mcp is reachable only at /mcp. */
function security(auth: readonly AuthMode[]): Json[] {
  return auth.flatMap((mode): Json[] => {
    switch (mode) {
      case 'public':
        return [{}];
      case 'session':
        return [{ session: [] }];
      case 'pat:read':
        return [{ pat: ['read'] }];
      case 'pat:write':
        return [{ pat: ['write'] }];
      case 'oauth:mcp':
        return [];
      default: {
        const unhandled: never = mode;
        throw new Error(`auth mode ${String(unhandled)} has no OpenAPI security scheme`);
      }
    }
  });
}

/** One query parameter per key of the operation's query object, as JSON Schema input. */
function queryParameters(query: z.ZodObject, components: Components): Json[] {
  const object = jsonSchema(query, 'input', components) as {
    properties?: Record<string, Json>;
    required?: string[];
  };
  return Object.entries(object.properties ?? {}).map(([name, schema]) => ({
    name,
    in: 'query',
    required: object.required?.includes(name) ?? false,
    schema,
  }));
}

function parameters(op: Operation, components: Components): Json[] {
  const params: Json[] = pathParams(op.path).map((name) => {
    const prefix = PATH_PARAM_PREFIX[name];
    return {
      name,
      in: 'path',
      required: true,
      schema: prefix ? { type: 'string', pattern: typeIdPattern(prefix) } : { type: 'string' },
    };
  });
  if (op.query) params.push(...queryParameters(op.query, components));
  if (op.ifMatch !== 'no') {
    params.push({
      name: 'If-Match',
      in: 'header',
      required: op.ifMatch !== 'version_or_new',
      description: `Current ${op.ifMatch === 'version_or_new' ? 'version (omit to create)' : op.ifMatch} as an ETag`,
      schema: { type: 'string' },
    });
  }
  if (op.etag) {
    params.push({
      name: 'If-None-Match',
      in: 'header',
      required: false,
      description: 'An ETag already held; 304 when it is still current',
      schema: { type: 'string' },
    });
  } else if (op.ifMatch === 'version_or_new') {
    params.push({
      name: 'If-None-Match',
      in: 'header',
      required: false,
      description: 'Send * to create: refused with version_conflict when one already exists',
      schema: { type: 'string', enum: ['*'] },
    });
  }
  // The CSV's `key` is the design; the header is declared only where this release honours it.
  if (honoursIdempotencyKey(op)) {
    params.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description: 'Replays the stored response for 24 hours per caller',
      schema: { type: 'string', maxLength: 255 },
    });
  }
  return params;
}

function operationObject(op: Operation, components: Components): Json {
  const responses: Json = {};
  if (op.status === 'planned') {
    responses['501'] = problemResponse('Registered but not implemented yet (not_implemented)');
  } else if (op.returnsFile) {
    responses['200'] = FILE_RESPONSE;
  } else if (op.output) {
    responses[op.method === 'POST' ? '201' : '200'] = {
      description: 'OK',
      ...(op.etag ? { headers: { ETag: ETAG_HEADER[op.etag] } } : {}),
      content: { 'application/json': { schema: jsonSchema(op.output, 'output', components) } },
    };
    if (op.etag) responses['304'] = { description: 'Not modified: If-None-Match names the ETag' };
  } else {
    responses['204'] = { description: 'No content' };
  }
  if (isRateLimited(op)) responses['429'] = RATE_LIMITED;
  responses.default = problemResponse('Error');

  const object: Json = {
    operationId: op.id,
    summary: op.id,
    description: op.notes,
    tags: [op.module],
    security: security(op.auth),
    responses,
    'x-tribo': {
      status: op.status,
      slice: op.slice,
      drop: op.drop,
      roles: op.roles,
      ifMatch: op.ifMatch,
      idempotent: op.idempotent,
      destructive: op.destructive,
      mcpApproval: op.mcpApproval,
      mcpTool: op.mcpTool,
    },
  };
  const params = parameters(op, components);
  if (params.length > 0) object.parameters = params;
  if (op.form) {
    object.requestBody = {
      required: true,
      content: { 'multipart/form-data': formBody(op.form, components) },
    };
  } else if (op.input) {
    object.requestBody = {
      required: true,
      content: { 'application/json': { schema: jsonSchema(op.input, 'input', components) } },
    };
  }
  return object;
}

export interface OpenApiInfo {
  version: string;
}

/** Builds the OpenAPI 3.1 document for the given registry. Deterministic for a given input. */
export function toOpenApi(
  registry: readonly Operation[],
  info: OpenApiInfo = { version: '0.0.0' },
): Json {
  const components: Components = new Map();
  jsonSchema(Problem, 'output', components);
  jsonSchema(ErrorCode, 'output', components);
  // A Map, so no path string (not even __proto__) can name an existing property.
  const paths = new Map<string, Json>();
  for (const op of registry) {
    const item = paths.get(op.path) ?? {};
    paths.set(op.path, item);
    item[op.method.toLowerCase()] = operationObject(op, components);
  }
  const sorted = Object.fromEntries([...paths].sort(([a], [b]) => a.localeCompare(b)));
  return {
    openapi: '3.1.1',
    info: { title: 'Tribo API', version: info.version },
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    paths: sorted,
    components: {
      schemas: Object.fromEntries([...components].sort(([a], [b]) => a.localeCompare(b))),
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE,
          description: 'Web session; unsafe methods also need the CSRF header',
        },
        pat: { type: 'http', scheme: 'bearer', description: 'Personal access token (1b)' },
      },
    },
  };
}
