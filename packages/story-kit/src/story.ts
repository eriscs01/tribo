import { ERROR_CODES, MODULE_FILE, type ErrorCode, type Operation } from '@tribo/contract';
import { VALUE_SETS, type TableOwner, type ValueOf } from '@tribo/db';
import { dropLimits } from './limits.js';

export type TripRole = ValueOf<'tribo.memberships.trip_role'>;

/** The core module that owns each resource's tables (TABLE_OWNER in @tribo/db), by id prefix. */
const CORE_MODULE: Record<string, Exclude<TableOwner, 'platform'>> = {
  auth: 'identity',
  me: 'identity',
  trips: 'trips',
  members: 'trips',
  invites: 'trips',
  items: 'items',
  overlays: 'items',
  units: 'items',
  tickets: 'items',
  checklist: 'items',
  itinerary: 'itinerary',
  expenses: 'expenses',
  budget: 'expenses',
  files: 'documents',
  library: 'library',
};

/** Verbs whose schemas take the resource's own name: ItemInput, ItemPatch, Item, ItemPage. */
const PLAIN_VERBS = new Set(['create', 'update', 'get', 'put', 'replace', 'list', 'search']);
const LIST_VERBS = new Set(['list', 'search']);

/** A schema the story fills in, named for the contract and declared in `file`. */
export interface SchemaName {
  name: string;
  /** Under packages/contract/src/. */
  file: string;
}

/** Everything a story derives from its registry entry, before any file is touched. */
export interface Story {
  op: Operation;
  /** `drop-a` or `drop-b`: the Vitest tag on its tests. */
  tag: string;
  /** The singular resource the schemas are named for: Item, Assignment, Person. */
  noun: string;
  isList: boolean;
  isWrite: boolean;
  /** Under packages/contract/src/: the resource's schemas live here. */
  contractFile: string;
  /** The resource itself; reused when it exists, scaffolded when not. */
  resource: SchemaName;
  input: SchemaName | null;
  output: SchemaName | null;
  /** The trip roles operations.csv grants, or null when the rule is not a trip role. */
  tripRoles: TripRole[] | null;
  /** The core module whose policy.ts takes the policy row, or null outside core (meta). */
  coreModule: string | null;
  /** apps/server/src/handlers/<file>.ts and packages/contract/src/operations/<file>.ts. */
  moduleFile: string;
  policyName: string;
  /** The error codes the CSV notes name: each gets its own test. */
  noteCodes: ErrorCode[];
  /** Drop B limits, as one sentence each. */
  limits: string[];
  /** packages/testkit/src/<slug>.int.test.ts and .leak.test.ts. */
  slug: string;
}

const pascal = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

function singular(word: string): string {
  if (word === 'people') return 'person';
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

const kebab = (word: string) => word.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The roles column as trip roles, or null when it grants something else (self, anyone). */
export function tripRolesOf(roles: string): TripRole[] | null {
  const known = new Set<string>(VALUE_SETS['tribo.memberships.trip_role']);
  const granted = roles
    .split(/[;,]/)
    .map((part) => part.replace(/\(.*?\)/g, '').trim())
    .filter((part) => known.has(part)) as TripRole[];
  return granted.length > 0 ? granted : null;
}

export function storyOf(op: Operation): Story {
  if (op.slice !== '1a' || op.drop === null) {
    throw new Error(`${op.id} is slice ${op.slice}: the story kit covers slice 1a only`);
  }
  const moduleFile = MODULE_FILE[op.module];
  if (moduleFile === undefined) throw new Error(`${op.id}: no registry file for ${op.module}`);
  const segments = op.id.split('.');
  const verb = segments.at(-1) ?? '';
  const prefix = segments[0] ?? '';
  const base = singular(segments.at(-2) ?? prefix);
  const noun = pascal(base);
  const contractFile = `${kebab(base)}.ts`;
  const named = (name: string): SchemaName => ({ name, file: contractFile });
  const plain = PLAIN_VERBS.has(verb);
  const isList = op.method === 'GET' && LIST_VERBS.has(verb);
  const stem = plain ? noun : `${noun}${pascal(verb)}`;

  let input: SchemaName | null = null;
  if (op.method === 'PATCH') input = named(`${stem}Patch`);
  else if (op.method === 'POST' || op.method === 'PUT') input = named(`${stem}Input`);

  let output: SchemaName | null = null;
  if (isList) output = named(`${noun}Page`);
  else if (op.method !== 'DELETE') output = named(stem);

  const coreModule = CORE_MODULE[prefix] ?? null;
  return {
    op,
    tag: `drop-${op.drop.toLowerCase()}`,
    noun,
    isList,
    isWrite: op.method !== 'GET',
    contractFile,
    resource: named(noun),
    input,
    output,
    tripRoles: tripRolesOf(op.roles),
    coreModule,
    moduleFile,
    policyName: `can${pascal(verb)}${noun}`,
    noteCodes: ERROR_CODES.filter((code) => new RegExp(`\\b${code}\\b`).test(op.notes)),
    limits: dropLimits(op),
    slug: kebab(op.id.replaceAll('.', '-')),
  };
}
