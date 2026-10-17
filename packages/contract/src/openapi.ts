import * as z from 'zod';
import { ErrorCode } from './errors.js';
import { PATH_PARAM_PREFIX, typeIdPattern } from './ids.js';
import { pathParams, type AuthMode, type Operation } from './operation.js';
import { Problem, PROBLEM_CONTENT_TYPE } from './problem.js';
import { SESSION_COOKIE } from './session.js';

type Json = Record<string, unknown>;

const PROBLEM_REF = { $ref: '#/components/schemas/Problem' };
const problemResponse = (description: string) => ({
  description,
  content: { [PROBLEM_CONTENT_TYPE]: { schema: PROBLEM_REF } },
});

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

function parameters(op: Operation): Json[] {
  const params: Json[] = pathParams(op.path).map((name) => {
    const prefix = PATH_PARAM_PREFIX[name];
    return {
      name,
      in: 'path',
      required: true,
      schema: prefix ? { type: 'string', pattern: typeIdPattern(prefix) } : { type: 'string' },
    };
  });
  if (op.ifMatch !== 'no') {
    params.push({
      name: 'If-Match',
      in: 'header',
      required: op.ifMatch !== 'version_or_new',
      description: `Current ${op.ifMatch === 'version_or_new' ? 'version (omit to create)' : op.ifMatch} as an ETag`,
      schema: { type: 'string' },
    });
  }
  if (op.idempotent === 'key') {
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
  } else {
    responses[op.method === 'POST' ? '201' : '200'] = op.output
      ? {
          description: 'OK',
          content: { 'application/json': { schema: jsonSchema(op.output, 'output', components) } },
        }
      : { description: 'OK' };
  }
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
  const params = parameters(op);
  if (params.length > 0) object.parameters = params;
  if (op.input) {
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
  const paths: Record<string, Json> = {};
  for (const op of registry) {
    const item = (paths[op.path] ??= {});
    item[op.method.toLowerCase()] = operationObject(op, components);
  }
  const sorted = Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)));
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
