// Leak-test harness: fast-check generates small worlds of users, placeholders, trips,
// memberships (some soft-deleted, some viewers granted costs), items (shared, private or
// selected, some deleted, some priced, some with restricted fields), their units (rooms,
// some priced, some deleted) and board rows, and invite links (some revoked or expired);
// a TypeScript oracle states who may see what;
// the property checks that the database's tribo.item_visible and tribo.person_visible agree
// with it for every pair in the world, that each list operation registered here returns each
// account exactly what the oracle allows, and that each item read registered here shows a
// restricted field only to a caller the oracle lets read it.
import { VALUE_SETS, type DB, type ValueOf } from '@tribo/db';
import fc from 'fast-check';
import { sql, type Kysely } from 'kysely';
import {
  addAllocation,
  addMember,
  createInvite,
  createItem,
  createPlaceholder,
  createTrip,
  createUnit,
  createUser,
  softDelete,
  type TripRole,
  type Visibility,
} from './factories.js';

// ---------------------------------------------------------------------------
// World shape (indices) and its generator
// ---------------------------------------------------------------------------

type MaskedField = ValueOf<'tribo.items.restricted_fields'>;

export interface WorldSpec {
  /** One entry per account; person index i belongs to user i. */
  users: { personDeleted: boolean }[];
  /** Person index users.length + j. */
  placeholders: { createdBy: number; deleted: boolean }[];
  trips: {
    owner: number;
    deleted: boolean;
    /** members[0] is the owner's membership. */
    members: { person: number; role: TripRole; deleted: boolean; canViewCosts: boolean }[];
    items: {
      owner: number;
      visibility: Visibility;
      shares: number[];
      deleted: boolean;
      priced: boolean;
      restricted: MaskedField[];
      units: { priced: boolean; deleted: boolean }[];
      /** Board rows by member index; units are left out, since visibility never asks. */
      allocations: { member: number; role: 'attendee' | 'assignee' }[];
    }[];
    /** Invite links the owner made: open ones, revoked ones and expired ones. */
    invites: { revoked: boolean; expired: boolean }[];
  }[];
}

/** Mostly false, sometimes true: soft deletes should appear, but not dominate. */
const sometimes = fc.oneof(
  { weight: 3, arbitrary: fc.constant(false) },
  { weight: 1, arbitrary: fc.constant(true) },
);

const nonOwnerRoles = VALUE_SETS['tribo.memberships.trip_role'].filter(
  (r): r is Exclude<TripRole, 'owner'> => r !== 'owner',
);

