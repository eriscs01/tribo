// Test factories: write rows straight into tribo tables with sensible defaults. They skip
// the services (no audit rows, no snapshots), so use them to set up a world, never to
// test a write path.
import { createHash, randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import type { DB, ValueOf } from '@tribo/db';
import type { Kysely } from 'kysely';

type Db = Kysely<DB>;
export type TripRole = ValueOf<'tribo.memberships.trip_role'>;
export type Visibility = ValueOf<'tribo.items.visibility'>;

let counter = 0;
const next = () => {
  counter += 1;
  return counter.toString(36);
};

export interface UserFixture {
  userId: string;
  personId: string;
}

/** An account and its own person (every account has exactly one). */
export async function createUser(
  db: Db,
  init: {
    username?: string;
    displayName?: string;
    platformRole?: ValueOf<'tribo.users.platform_role'>;
    /** Hashed with Argon2id so the account can sign in; by default it has no password. */
    password?: string;
  } = {},
): Promise<UserFixture> {
  const n = next();
  const { id: userId } = await db
    .insertInto('tribo.users')
    .values({
      username: init.username ?? `user_${n}`,
      password_hash: init.password === undefined ? '!' : await hash(init.password),
      platform_role: init.platformRole ?? 'user',
      // An active admin needs MFA; tests that need one enable it themselves.
      status: init.platformRole === 'admin' ? 'disabled' : 'active',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const { id: personId } = await db
    .insertInto('tribo.persons')
    .values({ user_id: userId, display_name: init.displayName ?? `User ${n}`, created_by: userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { userId, personId };
}

/**
 * An admin's reset link for `userId`, as the admin console would issue it; returns the
 * token the link carries (the database keeps only its SHA-256).
 */
export async function createResetLink(
  db: Db,
  init: { userId: string; createdBy: string; expiresAt?: Date },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db
    .insertInto('tribo.password_reset_links')
    .values({
      user_id: init.userId,
      token_hash: createHash('sha256').update(token).digest(),
      created_by: init.createdBy,
      ...(init.expiresAt ? { expires_at: init.expiresAt } : {}),
    })
    .execute();
  return token;
}

/** A traveller without an account, created by `createdBy`. */
export async function createPlaceholder(
  db: Db,
  init: { createdBy: string; displayName?: string },
): Promise<string> {
  const { id } = await db
    .insertInto('tribo.persons')
    .values({ display_name: init.displayName ?? `Guest ${next()}`, created_by: init.createdBy })
    .returning('id')
    .executeTakeFirstOrThrow();
  return id;
}

/** A shared library place, as library.places.create would write it. */
export async function createPlace(
  db: Db,
  init: { createdBy: string; name?: string },
): Promise<string> {
  const { id } = await db
    .insertInto('tribo.places')
    .values({
      name: init.name ?? `Place ${next()}`,
      kind: 'destination',
      created_by: init.createdBy,
      updated_by: init.createdBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return id;
}

export interface TripFixture {
  tripId: string;
  ownerMembershipId: string;
}

/** A trip and its owner membership, as trips.create would write them. */
export async function createTrip(
  db: Db,
  init: { owner: UserFixture; name?: string; start?: string; end?: string },
): Promise<TripFixture> {
  const { id: tripId } = await db
    .insertInto('tribo.trips')
    .values({
      name: init.name ?? `Trip ${next()}`,
      start_date: init.start ?? '2026-11-11',
      end_date: init.end ?? '2026-11-14',
      currency: 'PHP',
      timezone: 'Asia/Manila',
      status: 'planning',
      created_by: init.owner.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const ownerMembershipId = await addMember(db, {
    tripId,
    personId: init.owner.personId,
    role: 'owner',
    createdBy: init.owner.userId,
  });
  return { tripId, ownerMembershipId };
}

export async function addMember(
  db: Db,
  init: { tripId: string; personId: string; role: TripRole; createdBy?: string },
): Promise<string> {
  const { id } = await db
    .insertInto('tribo.memberships')
    .values({
      trip_id: init.tripId,
      person_id: init.personId,
      trip_role: init.role,
      created_by: init.createdBy ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return id;
}

/** An item owned by a membership; `sharedWith` fills item_shares for `selected` items. */
export async function createItem(
  db: Db,
  init: {
    tripId: string;
    ownerMembershipId: string;
    visibility?: Visibility;
    sharedWith?: readonly string[];
    title?: string;
    type?: ValueOf<'tribo.items.type'>;
  },
): Promise<string> {
  const { id } = await db
    .insertInto('tribo.items')
    .values({
      trip_id: init.tripId,
      owner_membership_id: init.ownerMembershipId,
      visibility: init.visibility ?? 'shared',
      title: init.title ?? `Item ${next()}`,
      type: init.type ?? 'activity',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (init.sharedWith && init.sharedWith.length > 0) {
    await db
      .insertInto('tribo.item_shares')
      .values(
        init.sharedWith.map((membershipId) => ({
          item_id: id,
          trip_id: init.tripId,
          membership_id: membershipId,
        })),
      )
      .execute();
  }
  return id;
}

type SoftDeletable = 'tribo.trips' | 'tribo.memberships' | 'tribo.items' | 'tribo.persons';

/** Soft-deletes one root row (sets deleted_at), as the services' delete operations do. */
export async function softDelete(db: Db, table: SoftDeletable, id: string): Promise<void> {
  await db.updateTable(table).set({ deleted_at: new Date() }).where('id', '=', id).execute();
}
