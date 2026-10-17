// Leak-test harness: fast-check generates small worlds of users, placeholders, trips,
// memberships (some soft-deleted) and items (shared, private or selected, some deleted);
// a TypeScript oracle states who may see what; the property checks that the database's
// tribo.item_visible and tribo.person_visible agree with it for every pair in the world.
import type { DB } from '@tribo/db';
import fc from 'fast-check';
import { sql, type Kysely } from 'kysely';
import {
  addMember,
  createItem,
  createPlaceholder,
  createTrip,
  createUser,
  softDelete,
  type TripRole,
  type Visibility,
} from './factories.js';

// ---------------------------------------------------------------------------
// World shape (indices) and its generator
// ---------------------------------------------------------------------------

export interface WorldSpec {
  /** One entry per account; person index i belongs to user i. */
  users: { personDeleted: boolean }[];
  /** Person index users.length + j. */
  placeholders: { createdBy: number; deleted: boolean }[];
  trips: {
    owner: number;
    deleted: boolean;
    /** members[0] is the owner's membership. */
    members: { person: number; role: TripRole; deleted: boolean }[];
    items: { owner: number; visibility: Visibility; shares: number[]; deleted: boolean }[];
  }[];
}

/** Mostly false, sometimes true: soft deletes should appear, but not dominate. */
const sometimes = fc.oneof(
  { weight: 3, arbitrary: fc.constant(false) },
  { weight: 1, arbitrary: fc.constant(true) },
);

function tripArb(nUsers: number, nPersons: number) {
  return fc
    .record({
      owner: fc.nat({ max: nUsers - 1 }),
      deleted: sometimes,
      others: fc.uniqueArray(
        fc.record({
          person: fc.nat({ max: nPersons - 1 }),
          role: fc.constantFrom<TripRole>('organizer', 'member', 'viewer'),
          deleted: sometimes,
        }),
        { selector: (m) => m.person, maxLength: 5 },
      ),
    })
    .chain((t) => {
      const members = [
        { person: t.owner, role: 'owner' as TripRole, deleted: false },
        ...t.others.filter((m) => m.person !== t.owner),
      ];
      const item = fc.record({
        owner: fc.nat({ max: members.length - 1 }),
        visibility: fc.constantFrom<Visibility>('shared', 'private', 'selected'),
        // Shares on shared or private items too: the predicate must ignore them there.
        shares: fc.uniqueArray(fc.nat({ max: members.length - 1 }), { maxLength: members.length }),
        deleted: sometimes,
      });
      return fc
        .array(item, { maxLength: 6 })
        .map((items) => ({ owner: t.owner, deleted: t.deleted, members, items }));
    });
}

export const worldArb: fc.Arbitrary<WorldSpec> = fc.integer({ min: 2, max: 4 }).chain((nUsers) =>
  fc
    .record({
      users: fc.array(fc.record({ personDeleted: sometimes }), {
        minLength: nUsers,
        maxLength: nUsers,
      }),
      placeholders: fc.array(
        fc.record({ createdBy: fc.nat({ max: nUsers - 1 }), deleted: sometimes }),
        { maxLength: 3 },
      ),
    })
    .chain((base) =>
      fc
        .array(tripArb(nUsers, nUsers + base.placeholders.length), { minLength: 1, maxLength: 3 })
        .map((trips) => ({ ...base, trips })),
    ),
);

// ---------------------------------------------------------------------------
// The world as stored, and the oracle over it
// ---------------------------------------------------------------------------

export interface BuiltWorld {
  userIds: string[];
  persons: { id: string; userId: string | null; createdBy: string; deleted: boolean }[];
  trips: {
    id: string;
    deleted: boolean;
    members: { id: string; personId: string; deleted: boolean }[];
    items: {
      id: string;
      ownerMembershipId: string;
      visibility: Visibility;
      shares: string[];
      deleted: boolean;
    }[];
  }[];
}

export interface Oracle {
  itemVisible(world: BuiltWorld, userId: string, itemId: string): boolean;
  personVisible(world: BuiltWorld, userId: string, personId: string): boolean;
}

const personOf = (w: BuiltWorld, userId: string) => w.persons.find((p) => p.userId === userId);

/** The visibility rules, written independently of the SQL (0001_init.sql, R18/R19). */
export const oracle: Oracle = {
  itemVisible(w, userId, itemId) {
    const me = personOf(w, userId);
    for (const trip of w.trips) {
      const item = trip.items.find((i) => i.id === itemId);
      if (!item) continue;
      if (item.deleted || trip.deleted || !me) return false;
      // The caller's active membership in the item's trip.
      const mine = trip.members.find((m) => m.personId === me.id && !m.deleted);
      if (!mine) return false;
      return (
        item.visibility === 'shared' ||
        item.ownerMembershipId === mine.id ||
        (item.visibility === 'selected' && item.shares.includes(mine.id))
      );
    }
    return false;
  },

  personVisible(w, userId, personId) {
    const person = w.persons.find((p) => p.id === personId);
    if (!person || person.deleted) return false;
    if (person.userId === userId) return true;
    if (person.userId === null && person.createdBy === userId) return true;
    const me = personOf(w, userId);
    if (!me) return false;
    return w.trips.some(
      (t) =>
        !t.deleted &&
        t.members.some((m) => m.personId === personId && !m.deleted) &&
        t.members.some((m) => m.personId === me.id && !m.deleted),
    );
  },
};

