// @module-tag drop-a
// itinerary.get (Drop A): Day timeline ?view=me|group&from&to, with warnings; item_visible; local times per item tz
import { createItineraryService, type ItineraryService } from '@tribo/core';
import type { DB } from '@tribo/db';
import { Kysely, PostgresDialect } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boardWorld, refusal, type Member } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addAllocation, createItem, createUnit, softDelete } from './factories.js';

let tdb: TestDatabase;
let itinerary: ItineraryService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  itinerary = createItineraryService(tdb.db);
});
afterAll(() => tdb.destroy());

const group = { view: 'group' as const };
const me = { view: 'me' as const };

/** A timed item in Manila, from and to local wall-clock times on one day. */
const manila = (day: string, from: string, to: string) => ({
  start: new Date(`${day}T${from}:00+08:00`),
  end: new Date(`${day}T${to}:00+08:00`),
  tz: 'Asia/Manila',
});

type World = Awaited<ReturnType<typeof boardWorld>>;

/** A board row on one of the world's items. */
function seat(w: World, itemId: string, m: Member, role: 'attendee' | 'assignee' | 'occupant') {
  return addAllocation(tdb.db, {
    tripId: w.tripId,
    itemId,
    membershipId: m.membershipId,
    role,
    ...(role === 'occupant' ? { unitId: w.room1 } : {}),
  });
}

