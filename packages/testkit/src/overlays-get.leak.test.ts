// @module-tag drop-b
// overlays.get against the oracle: of every overlay in the world (one for every membership on
// every item of its trip), an account reads only its own, on an item it sees, while it is an
// active member who is not a viewer. Another member's note, checklist and reminder never
// appear, by value, by the answer's code, or by the number of queries the read costs.
import type { DB } from '@tribo/db';
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { leakRunOptions, oracle, worldProperty, type BuiltWorld } from './leak.js';
import {
  activeMembership,
  counted,
  overlayNote,
  overlaysService,
  seedOverlays,
} from './overlays-world.js';

/* eslint-disable no-await-in-loop -- one transaction, so one statement at a time */
const options = leakRunOptions();

type Answer = { overlay: string } | { refused: string };
type OverlayRead = (db: Kysely<DB>, userId: string, itemId: string) => Promise<unknown>;

const getOverlay: OverlayRead = (db, userId, itemId) => overlaysService(db).get(userId, itemId);

/** What a read answered, as text a marker can be looked for in, or the code it refused with. */
async function answer(read: OverlayRead, db: Kysely<DB>, userId: string, itemId: string) {
  try {
    return { overlay: JSON.stringify(await read(db, userId, itemId)) } satisfies Answer;
  } catch (error) {
    if (error instanceof ApiError) return { refused: error.code } satisfies Answer;
    throw error;
  }
}

/** What the oracle says a caller reads of the overlay on this item. */
function expected(world: BuiltWorld, userId: string, tripId: string, itemId: string) {
  if (!oracle.itemVisible(world, userId, itemId)) return { refused: 'not_found' };
  const membership = activeMembership(world, userId, tripId);
  if (membership?.role === 'viewer') return { refused: 'forbidden' };
  return { own: overlayNote(membership?.id ?? '', itemId) };
}

const itemsOf = (world: BuiltWorld) =>
  world.trips.flatMap((t) => t.items.map((i) => ({ tripId: t.id, itemId: i.id })));

describe('overlays.get against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  const readsOnlyItsOwn = (read: OverlayRead) =>
    worldProperty(tdb.db, async (trx, world) => {
      await seedOverlays(trx, world);
      const problems: string[] = [];
      for (const userId of world.userIds) {
        for (const { tripId, itemId } of itemsOf(world)) {
          const got = await answer(read, trx, userId, itemId);
          const want = expected(world, userId, tripId, itemId);
          if ('refused' in want) {
            if (!('refused' in got) || got.refused !== want.refused) {
              problems.push(
                `${userId} on ${itemId}: wanted ${want.refused}, got ${JSON.stringify(got)}`,
              );
            }
          } else if (!('overlay' in got) || !got.overlay.includes(want.own)) {
            problems.push(`${userId} on ${itemId}: not their own overlay`);
          } else {
            const others = [...got.overlay.matchAll(/ovl-(?:note|check):([0-9a-f-]+)/g)]
              .map((m) => m[1])
              .filter((id) => id !== activeMembership(world, userId, tripId)?.id);
            if (others.length > 0)
              problems.push(`${userId} on ${itemId}: shows ${others[0] ?? ''}`);
          }
        }
      }
      return problems;
    });

  it(`reads only the caller's own overlay (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(readsOnlyItsOwn(getOverlay), options);
  });

  it("answers, and costs, the same with every other member's overlay gone", async () => {
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        await seedOverlays(trx, world);
        const problems: string[] = [];
        for (const userId of world.userIds) {
          const mine = world.trips
            .map((t) => activeMembership(world, userId, t.id)?.id)
            .filter((id): id is string => id !== undefined);
          const readAll = async () => {
            const { handle, state } = counted(trx);
            const answers: Answer[] = [];
            for (const { itemId } of itemsOf(world)) {
              answers.push(await answer(getOverlay, handle, userId, itemId));
            }
            return JSON.stringify({ answers, queries: state.queries });
          };
          const before = await readAll();
          await sql`SAVEPOINT without_others`.execute(trx);
          try {
            await trx
              .deleteFrom('tribo.overlays')
              .where(
                'membership_id',
                'not in',
                mine.length > 0 ? mine : ['00000000-0000-0000-0000-000000000000'],
              )
              .execute();
            const after = await readAll();
            if (before !== after) problems.push(`${userId}'s reads change with others' overlays`);
          } finally {
            await sql`ROLLBACK TO SAVEPOINT without_others`.execute(trx);
          }
        }
        return problems;
      }),
      options,
    );
  });

  it('mutation check: the harness catches a get that looks the overlay up without the caller', async () => {
    const leaky: OverlayRead = async (db, userId, itemId) => {
      const fair = await overlaysService(db).get(userId, itemId);
      const any = await db
        .selectFrom('tribo.overlays')
        .select(['note', 'membership_id'])
        .where('item_id', '=', itemId)
        .orderBy('membership_id')
        .executeTakeFirstOrThrow();
      return { ...fair, note: any.note };
    };
    expect((await fc.check(readsOnlyItsOwn(leaky), options)).failed).toBe(true);
  });

  it('mutation check: the harness catches a get that tells a missing overlay from a hidden item by who else has one', async () => {
    const leaky: OverlayRead = async (db, userId, itemId) => {
      try {
        return await overlaysService(db).get(userId, itemId);
      } catch (error) {
        const others = await db
          .selectFrom('tribo.overlays')
          .select('id')
          .where('item_id', '=', itemId)
          .execute();
        if (error instanceof ApiError && error.code === 'not_found' && others.length > 1) {
          throw new ApiError('forbidden');
        }
        throw error;
      }
    };
    expect((await fc.check(readsOnlyItsOwn(leaky), options)).failed).toBe(true);
  });
});
