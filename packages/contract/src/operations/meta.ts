// Generated from operations.csv by src/scripts/import-operations.ts. A story replaces an
// entry's status with 'implemented' and adds its input and output schemas.
import { defineOperation } from '../operation.js';

export const metaOperations = [
  defineOperation({
    id: 'meta.liveness',
    method: 'GET',
    path: '/healthz',
    module: 'Health/meta',
    slice: '1a',
    drop: 'A',
    auth: ['public'],
    roles: 'anyone',
    ifMatch: 'no',
    idempotent: 'natural',
    destructive: false,
    mcpApproval: false,
    mcpTool: null,
    notes: 'Liveness for Compose/Caddy: 200 when DB reachable; No details returned; Decided (G13)',
    status: 'planned',
  }),
  defineOperation({
    id: 'meta.openapi',
    method: 'GET',
    path: '/v1/openapi.json',
    module: 'Health/meta',
    slice: '1a',
    drop: 'A',
    auth: ['session', 'pat:read'],
    roles: 'any signed-in user',
    ifMatch: 'no',
    idempotent: 'natural',
    destructive: false,
    mcpApproval: false,
    mcpTool: null,
    notes: 'Generated OpenAPI 3.1 document; Decided (G13)',
    status: 'planned',
  }),
] as const;
