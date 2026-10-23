// @module-tag drop-b
// overlays.delete (Drop B): Remove own overlay; trip_archived on archived trips (R29)
// Through the overlays service and the real trips, items and audit modules: that a member
// removes only their own overlay, under If-Match, and that the removal is versioned and
// recorded without the words it removed.
import type { OverlaysService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, history, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createOverlay, softDelete } from './factories.js';
import {
  overlayRows,
  overlaysService,
  overlaysWorld,
  type OverlaysWorld,
} from './overlays-world.js';

let tdb: TestDatabase;
let overlays: OverlaysService;
const as = contexts('overlays-delete');

beforeAll(async () => {
  tdb = await createTestDatabase();
  overlays = overlaysService(tdb.db);
});
afterAll(async () => {
  await tdb.destroy();
});

/** A member's overlay on the guest house, by the factory (so no audit rows yet). */
const overlayOf = (w: OverlaysWorld, who: { membershipId: string }, deleted = false) =>
  createOverlay(tdb.db, {
    tripId: w.tripId,
    itemId: w.lodging,
    membershipId: who.membershipId,
    note: 'Ask for the room by the garden',
    reminderAt: new Date('2026-11-10T01:00:00Z'),
    checklist: [{ text: 'Bring a padlock', done: false }],
    deleted,
  });

