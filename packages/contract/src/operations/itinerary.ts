// Generated from operations.csv by src/scripts/import-operations.ts. A story replaces an
// entry's status with 'implemented' and adds its input and output schemas.
import { defineOperation } from '../operation.js';

export const itineraryOperations = [
  defineOperation({
    id: 'itinerary.get',
    method: 'GET',
    path: '/v1/trips/{tripId}/itinerary',
    module: 'Itinerary',
    slice: '1a',
    drop: 'A',
    auth: ['session', 'pat:read', 'oauth:mcp'],
    roles: 'owner, organizer, member, viewer',
    ifMatch: 'no',
    idempotent: 'natural',
    destructive: false,
    mcpApproval: false,
    mcpTool: 'get_itinerary',
    notes:
      'Day timeline ?view=me|group&from&to, with warnings; item_visible; local times per item tz',
    status: 'planned',
  }),
] as const;
