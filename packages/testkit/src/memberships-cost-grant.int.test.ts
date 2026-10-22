// The cost-grant rule as the schema states it (0003_memberships_cost_grant.sql, decision
// 0007): can_view_costs is a viewer's alone. The members write path and invites.accept
// both keep it; the CHECK makes sure no third writer can break it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addMember, createTrip, createUser } from './factories.js';

describe('memberships_cost_grant_viewer_only', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it("stores a viewer's grant, and refuses one on any other role", async () => {
    const owner = await createUser(tdb.db);
    const { tripId } = await createTrip(tdb.db, { owner });
    const viewer = await createUser(tdb.db);
    await expect(
      addMember(tdb.db, { tripId, personId: viewer.personId, role: 'viewer', canViewCosts: true }),
    ).resolves.toEqual(expect.any(String));
    for (const role of ['organizer', 'member'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one role at a time
      const other = await createUser(tdb.db);
      // eslint-disable-next-line no-await-in-loop -- as above
      await expect(
        addMember(tdb.db, { tripId, personId: other.personId, role, canViewCosts: true }),
      ).rejects.toMatchObject({ constraint: 'memberships_cost_grant_viewer_only' });
    }
    await expect(
      tdb.db
        .updateTable('tribo.memberships')
        .set({ can_view_costs: true })
        .where('trip_id', '=', tripId)
        .where('trip_role', '=', 'owner')
        .execute(),
    ).rejects.toMatchObject({ constraint: 'memberships_cost_grant_viewer_only' });
  });
});