describe('overlays.delete', () => {
  it('removes the caller their overlay under If-Match, and nobody else’s', async () => {
    const w = await overlaysWorld(tdb);
    const mine = await overlayOf(w, w.member);
    const theirs = await overlayOf(w, w.other);
    await overlays.delete(as(w.member), w.lodging, undefined, 1);
    const rows = await overlayRows(tdb, w.lodging);
    expect(rows.find((r) => r.id === mine)?.deleted_at).not.toBeNull();
    expect(rows.find((r) => r.id === mine)?.version).toBe(2);
    expect(rows.find((r) => r.id === theirs)).toMatchObject({ deleted_at: null, version: 1 });
    expect(await refusal(overlays.get(w.member.userId, w.lodging))).toBe('not_found');
    expect((await overlays.get(w.other.userId, w.lodging)).version).toBe(1);
  });

  it('lets every role remove its own, a viewer’s left from before a demotion included', async () => {
    const w = await overlaysWorld(tdb);
    for (const who of [w.owner, w.organizer, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one setup and write at a time
      await overlayOf(w, who);
      // eslint-disable-next-line no-await-in-loop -- as above
      await overlays.delete(as(who), w.lodging, undefined, 1);
    }
    expect((await overlayRows(tdb, w.lodging)).every((r) => r.deleted_at !== null)).toBe(true);
  });

  it('lets a new overlay follow a removed one', async () => {
    const w = await overlaysWorld(tdb);
    await overlayOf(w, w.member);
    await overlays.delete(as(w.member), w.lodging, undefined, 1);
    const created = await overlays.put(
      as(w.member),
      w.lodging,
      { note: 'again' },
      {
        ifMatch: undefined,
        createOnly: true,
      },
    );
    expect(created.version).toBe(1);
  });

  it('answers not_found for a caller with no overlay, whoever else has one, and once removed', async () => {
    const w = await overlaysWorld(tdb);
    await overlayOf(w, w.member);
    expect(await refusal(overlays.delete(as(w.other), w.lodging, undefined, 1))).toBe('not_found');
    expect(await refusal(overlays.delete(as(w.owner), w.lodging, undefined, 1))).toBe('not_found');
    await overlays.delete(as(w.member), w.lodging, undefined, 1);
    expect(await refusal(overlays.delete(as(w.member), w.lodging, undefined, 2))).toBe('not_found');
    const gone = await overlayOf(w, w.organizer, true);
    expect(await refusal(overlays.delete(as(w.organizer), w.lodging, undefined, 1))).toBe(
      'not_found',
    );
    expect((await overlayRows(tdb, w.lodging)).find((r) => r.id === gone)?.version).toBe(1);
  });

  it('answers not_found for an item the caller cannot see, outside the trip, to a removed member and on a deleted item or trip', async () => {
    const w = await overlaysWorld(tdb);
    await createOverlay(tdb.db, {
      tripId: w.tripId,
      itemId: w.hidden,
      membershipId: w.owner.membershipId,
      note: 'Left from when it was shared',
    });
    expect(await refusal(overlays.delete(as(w.owner), w.hidden, undefined, 1))).toBe('not_found');
    expect(await refusal(overlays.delete(as(w.outsider), w.lodging, undefined, 1))).toBe(
      'not_found',
    );
    expect(
      await refusal(
        overlays.delete(as(w.owner), '0192f000-0000-7000-8000-00000000000a', undefined, 1),
      ),
    ).toBe('not_found');
    await overlayOf(w, w.other);
    await softDelete(tdb.db, 'tribo.memberships', w.other.membershipId);
    expect(await refusal(overlays.delete(as(w.other), w.lodging, undefined, 1))).toBe('not_found');
    await overlayOf(w, w.member);
    await softDelete(tdb.db, 'tribo.items', w.lodging);
    expect(await refusal(overlays.delete(as(w.member), w.lodging, undefined, 1))).toBe('not_found');

    const t = await overlaysWorld(tdb);
    await overlayOf(t, t.member);
    await softDelete(tdb.db, 'tribo.trips', t.tripId);
    expect(await refusal(overlays.delete(as(t.member), t.lodging, undefined, 1))).toBe('not_found');
  });

  it('takes no body', async () => {
    const w = await overlaysWorld(tdb);
    await overlayOf(w, w.member);
    expect(await refusal(overlays.delete(as(w.member), w.lodging, { reason: 'x' }, 1))).toBe(
      'validation_failed',
    );
    expect((await overlayRows(tdb, w.lodging))[0]?.deleted_at).toBeNull();
  });

  it('takes If-Match = version: refuses none with if_match_required, a stale one with version_conflict', async () => {
    const w = await overlaysWorld(tdb);
    await overlayOf(w, w.member);
    expect(await refusal(overlays.delete(as(w.member), w.lodging, undefined, undefined))).toBe(
      'if_match_required',
    );
    expect(await refusal(overlays.delete(as(w.member), w.lodging, undefined, 9))).toBe(
      'version_conflict',
    );
    expect((await overlayRows(tdb, w.lodging))[0]?.deleted_at).toBeNull();
  });

  it('answers trip_archived on an archived trip', async () => {
    const w = await overlaysWorld(tdb);
    await overlayOf(w, w.member);
    await archive(tdb, w.tripId);
    expect(await refusal(overlays.delete(as(w.member), w.lodging, undefined, 1))).toBe(
      'trip_archived',
    );
    expect((await overlayRows(tdb, w.lodging))[0]?.deleted_at).toBeNull();
  });

  it('records its audit event and entity_versions snapshot in the one transaction, the event without the words', async () => {
    const w = await overlaysWorld(tdb);
    const created = as(w.member);
    await overlays.put(
      created,
      w.lodging,
      { note: 'Ask for the garden room' },
      {
        ifMatch: undefined,
        createOnly: true,
      },
    );
    const [row] = await overlayRows(tdb, w.lodging);
    const id = row?.id ?? '';
    const ctx = as(w.member);
    await overlays.delete(ctx, w.lodging, undefined, 1);
    const { events, snapshots } = await history(tdb, id);
    expect(events.at(-1)).toEqual({
      chain_key: `trip:${w.tripId}`,
      action: 'delete',
      entity_type: 'overlay',
      version_before: 1,
      version_after: 2,
      request_id: ctx.requestId,
    });
    // The overlay as it was: restore (1b) copies this snapshot forward.
    expect(snapshots.at(-1)).toEqual({ ...snapshots[0], version: 2 });
    expect(
      JSON.stringify(
        await tdb.db
          .selectFrom('audit.audit_events')
          .selectAll()
          .where('entity_id', '=', id)
          .execute(),
      ),
    ).not.toMatch(/garden/);
  });
});
