// The write path (s0 task 7). The specs below stand in for module operations: they write
// straight to the tables so each test isolates one step of the wrapper.
import { registry, type Operation } from '@tribo/contract';
import { writePath } from '@tribo/core';
import { ApiError, type RequestContext, type Tx, type WritePath } from '@tribo/platform';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createItem, createTrip, createUser, type UserFixture } from './factories.js';

function operation<I>(id: string, input: z.ZodType<I>): Operation & { input: z.ZodType<I> } {
  const op = registry.find((o) => o.id === id);
  if (!op) throw new Error(`no operation ${id}`);
  return { ...op, input };
}

const itemsUpdate = operation('items.update', z.object({ title: z.string().min(1) }));
const boardReplace = operation('items.assignments.replace', z.object({}));
const tripsDelete = operation('trips.delete', z.object({}));

const allow = () => Promise.resolve();

describe('write path', () => {
  let tdb: TestDatabase;
  let write: WritePath;
  let owner: UserFixture;
  let ctx: RequestContext;
  let tripId: string;
  let itemId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    write = writePath(tdb.db);
  });
  afterAll(() => tdb.destroy());

  beforeEach(async () => {
    owner = await createUser(tdb.db);
    ({ tripId } = await createTrip(tdb.db, { owner }));
    const { id: membership } = await tdb.db
      .selectFrom('tribo.memberships')
      .select('id')
      .where('trip_id', '=', tripId)
      .executeTakeFirstOrThrow();
    itemId = await createItem(tdb.db, { tripId, ownerMembershipId: membership });
    ctx = { requestId: `req-${itemId}`, surface: 'web', userId: owner.userId };
  });

  /** items.update on the fixture item: locks it, renames it and bumps its version. */
  function renameItem(body: unknown, ifMatch: number | undefined, authorize = allow) {
    return write(ctx, {
      operation: itemsUpdate,
      target: { itemId },
      body,
      ifMatch,
      authorize,
      load: async (tx: Tx, target) => {
        const row = await tx
          .selectFrom('tribo.items')
          .select(['trip_id', 'version'])
          .where('id', '=', target.itemId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        return { tripId: row.trip_id, counter: row.version };
      },
      mutate: async (tx, c, loaded, input) => {
        const row = await tx
          .updateTable('tribo.items')
          .set({ title: input.title, version: loaded.counter + 1, updated_by: c.userId })
          .where('id', '=', itemId)
          .returning(['id', 'title', 'version'])
          .executeTakeFirstOrThrow();
        return {
          action: 'update',
          aggregate: 'item',
          entityId: row.id,
          tripId: loaded.tripId,
          version: row.version,
          snapshot: { title: row.title },
          result: row,
        };
      },
    });
  }

  const itemTitle = async () =>
    (
      await tdb.db
        .selectFrom('tribo.items')
        .select('title')
        .where('id', '=', itemId)
        .executeTakeFirstOrThrow()
    ).title;

  const snapshots = (entityId: string) =>
    tdb.db
      .selectFrom('tribo.entity_versions')
      .selectAll()
      .where('entity_id', '=', entityId)
      .execute();

  const events = (entityId: string) =>
    tdb.db
      .selectFrom('audit.audit_events')
      .selectAll()
      .where('entity_id', '=', entityId)
      .orderBy('seq')
      .execute();

  const archive = (retired = false) =>
    tdb.db
      .updateTable('tribo.trips')
      .set({
        status: 'completed',
        archived_at: new Date(),
        audit_retired_at: retired ? new Date() : null,
      })
      .where('id', '=', tripId)
      .execute();

  it('commits the change, its snapshot and an audit event in the trip chain', async () => {
    const result = await renameItem({ title: 'Island hopping' }, 1);

    expect(result).toMatchObject({ title: 'Island hopping', version: 2 });
    expect(await snapshots(itemId)).toMatchObject([
      { entity_type: 'item', version: 2, trip_id: tripId, snapshot: { title: 'Island hopping' } },
    ]);
    const [event] = await events(itemId);
    expect(event).toMatchObject({
      chain_key: `trip:${tripId}`,
      action: 'update',
      entity_type: 'item',
      trip_id: tripId,
      actor_user_id: owner.userId,
      surface: 'web',
      request_id: ctx.requestId,
      version_before: 1,
      version_after: 2,
    });
    const { rows } = await sql<{ broken: string | null }>`
      SELECT audit.verify_chain(${`trip:${tripId}`}) AS broken`.execute(tdb.db);
    expect(rows[0]?.broken).toBeNull();
  });

  it('authorizes before it validates the body', async () => {
    const deny = () => Promise.reject(new ApiError('forbidden'));
    await expect(renameItem({ title: '' }, 1, deny)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects an invalid body with field errors and writes nothing', async () => {
    await expect(renameItem({ title: '' }, 1)).rejects.toMatchObject({
      code: 'validation_failed',
      extra: { errors: [{ path: '/title' }] },
    });
    expect(await snapshots(itemId)).toEqual([]);
  });

  it('requires If-Match on the counter the operation names', async () => {
    await expect(renameItem({ title: 'x' }, undefined)).rejects.toMatchObject({
      code: 'if_match_required',
    });
  });

  it('refuses a stale If-Match and leaves the row as it was', async () => {
    await renameItem({ title: 'first' }, 1);
    await expect(renameItem({ title: 'second' }, 1)).rejects.toMatchObject({
      code: 'version_conflict',
    });
    expect(await itemTitle()).toBe('first');
    expect(await events(itemId)).toHaveLength(1);
  });

  it("compares a board save with the item's board_version, not its version", async () => {
    await renameItem({ title: 'renamed' }, 1); // item version 2, board_version still 1
    const saveBoard = (ifMatch: number) =>
      write(ctx, {
        operation: boardReplace,
        target: { itemId },
        body: {},
        ifMatch,
        authorize: allow,
        load: async (tx) => {
          const row = await tx
            .selectFrom('tribo.items')
            .select(['trip_id', 'board_version'])
            .where('id', '=', itemId)
            .forUpdate()
            .executeTakeFirstOrThrow();
          return { tripId: row.trip_id, counter: row.board_version };
        },
        mutate: async (tx, _c, loaded) => {
          await tx
            .updateTable('tribo.items')
            .set({ board_version: loaded.counter + 1 })
            .where('id', '=', itemId)
            .execute();
          return {
            action: 'update',
            aggregate: 'item_board',
            entityId: itemId,
            tripId: loaded.tripId,
            version: loaded.counter + 1,
            snapshot: { allocations: [] },
            result: null,
          };
        },
      });

    await expect(saveBoard(2)).rejects.toMatchObject({ code: 'version_conflict' });
    await saveBoard(1);
    expect((await snapshots(itemId)).map((s) => [s.entity_type, s.version])).toEqual([
      ['item', 2],
      ['item_board', 2],
    ]);
  });

  it('refuses every write under an archived trip with trip_archived', async () => {
    await archive();
    await expect(renameItem({ title: 'late edit' }, 1)).rejects.toMatchObject({
      code: 'trip_archived',
    });
    expect(await events(itemId)).toEqual([]);
  });

  it('refuses writes under a deleted trip as not_found', async () => {
    await tdb.db
      .updateTable('tribo.trips')
      .set({ deleted_at: new Date() })
      .where('id', '=', tripId)
      .execute();
    await expect(renameItem({ title: 'x' }, 1)).rejects.toMatchObject({ code: 'not_found' });
  });

  /** trips.delete, which R29 still allows on an archived trip. */
  const deleteTrip = () =>
    write(ctx, {
      operation: tripsDelete,
      target: { tripId },
      body: {},
      ifMatch: 1,
      authorize: allow,
      load: async (tx, target) => {
        const row = await tx
          .selectFrom('tribo.trips')
          .select('version')
          .where('id', '=', target.tripId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        return { tripId: target.tripId, counter: row.version };
      },
      mutate: async (tx, c, loaded) => {
        await tx
          .updateTable('tribo.trips')
          .set({ deleted_at: new Date(), deleted_by: c.userId, version: loaded.counter + 1 })
          .where('id', '=', tripId)
          .execute();
        return {
          action: 'delete',
          aggregate: 'trip',
          entityId: tripId,
          tripId,
          version: loaded.counter + 1,
          snapshot: { deleted: true },
          result: null,
        };
      },
    });

  const tripDeletedAt = async () =>
    (
      await tdb.db
        .selectFrom('tribo.trips')
        .select('deleted_at')
        .where('id', '=', tripId)
        .executeTakeFirstOrThrow()
    ).deleted_at;

  it('lets trips.delete through on an archived trip', async () => {
    await archive();
    await deleteTrip();
    expect(await tripDeletedAt()).not.toBeNull();
  });

  it('rolls the change and its snapshot back when the audit insert fails', async () => {
    // A retired chain makes audit.chain_event refuse the trip's next event.
    await archive(true);
    await expect(deleteTrip()).rejects.toMatchObject({ code: 'trip_retired' });
    expect(await tripDeletedAt()).toBeNull();
    expect(await snapshots(tripId)).toEqual([]);
  });
});
