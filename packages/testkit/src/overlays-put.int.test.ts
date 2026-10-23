// @module-tag drop-b
// overlays.put (Drop B): Create or replace own overlay; reminderAt feeds due-soon; If-Match when one exists, If-None-Match: * to create (G3); trip_archived on archived trips (R29)
// Through the overlays service and the real trips, items and audit modules: who may keep an
// overlay and on which items, the preconditions that create it or replace it, that it is the
// caller's alone, and that each write is versioned and recorded without its words.
import type { OverlaysService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, history, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createOverlay, softDelete } from './factories.js';
import { overlayRows, overlaysService, overlaysWorld } from './overlays-world.js';

let tdb: TestDatabase;
let overlays: OverlaysService;
const as = contexts('overlays-put');

beforeAll(async () => {
  tdb = await createTestDatabase();
  overlays = overlaysService(tdb.db);
});
afterAll(async () => {
  await tdb.destroy();
});

const CREATE = { ifMatch: undefined, createOnly: true } as const;
const replace = (version: number) => ({ ifMatch: version, createOnly: false });

const body = (overrides: Record<string, unknown> = {}) => ({
  note: 'Ask for the room by the garden',
  reminderAt: '2026-11-10T01:00:00.000Z',
  checklist: [
    { text: 'Print the booking', done: true },
    { text: 'Bring a padlock', done: false },
  ],
  ...overrides,
});

