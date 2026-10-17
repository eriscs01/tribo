import type { AuthMode, Drop, HttpMethod, Idempotency, IfMatch, Slice } from './operation.js';

/** The registry fields operations.csv defines, mapped from one CSV row. */
export interface CsvOperation {
  id: string;
  method: HttpMethod;
  path: string;
  module: string;
  slice: Slice;
  drop: Drop | null;
  auth: AuthMode[];
  roles: string;
  ifMatch: IfMatch;
  idempotent: Idempotency;
  destructive: boolean;
  mcpApproval: boolean;
  mcpTool: string | null;
  notes: string;
}

function yesNo(value: string | undefined, column: string, id: string): boolean {
  if (value === 'yes') return true;
  if (value === 'no') return false;
  throw new Error(`${id}: ${column} must be yes or no, got ${String(value)}`);
}

export function fromCsvRow(row: Record<string, string>): CsvOperation {
  const id = row.id ?? '';
  const slice = row.slice as Slice;
  const mcpTool = row.mcp_tool ?? '';
  return {
    id,
    method: row.method as HttpMethod,
    path: row.path ?? '',
    module: row.module ?? '',
    slice,
    drop: slice === '1a' ? (row.drop as Drop) : null,
    auth: (row.auth ?? '').split(';').map((a) => a.trim() as AuthMode),
    roles: row.roles ?? '',
    ifMatch: row.if_match as IfMatch,
    idempotent: row.idempotent as Idempotency,
    destructive: yesNo(row.destructive, 'destructive', id),
    mcpApproval: yesNo(row.mcp_approval, 'mcp_approval', id),
    mcpTool: mcpTool === '' ? null : mcpTool,
    notes: row.notes ?? '',
  };
}

/** Registry file for each CSV module, under src/operations/. */
export const MODULE_FILE: Record<string, string> = {
  'Auth & identity': 'auth',
  Me: 'me',
  Trips: 'trips',
  'Members & invites': 'members',
  Items: 'items',
  'Units & assignments & tickets': 'units',
  Itinerary: 'itinerary',
  Expenses: 'expenses',
  Files: 'files',
  Library: 'library',
  'History & restore': 'history',
  Approvals: 'approvals',
  Admin: 'admin',
  'Health/meta': 'meta',
};