describe('itinerary.get', () => {
  it('lays the group view out by local day, a stay as check-in, nights and check-out', async () => {
    const w = await boardWorld(tdb);
    const ferry = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      type: 'transport',
      title: 'Ferry to Siquijor',
      timed: manila('2026-11-11', '13:00', '14:30'),
    });
    const result = await itinerary.get(w.member.userId, w.tripId, group);

    const ids = (date: string) =>
      result.days.find((d) => d.date === date)?.entries.map((e) => [e.itemId, e.part, e.time]);
    expect(result.days.map((d) => d.date)).toEqual([
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
    ]);
    expect(ids('2026-11-11')).toEqual([
      [w.lodging, 'check_in', null],
      [ferry, 'whole', '13:00'],
    ]);
    expect(ids('2026-11-12')).toEqual([
      [w.lodging, 'staying', null],
      [w.rental, 'start', null],
    ]);
    expect(ids('2026-11-14')).toEqual([[w.lodging, 'check_out', null]]);
    expect(result.items.map((i) => i.id).sort()).toEqual([w.lodging, w.rental, ferry].sort());
    expect(result).toMatchObject({ view: 'group', from: null, to: null, warnings: [] });
  });

  it('keeps the days of from..to, and the items those days name', async () => {
    const w = await boardWorld(tdb);
    const result = await itinerary.get(w.member.userId, w.tripId, {
      ...group,
      from: '2026-11-14',
      to: '2026-11-20',
    });
    expect(result.days).toEqual([
      {
        date: '2026-11-14',
        entries: [{ itemId: w.lodging, part: 'check_out', time: null, tz: null }],
      },
    ]);
    expect(result.items.map((i) => i.id)).toEqual([w.lodging]);
    expect(result).toMatchObject({ from: '2026-11-14', to: '2026-11-20' });
  });

  it('keeps in view=me the items the caller owns or is on the board of, but not a no', async () => {
    const w = await boardWorld(tdb);
    const dive = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
      title: 'Dive',
      days: { start: '2026-11-12' },
    });
    const lunch = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      type: 'meal',
      days: { start: '2026-11-12' },
    });
    const market = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      days: { start: '2026-11-13' },
    });
    await seat(w, w.lodging, w.member, 'occupant');
    await seat(w, lunch, w.member, 'assignee');
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: market,
      membershipId: w.member.membershipId,
      role: 'attendee',
      rsvp: 'no',
    });

    const result = await itinerary.get(w.member.userId, w.tripId, me);
    expect(result.items.map((i) => i.id).sort()).toEqual([w.lodging, dive, lunch].sort());
    expect(result.view).toBe('me');
  });

  it('shows each item in its own zone: a flight to Tokyo lands on its local day there', async () => {
    const w = await boardWorld(tdb);
    const flight = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      type: 'transport',
      timed: {
        start: new Date('2026-11-14T15:30:00Z'), // 23:30 in Manila
        end: new Date('2026-11-14T19:45:00Z'), // 04:45 next day in Tokyo
        tz: 'Asia/Manila',
      },
    });
    await tdb.db
      .updateTable('tribo.items')
      .set({ end_tz: 'Asia/Tokyo' })
      .where('id', '=', flight)
      .execute();
    const result = await itinerary.get(w.member.userId, w.tripId, {
      ...group,
      from: '2026-11-14',
      to: '2026-11-15',
    });
    const lines = result.days.flatMap((d) =>
      d.entries.filter((e) => e.itemId === flight).map((e) => [d.date, e.part, e.time, e.tz]),
    );
    expect(lines).toEqual([
      ['2026-11-14', 'start', '23:30', 'Asia/Manila'],
      ['2026-11-15', 'end', '04:45', 'Asia/Tokyo'],
    ]);
  });

  it('masks costs and restricted fields exactly as items.list does', async () => {
    const w = await boardWorld(tdb);
    await tdb.db
      .updateTable('tribo.items')
      .set({ cost_minor: 900_000, cost_currency: 'PHP' })
      .where('id', '=', w.lodging)
      .execute();
    const cost = async (m: Member) =>
      (await itinerary.get(m.userId, w.tripId, group)).items.find((i) => i.id === w.lodging)?.cost;
    expect(await cost(w.member)).toEqual({ amountMinor: 900_000, currency: 'PHP' });
    expect(await cost(w.viewer)).toBe('masked');
    await tdb.db
      .updateTable('tribo.items')
      .set({ restricted_fields: ['cost'] })
      .where('id', '=', w.lodging)
      .execute();
    expect(await cost(w.member)).toBe('masked');
    expect(await cost(w.organizer)).toEqual({ amountMinor: 900_000, currency: 'PHP' });
  });

  it('warns of an overlap between two items with someone on both, and of a vehicle without a licensed driver', async () => {
    const w = await boardWorld(tdb);
    const ferry = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      type: 'transport',
      timed: manila('2026-11-12', '09:00', '11:00'),
    });
    const dive = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      timed: manila('2026-11-12', '10:00', '12:00'),
    });
    await seat(w, ferry, w.member, 'attendee');
    await seat(w, dive, w.member, 'assignee');
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: w.rental,
      membershipId: w.other.membershipId,
      role: 'driver',
      unitId: w.bike,
    });

    const { warnings } = await itinerary.get(w.viewer.userId, w.tripId, group);
    const [first = '', second = ''] = [ferry, dive].sort();
    const overlap = { code: 'overlap', itemId: first, withItemId: second };
    const driver = { code: 'no_licensed_driver', itemId: w.rental, unitId: w.bike };
    expect(warnings).toEqual(w.rental < first ? [driver, overlap] : [overlap, driver]);
  });

  it('never warns of an item the caller cannot see: no overlap with a private item, no hidden vehicle', async () => {
    const w = await boardWorld(tdb);
    const dive = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      timed: manila('2026-11-12', '10:00', '12:00'),
    });
    const secret = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.other.membershipId,
      visibility: 'private',
      timed: manila('2026-11-12', '09:00', '11:00'),
    });
    const hiddenRental = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.other.membershipId,
      visibility: 'private',
      type: 'ground',
      days: { start: '2026-11-12' },
    });
    const scooter = await createUnit(tdb.db, { itemId: hiddenRental, kind: 'vehicle' });
    await seat(w, dive, w.other, 'attendee');
    await seat(w, secret, w.other, 'attendee');
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: hiddenRental,
      membershipId: w.other.membershipId,
      role: 'driver',
      unitId: scooter,
    });

    const theirs = await itinerary.get(w.other.userId, w.tripId, group);
    expect(theirs.warnings.map((x) => x.code).sort()).toEqual(['no_licensed_driver', 'overlap']);
    const mine = await itinerary.get(w.member.userId, w.tripId, group);
    expect(mine.warnings).toEqual([]);
    expect(JSON.stringify(mine)).not.toContain(secret);
    expect(JSON.stringify(mine)).not.toContain(hiddenRental);
  });

  it('lets owner, organizer, member and viewer read it', async () => {
    const w = await boardWorld(tdb);
    for (const user of [w.owner, w.organizer, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- each role is checked on its own
      await expect(itinerary.get(user.userId, w.tripId, group)).resolves.toMatchObject({
        view: 'group',
      });
    }
  });

  it('answers not_found outside the trip, to a removed member and on a deleted trip', async () => {
    const w = await boardWorld(tdb);
    expect(await refusal(itinerary.get(w.outsider.userId, w.tripId, group))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.memberships', w.other.membershipId);
    expect(await refusal(itinerary.get(w.other.userId, w.tripId, group))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.trips', w.tripId);
    expect(await refusal(itinerary.get(w.owner.userId, w.tripId, group))).toBe('not_found');
  });
});

describe('itinerary.get on a representative trip', () => {
  /** The trip of the design: ten members and a few hundred items, half of them on boards. */
  async function bigTrip(items: number) {
    const w = await boardWorld(tdb);
    const crew = [w.owner, w.organizer, w.member, w.other, w.viewer];
    for (let i = 0; i < items; i += 1) {
      const day = `2026-11-${String(11 + (i % 4))}`;
      const hour = String(8 + (i % 10)).padStart(2, '0');
      // eslint-disable-next-line no-await-in-loop -- rows go in one by one
      const id = await createItem(tdb.db, {
        tripId: w.tripId,
        ownerMembershipId: (crew[i % crew.length] ?? w.owner).membershipId,
        type: i % 3 === 0 ? 'transport' : 'activity',
        visibility: i % 7 === 0 ? 'private' : 'shared',
        timed: manila(day, `${hour}:00`, `${hour}:45`),
        cost: { amountMinor: 1_000 * i, currency: 'PHP' },
      });
      // eslint-disable-next-line no-await-in-loop -- as above
      if (i % 2 === 0) await seat(w, id, crew[(i + 1) % crew.length] ?? w.member, 'attendee');
    }
    return w;
  }

  /** The number of queries one read sends, through a handle that counts them. */
  async function queriesOf(read: (db: Kysely<DB>) => Promise<unknown>): Promise<number> {
    let queries = 0;
    // Same pool as the test database; never destroyed here, so the pool stays open.
    const counted = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: tdb.pool }),
      log: (event) => {
        if (event.level === 'query') queries += 1;
      },
    });
    await read(counted);
    return queries;
  }

  it('sends the same number of queries for 10 items as for 300 (no N+1)', async () => {
    const small = await bigTrip(10);
    const large = await bigTrip(300);
    const read = (w: World) => (db: Kysely<DB>) =>
      createItineraryService(db).get(w.member.userId, w.tripId, group);
    expect(await queriesOf(read(large))).toBe(await queriesOf(read(small)));
  });

  // A measured run, not a CI gate: timings under a loaded parallel suite say little. Run it
  // alone with TRIBO_MEASURE=1 (the pull request quotes its numbers).
  it.runIf(process.env.TRIBO_MEASURE === '1')(
    'answers 300 items well under the 300 ms read target',
    async () => {
      const w = await bigTrip(300);
      await itinerary.get(w.member.userId, w.tripId, group); // warm the pool and the plans
      const runs: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const started = performance.now();
        // eslint-disable-next-line no-await-in-loop -- timed one at a time
        await itinerary.get(w.member.userId, w.tripId, group);
        runs.push(performance.now() - started);
      }
      runs.sort((x, y) => x - y);
      const [median = Infinity, slowest = Infinity] = [runs[10], runs.at(-1)];
      console.info(
        `itinerary.get, 300 items: median ${median.toFixed(1)} ms, slowest ${slowest.toFixed(1)} ms`,
      );
      expect(slowest).toBeLessThan(300);
    },
  );
});