describe('overlays.put', () => {
  it('creates the caller their overlay under If-None-Match: *, and answers it', async () => {
    const w = await overlaysWorld(tdb);
    const created = await overlays.put(as(w.member), w.lodging, body(), CREATE);
    expect(created).toEqual({
      itemId: w.lodging,
      tripId: w.tripId,
      note: 'Ask for the room by the garden',
      reminderAt: new Date('2026-11-10T01:00:00Z'),
      checklist: [
        { text: 'Print the booking', done: true },
        { text: 'Bring a padlock', done: false },
      ],
      version: 1,
      createdAt: expect.any(Date) as Date,
      updatedAt: expect.any(Date) as Date,
    });
    expect(await overlays.get(w.member.userId, w.lodging)).toEqual(created);
    const rows = await overlayRows(tdb, w.lodging);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ membership_id: w.member.membershipId, trip_id: w.tripId });
  });

  it('lets the owner, an organizer and a member keep one; refuses a viewer', async () => {
    const w = await overlaysWorld(tdb);
    for (const who of [w.owner, w.organizer, w.member]) {
      // eslint-disable-next-line no-await-in-loop -- one write at a time
      await overlays.put(as(who), w.lodging, body(), CREATE);
    }
    expect(await refusal(overlays.put(as(w.viewer), w.lodging, body(), CREATE))).toBe('forbidden');
    expect(await overlayRows(tdb, w.lodging)).toHaveLength(3);
  });

  it('keeps one overlay per member: another member writing theirs never touches it', async () => {
    const w = await overlaysWorld(tdb);
    await overlays.put(as(w.member), w.lodging, body({ note: 'mine' }), CREATE);
    await overlays.put(as(w.other), w.lodging, body({ note: 'theirs' }), CREATE);
    expect((await overlays.get(w.member.userId, w.lodging)).note).toBe('mine');
    expect((await overlays.get(w.other.userId, w.lodging)).note).toBe('theirs');
    await overlays.put(as(w.other), w.lodging, body({ note: 'theirs, again' }), replace(1));
    expect((await overlays.get(w.member.userId, w.lodging)).version).toBe(1);
  });

  it('replaces under If-Match = version, the whole overlay: a field left out is emptied', async () => {
    const w = await overlaysWorld(tdb);
    await overlays.put(as(w.member), w.lodging, body(), CREATE);
    const replaced = await overlays.put(as(w.member), w.lodging, { note: 'Just this' }, replace(1));
    expect(replaced).toMatchObject({
      note: 'Just this',
      reminderAt: null,
      checklist: [],
      version: 2,
    });
    expect((await overlays.get(w.member.userId, w.lodging)).version).toBe(2);
    const cleared = await overlays.put(as(w.member), w.lodging, {}, replace(2));
    expect(cleared).toMatchObject({ note: null, reminderAt: null, checklist: [], version: 3 });
  });

  it('refuses a create when an overlay exists and a replace that sends no If-Match or a stale one', async () => {
    const w = await overlaysWorld(tdb);
    await overlays.put(as(w.member), w.lodging, body(), CREATE);
    // If-None-Match: * on an overlay that exists.
    expect(await refusal(overlays.put(as(w.member), w.lodging, body(), CREATE))).toBe(
      'version_conflict',
    );
    // Neither header.
    expect(
      await refusal(
        overlays.put(as(w.member), w.lodging, body(), { ifMatch: undefined, createOnly: false }),
      ),
    ).toBe('if_match_required');
    expect(await refusal(overlays.put(as(w.member), w.lodging, body(), replace(7)))).toBe(
      'version_conflict',
    );
    expect(await refusal(overlays.put(as(w.member), w.lodging, body(), replace(Number.NaN)))).toBe(
      'version_conflict',
    );
    expect((await overlays.get(w.member.userId, w.lodging)).version).toBe(1);
  });

  it('refuses a replace when there is no overlay, and a write that names neither precondition', async () => {
    const w = await overlaysWorld(tdb);
    expect(await refusal(overlays.put(as(w.member), w.lodging, body(), replace(1)))).toBe(
      'version_conflict',
    );
    expect(
      await refusal(
        overlays.put(as(w.member), w.lodging, body(), { ifMatch: undefined, createOnly: false }),
      ),
    ).toBe('if_match_required');
    expect(await overlayRows(tdb, w.lodging)).toHaveLength(0);
  });

  it('lets one of two concurrent creates, or two replaces of one version, win; the other is version_conflict', async () => {
    const w = await overlaysWorld(tdb);
    const race = (precondition: Parameters<OverlaysService['put']>[3]) =>
      Promise.allSettled(
        ['one', 'two'].map((note) =>
          overlays.put(as(w.member), w.lodging, body({ note }), precondition),
        ),
      );
    const created = await race(CREATE);
    expect(created.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const replaced = await race(replace(1));
    expect(replaced.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    for (const r of [...created, ...replaced]) {
      if (r.status === 'rejected')
        expect((r.reason as { code?: string }).code).toBe('version_conflict');
    }
    expect(await overlayRows(tdb, w.lodging)).toHaveLength(1);
    expect((await overlays.get(w.member.userId, w.lodging)).version).toBe(2);
  });

  it('answers version_conflict to a create that loses the race to a commit it could not see', async () => {
    const w = await overlaysWorld(tdb);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rival = tdb.db.transaction().execute(async (trx) => {
      await createOverlay(trx, {
        tripId: w.tripId,
        itemId: w.lodging,
        membershipId: w.member.membershipId,
        note: 'first',
      });
      await held;
    });
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    await wait(150);
    // The put finds no committed overlay, so it inserts, and waits on the rival's row.
    const losing = refusal(overlays.put(as(w.member), w.lodging, body(), CREATE));
    await wait(300);
    release();
    await rival;
    expect(await losing).toBe('version_conflict');
    expect(await overlayRows(tdb, w.lodging)).toHaveLength(1);
  });

  it('creates a new one after the old one was removed, as version 1', async () => {
    const w = await overlaysWorld(tdb);
    const id = await createOverlay(tdb.db, {
      tripId: w.tripId,
      itemId: w.lodging,
      membershipId: w.member.membershipId,
      note: 'gone',
      deleted: true,
    });
    const created = await overlays.put(as(w.member), w.lodging, body(), CREATE);
    expect(created.version).toBe(1);
    const rows = await overlayRows(tdb, w.lodging);
    expect(rows.map((r) => r.id)).toContain(id);
    expect(rows).toHaveLength(2);
  });

  it('answers not_found for an item the caller cannot see, outside the trip, to a removed member and on a deleted item or trip', async () => {
    const w = await overlaysWorld(tdb);
    expect(await refusal(overlays.put(as(w.owner), w.hidden, body(), CREATE))).toBe('not_found');
    expect(await refusal(overlays.put(as(w.viewer), w.hidden, body(), CREATE))).toBe('not_found');
    expect(await refusal(overlays.put(as(w.outsider), w.lodging, body(), CREATE))).toBe(
      'not_found',
    );
    expect(
      await refusal(
        overlays.put(as(w.member), '0192f000-0000-7000-8000-00000000000a', body(), CREATE),
      ),
    ).toBe('not_found');
    await softDelete(tdb.db, 'tribo.memberships', w.other.membershipId);
    expect(await refusal(overlays.put(as(w.other), w.lodging, body(), CREATE))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.items', w.rental);
    expect(await refusal(overlays.put(as(w.member), w.rental, body(), CREATE))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.trips', w.tripId);
    expect(await refusal(overlays.put(as(w.member), w.lodging, body(), CREATE))).toBe('not_found');
    expect(await overlayRows(tdb, w.hidden)).toHaveLength(0);
  });

  it('validates the body: a reminder must be an instant, notes and lists are bounded, nothing else is taken', async () => {
    const w = await overlaysWorld(tdb);
    const put = (b: unknown) => refusal(overlays.put(as(w.member), w.lodging, b, CREATE));
    expect(await put(body({ reminderAt: 'tomorrow' }))).toBe('validation_failed');
    expect(await put(body({ note: 'x'.repeat(4001) }))).toBe('validation_failed');
    expect(await put(body({ checklist: [{ text: '', done: false }] }))).toBe('validation_failed');
    expect(await put(body({ checklist: [{ text: 'x'.repeat(201), done: false }] }))).toBe(
      'validation_failed',
    );
    expect(
      await put(
        body({ checklist: Array.from({ length: 51 }, () => ({ text: 'x', done: false })) }),
      ),
    ).toBe('validation_failed');
    expect(await put(body({ checklist: [{ text: 'x' }] }))).toBe('validation_failed');
    expect(await put(body({ version: 9 }))).toBe('validation_failed');
    expect(await overlayRows(tdb, w.lodging)).toHaveLength(0);
  });

  it('answers trip_archived on an archived trip', async () => {
    const w = await overlaysWorld(tdb);
    await overlays.put(as(w.member), w.lodging, body(), CREATE);
    await archive(tdb, w.tripId);
    expect(await refusal(overlays.put(as(w.member), w.lodging, body(), replace(1)))).toBe(
      'trip_archived',
    );
    expect(await refusal(overlays.put(as(w.other), w.lodging, body(), CREATE))).toBe(
      'trip_archived',
    );
    expect((await overlays.get(w.member.userId, w.lodging)).version).toBe(1);
  });

  it('records its audit event and entity_versions snapshot in the one transaction, the event without the words', async () => {
    const w = await overlaysWorld(tdb);
    const ctx = as(w.member);
    await overlays.put(ctx, w.lodging, body(), CREATE);
    const [row] = await overlayRows(tdb, w.lodging);
    const id = row?.id ?? '';
    const replaceCtx = as(w.member);
    await overlays.put(replaceCtx, w.lodging, body({ note: 'Changed my mind' }), replace(1));
    const { events, snapshots } = await history(tdb, id);
    expect(events).toEqual([
      {
        chain_key: `trip:${w.tripId}`,
        action: 'create',
        entity_type: 'overlay',
        version_before: null,
        version_after: 1,
        request_id: ctx.requestId,
      },
      {
        chain_key: `trip:${w.tripId}`,
        action: 'update',
        entity_type: 'overlay',
        version_before: 1,
        version_after: 2,
        request_id: replaceCtx.requestId,
      },
    ]);
    expect(snapshots.map((s) => [s.entity_type, s.version])).toEqual([
      ['overlay', 1],
      ['overlay', 2],
    ]);
    expect(snapshots[1]?.snapshot).toMatchObject({
      itemId: w.lodging,
      membershipId: w.member.membershipId,
      note: 'Changed my mind',
    });
    // The event row holds ids and counters, never the note, the checklist or the reminder.
    const event = await tdb.db
      .selectFrom('audit.audit_events')
      .selectAll()
      .where('entity_id', '=', id)
      .execute();
    expect(JSON.stringify(event)).not.toMatch(/garden|padlock|Changed my mind|2026-11-10/);
  });
});