// ---------------------------------------------------------------------------
// Building a world in the database and checking it
// ---------------------------------------------------------------------------

export async function buildWorld(db: Kysely<DB>, spec: WorldSpec): Promise<BuiltWorld> {
  const users = [];
  for (const _ of spec.users) users.push(await createUser(db));
  const persons: BuiltWorld['persons'] = users.map((u, i) => ({
    id: u.personId,
    userId: u.userId,
    createdBy: u.userId,
    deleted: spec.users[i]?.personDeleted ?? false,
  }));
  for (const p of spec.placeholders) {
    const createdBy = users[p.createdBy]?.userId ?? '';
    persons.push({
      id: await createPlaceholder(db, { createdBy }),
      userId: null,
      createdBy,
      deleted: p.deleted,
    });
  }

  const trips: BuiltWorld['trips'] = [];
  for (const t of spec.trips) {
    const owner = users[t.owner];
    if (!owner) throw new Error('bad owner index');
    const { tripId, ownerMembershipId } = await createTrip(db, { owner });
    const members: BuiltWorld['trips'][number]['members'] = [];
    for (const [index, m] of t.members.entries()) {
      const personId = persons[m.person]?.id ?? '';
      const id =
        index === 0
          ? ownerMembershipId
          : await addMember(db, { tripId, personId, role: m.role, createdBy: owner.userId });
      members.push({ id, personId, deleted: m.deleted });
    }
    const items: BuiltWorld['trips'][number]['items'] = [];
    for (const it of t.items) {
      const ownerMembershipId = members[it.owner]?.id ?? '';
      const shares = it.shares.map((s) => members[s]?.id ?? '');
      const id = await createItem(db, {
        tripId,
        ownerMembershipId,
        visibility: it.visibility,
        sharedWith: shares,
      });
      items.push({ id, ownerMembershipId, visibility: it.visibility, shares, deleted: it.deleted });
    }
    trips.push({ id: tripId, deleted: t.deleted, members, items });
  }

  // Deletes last, so every insert above saw live parents.
  for (const p of persons) if (p.deleted) await softDelete(db, 'tribo.persons', p.id);
  for (const t of trips) {
    for (const m of t.members) if (m.deleted) await softDelete(db, 'tribo.memberships', m.id);
    for (const i of t.items) if (i.deleted) await softDelete(db, 'tribo.items', i.id);
    if (t.deleted) await softDelete(db, 'tribo.trips', t.id);
  }
  return { userIds: users.map((u) => u.userId), persons, trips };
}

export interface Mismatch {
  fn: 'item_visible' | 'person_visible';
  userId: string;
  targetId: string;
  database: boolean;
  oracle: boolean;
}

/** Every (user, item) and (user, person) pair where the database and the oracle disagree. */
export async function findMismatches(
  db: Kysely<DB>,
  world: BuiltWorld,
  rules: Oracle,
): Promise<Mismatch[]> {
  const itemIds = world.trips.flatMap((t) => t.items.map((i) => i.id));
  const personIds = world.persons.map((p) => p.id);
  const items = await sql<{ uid: string; tid: string; v: boolean }>`
    SELECT u.id AS uid, i.id AS tid, tribo.item_visible(u.id, i.id) AS v
      FROM unnest(${world.userIds}::uuid[]) AS u(id)
     CROSS JOIN unnest(${itemIds}::uuid[]) AS i(id)`.execute(db);
  const people = await sql<{ uid: string; tid: string; v: boolean }>`
    SELECT u.id AS uid, p.id AS tid, tribo.person_visible(u.id, p.id) AS v
      FROM unnest(${world.userIds}::uuid[]) AS u(id)
     CROSS JOIN unnest(${personIds}::uuid[]) AS p(id)`.execute(db);

  const out: Mismatch[] = [];
  for (const r of items.rows) {
    const expected = rules.itemVisible(world, r.uid, r.tid);
    if (expected !== r.v)
      out.push({
        fn: 'item_visible',
        userId: r.uid,
        targetId: r.tid,
        database: r.v,
        oracle: expected,
      });
  }
  for (const r of people.rows) {
    const expected = rules.personVisible(world, r.uid, r.tid);
    if (expected !== r.v)
      out.push({
        fn: 'person_visible',
        userId: r.uid,
        targetId: r.tid,
        database: r.v,
        oracle: expected,
      });
  }
  return out;
}

class Rollback extends Error {}

/**
 * The property: build the world inside a transaction, compare, roll back. One database
 * serves every run, and the visibility functions (STABLE SQL) see the uncommitted rows.
 */
export function visibilityProperty(db: Kysely<DB>, rules: Oracle = oracle) {
  return fc.asyncProperty(worldArb, async (spec) => {
    let mismatches: Mismatch[] = [];
    try {
      await db.transaction().execute(async (trx) => {
        const world = await buildWorld(trx, spec);
        mismatches = await findMismatches(trx, world, rules);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    if (mismatches.length > 0) {
      throw new Error(`visibility leak or over-hiding: ${JSON.stringify(mismatches.slice(0, 5))}`);
    }
  });
}

/** Fixed seed by default so CI is reproducible; the nightly job sets a random one. */
export function leakRunOptions(env: NodeJS.ProcessEnv = process.env): {
  seed: number;
  numRuns: number;
} {
  return {
    seed: Number(env.TRIBO_LEAK_SEED ?? 20261017),
    numRuns: Number(env.TRIBO_LEAK_RUNS ?? 200),
  };
}