function tripArb(nUsers: number, nPersons: number) {
  return fc
    .record({
      owner: fc.nat({ max: nUsers - 1 }),
      deleted: sometimes,
      others: fc.uniqueArray(
        fc.record({
          person: fc.nat({ max: nPersons - 1 }),
          role: fc.constantFrom(...nonOwnerRoles),
          deleted: sometimes,
          // Only a viewer's grant means anything (decision 0007); the generator sets it on others too.
          canViewCosts: fc.boolean(),
        }),
        { selector: (m) => m.person, maxLength: 5 },
      ),
    })
    .chain((t) => {
      const members = [
        { person: t.owner, role: 'owner' as TripRole, deleted: false, canViewCosts: false },
        ...t.others
          .filter((m) => m.person !== t.owner)
          .map((m) => ({ ...m, canViewCosts: m.role === 'viewer' && m.canViewCosts })),
      ];
      const item = fc.record({
        owner: fc.nat({ max: members.length - 1 }),
        visibility: fc.constantFrom(...VALUE_SETS['tribo.items.visibility']),
        // Shares on shared or private items too: the predicate must ignore them there.
        shares: fc.uniqueArray(fc.nat({ max: members.length - 1 }), { maxLength: members.length }),
        deleted: sometimes,
        priced: fc.boolean(),
        restricted: fc.subarray([...VALUE_SETS['tribo.items.restricted_fields']]),
        units: fc.array(fc.record({ priced: fc.boolean(), deleted: sometimes }), { maxLength: 2 }),
        allocations: fc.uniqueArray(
          fc.record({
            member: fc.nat({ max: members.length - 1 }),
            role: fc.constantFrom('attendee' as const, 'assignee' as const),
          }),
          { selector: (a) => `${String(a.member)}:${a.role}`, maxLength: 3 },
        ),
      });
      const invite = fc.record({ revoked: sometimes, expired: sometimes });
      return fc
        .tuple(fc.array(item, { maxLength: 6 }), fc.array(invite, { maxLength: 2 }))
        .map(([items, invites]) => ({
          owner: t.owner,
          deleted: t.deleted,
          members,
          items,
          invites,
        }));
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
    members: {
      id: string;
      personId: string;
      role: TripRole;
      deleted: boolean;
      canViewCosts: boolean;
    }[];
    items: {
      id: string;
      ownerMembershipId: string;
      visibility: Visibility;
      shares: string[];
      deleted: boolean;
      restrictedFields: MaskedField[];
      units: { id: string; priced: boolean; deleted: boolean }[];
      allocations: { membershipId: string; role: 'attendee' | 'assignee' }[];
    }[];
    invites: { id: string }[];
  }[];
}

export interface Oracle {
  itemVisible(world: BuiltWorld, userId: string, itemId: string): boolean;
  personVisible(world: BuiltWorld, userId: string, personId: string): boolean;
  /** A trip is the caller's while they hold an active membership in it and it is not deleted. */
  tripVisible(world: BuiltWorld, userId: string, tripId: string): boolean;
  /** A membership shows to the caller while it is active and its trip is the caller's. */
  memberVisible(world: BuiltWorld, userId: string, membershipId: string): boolean;
  /**
   * An invite link shows, revoked, expired or not, only to the owner of its trip while the
   * trip is not deleted: nobody else lists a trip's invites.
   */
  inviteVisible(world: BuiltWorld, userId: string, inviteId: string): boolean;
  /**
   * Whether a caller who sees the item may read one of its maskable fields as far as its
   * restrictedFields go: an unrestricted field always, a restricted one only as the item's
   * owner or the trip's owner or an organizer.
   */
  fieldReadable(world: BuiltWorld, userId: string, itemId: string, field: MaskedField): boolean;
  /** A unit shows while it is live and its item shows (children follow their item). */
  unitVisible(world: BuiltWorld, userId: string, unitId: string): boolean;
  /**
   * Whether a caller who sees the item reads its money (its cost, its units' rates): every
   * role but a viewer, a viewer only with a cost grant, and never past a restricted cost.
   */
  moneyReadable(world: BuiltWorld, userId: string, itemId: string): boolean;
}

const personOf = (w: BuiltWorld, userId: string) => w.persons.find((p) => p.userId === userId);

/** The visibility rules, written independently of the SQL (0001_init.sql, R18/R19). */
export const oracle: Oracle = {
  itemVisible(w, userId, itemId) {
    const me = personOf(w, userId);
    for (const trip of w.trips) {
      const item = trip.items.find((i) => i.id === itemId);
      if (item) {
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

  fieldReadable(w, userId, itemId, field) {
    const me = personOf(w, userId);
    const trip = w.trips.find((t) => t.items.some((i) => i.id === itemId));
    const item = trip?.items.find((i) => i.id === itemId);
    if (!trip || !item || !me) return false;
    if (!item.restrictedFields.includes(field)) return true;
    const mine = trip.members.find((m) => m.personId === me.id && !m.deleted);
    if (!mine) return false;
    return item.ownerMembershipId === mine.id || mine.role === 'owner' || mine.role === 'organizer';
  },

  unitVisible(w, userId, unitId) {
    for (const trip of w.trips) {
      const item = trip.items.find((i) => i.units.some((u) => u.id === unitId));
      const unit = item?.units.find((u) => u.id === unitId);
      if (item && unit) return !unit.deleted && oracle.itemVisible(w, userId, item.id);
    }
    return false;
  },

  moneyReadable(w, userId, itemId) {
    const me = personOf(w, userId);
    const trip = w.trips.find((t) => t.items.some((i) => i.id === itemId));
    const mine = trip?.members.find((m) => m.personId === me?.id && !m.deleted);
    if (!mine) return false;
    if (mine.role === 'viewer' && !mine.canViewCosts) return false;
    return oracle.fieldReadable(w, userId, itemId, 'cost');
  },

  tripVisible(w, userId, tripId) {
    const trip = w.trips.find((t) => t.id === tripId);
    const me = personOf(w, userId);
    if (!trip || trip.deleted || !me) return false;
    return trip.members.some((m) => m.personId === me.id && !m.deleted);
  },

  memberVisible(w, userId, membershipId) {
    const trip = w.trips.find((t) => t.members.some((m) => m.id === membershipId));
    const member = trip?.members.find((m) => m.id === membershipId);
    if (!trip || !member || member.deleted) return false;
    return oracle.tripVisible(w, userId, trip.id);
  },

  inviteVisible(w, userId, inviteId) {
    const trip = w.trips.find((t) => t.invites.some((i) => i.id === inviteId));
    const me = personOf(w, userId);
    if (!trip || trip.deleted || !me) return false;
    return trip.members.some((m) => m.personId === me.id && !m.deleted && m.role === 'owner');
  },
};

// ---------------------------------------------------------------------------
// Building a world in the database and checking it
// ---------------------------------------------------------------------------

/* eslint-disable no-await-in-loop -- rows go in one by one, each after the parents it references */
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
          : await addMember(db, {
              tripId,
              personId,
              role: m.role,
              createdBy: owner.userId,
              canViewCosts: m.canViewCosts,
            });
      members.push({
        id,
        personId,
        role: m.role,
        deleted: m.deleted,
        canViewCosts: m.canViewCosts,
      });
    }
    const items: BuiltWorld['trips'][number]['items'] = [];
    for (const it of t.items) {
      const itemOwnerId = members[it.owner]?.id ?? '';
      const shares = it.shares.map((s) => members[s]?.id ?? '');
      const id = await createItem(db, {
        tripId,
        ownerMembershipId: itemOwnerId,
        visibility: it.visibility,
        sharedWith: shares,
        ...(it.priced ? { cost: { amountMinor: 4_200, currency: 'EUR' } } : {}),
        restrictedFields: it.restricted,
      });
      const units = [];
      for (const u of it.units) {
        const unitId = await createUnit(db, {
          itemId: id,
          ...(u.priced ? { rate: { amountMinor: 150_000, currency: 'PHP' } } : {}),
        });
        units.push({ id: unitId, priced: u.priced, deleted: u.deleted });
      }
      const allocations = [];
      for (const a of it.allocations) {
        const membershipId = members[a.member]?.id ?? '';
        await addAllocation(db, { tripId, itemId: id, membershipId, role: a.role });
        allocations.push({ membershipId, role: a.role });
      }
      items.push({
        id,
        ownerMembershipId: itemOwnerId,
        visibility: it.visibility,
        shares,
        deleted: it.deleted,
        restrictedFields: it.restricted,
        units,
        allocations,
      });
    }
    const invites = [];
    for (const inv of t.invites) {
      invites.push({
        id: await createInvite(db, {
          tripId,
          createdBy: owner.userId,
          revoked: inv.revoked,
          expired: inv.expired,
        }),
      });
    }
    trips.push({ id: tripId, deleted: t.deleted, members, items, invites });
  }

  // Deletes last, so every insert above saw live parents.
  for (const p of persons) if (p.deleted) await softDelete(db, 'tribo.persons', p.id);
  for (const t of trips) {
    for (const m of t.members) if (m.deleted) await softDelete(db, 'tribo.memberships', m.id);
    for (const i of t.items) {
      for (const u of i.units) if (u.deleted) await softDelete(db, 'tribo.units', u.id);
      if (i.deleted) await softDelete(db, 'tribo.items', i.id);
    }
    if (t.deleted) await softDelete(db, 'tribo.trips', t.id);
  }
  return { userIds: users.map((u) => u.userId), persons, trips };
}
/* eslint-enable no-await-in-loop */

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
 * Builds the world inside a transaction, checks it, rolls back. One database serves every
 * run, and the visibility functions (STABLE SQL) see the uncommitted rows.
 */
async function inWorld<T>(
  db: Kysely<DB>,
  spec: WorldSpec,
  check: (trx: Kysely<DB>, world: BuiltWorld) => Promise<T>,
): Promise<T> {
  let result: { value: T } | undefined;
  try {
    await db.transaction().execute(async (trx) => {
      result = { value: await check(trx, await buildWorld(trx, spec)) };
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (!result) throw new Error('world check did not run');
  return result.value;
}

/** The property: the database's visibility predicates agree with the oracle for every pair. */
export function visibilityProperty(db: Kysely<DB>, rules: Oracle = oracle) {
  return fc.asyncProperty(worldArb, async (spec) => {
    const mismatches = await inWorld(db, spec, (trx, world) => findMismatches(trx, world, rules));
    if (mismatches.length > 0) {
      throw new Error(`visibility leak or over-hiding: ${JSON.stringify(mismatches.slice(0, 5))}`);
    }
  });
}

/** A list read as the leak harness drives it: every id it returns to this account. */
export type ListRead = (db: Kysely<DB>, userId: string) => Promise<string[]>;

/**
 * The property for a list operation: for every account in the world, the ids the read
 * returns are exactly those `visible` allows among `candidates`, no more and no fewer.
 */
export function listProperty(
  db: Kysely<DB>,
  read: ListRead,
  candidates: (world: BuiltWorld) => string[],
  visible: (world: BuiltWorld, userId: string, id: string) => boolean,
) {
  return fc.asyncProperty(worldArb, async (spec) => {
    const mismatches = await inWorld(db, spec, async (trx, world) => {
      const out: { userId: string; listed: string[]; expected: string[] }[] = [];
      for (const userId of world.userIds) {
        // eslint-disable-next-line no-await-in-loop -- one transaction, so one query at a time
        const listed = (await read(trx, userId)).sort();
        const expected = candidates(world)
          .filter((id) => visible(world, userId, id))
          .sort();
        if (JSON.stringify(listed) !== JSON.stringify(expected)) {
          out.push({ userId, listed, expected });
        }
      }
      return out;
    });
    if (mismatches.length > 0) {
      throw new Error(`list leak or over-hiding: ${JSON.stringify(mismatches.slice(0, 5))}`);
    }
  });
}

/** An item read as the mask property drives it: per item returned, the maskable fields it showed. */
export type FieldRead = (
  db: Kysely<DB>,
  userId: string,
) => Promise<{ id: string; shown: readonly MaskedField[] }[]>;

/**
 * The property for an item read's masking: for every account in the world, each maskable
 * field the read shows (its value, or that it holds none) is one `readable` allows.
 */
export function maskProperty(
  db: Kysely<DB>,
  read: FieldRead,
  readable: (world: BuiltWorld, userId: string, itemId: string, field: MaskedField) => boolean,
) {
  return fc.asyncProperty(worldArb, async (spec) => {
    const leaks = await inWorld(db, spec, async (trx, world) => {
      const out: { userId: string; itemId: string; field: MaskedField }[] = [];
      for (const userId of world.userIds) {
        // eslint-disable-next-line no-await-in-loop -- one transaction, so one query at a time
        for (const { id, shown } of await read(trx, userId)) {
          for (const field of shown) {
            if (!readable(world, userId, id, field)) out.push({ userId, itemId: id, field });
          }
        }
      }
      return out;
    });
    if (leaks.length > 0) {
      throw new Error(`restricted field leak: ${JSON.stringify(leaks.slice(0, 5))}`);
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
