import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase, type TestDatabase } from './database.js';
import { addMember, createItem, createPlaceholder, createTrip, createUser } from './factories.js';

describe('test database', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it('is cloned from the migrated template', async () => {
    const owner = connectAs(tdb.name, 'tribo_owner');
    await owner.connect();
    const { rows } = await owner.query<{ name: string }>(
      'SELECT name FROM public.schema_migrations',
    );
    await owner.end();
    expect(rows.map((r) => r.name)).toContain('0001_init.sql');
  });

  it('connects tests as tribo_app', async () => {
    const { rows } = await tdb.pool.query<{ u: string }>('SELECT current_user AS u');
    expect(rows[0]?.u).toBe('tribo_app');
  });

  it.each([
    'UPDATE audit.audit_events SET seq = seq',
    'DELETE FROM audit.audit_events',
    'TRUNCATE audit.audit_events',
    'INSERT INTO tribo.platform_settings DEFAULT VALUES',
    'CREATE TABLE tribo.x (i int)',
    'CREATE TABLE public.x (i int)',
    'CREATE SCHEMA x',
  ])('denies tribo_app: %s', async (statement) => {
    await expect(tdb.pool.query(statement)).rejects.toMatchObject({ code: '42501' });
  });

  it('keeps per-test databases apart', async () => {
    const other = await createTestDatabase();
    try {
      await createUser(tdb.db, { username: 'only_here' });
      const found = await other.db
        .selectFrom('tribo.users')
        .select('id')
        .where('username', '=', 'only_here')
        .execute();
      expect(found).toHaveLength(0);
    } finally {
      await other.destroy();
    }
  });

  it('clones quickly', async () => {
    const started = performance.now();
    const quick = await createTestDatabase();
    const elapsed = performance.now() - started;
    await quick.destroy();
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('factories', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it('build a trip with owner, members, a placeholder and items under the real constraints', async () => {
    const ana = await createUser(tdb.db, { displayName: 'Ana' });
    const ben = await createUser(tdb.db, { displayName: 'Ben' });
    const guest = await createPlaceholder(tdb.db, { createdBy: ana.userId });
    const trip = await createTrip(tdb.db, { owner: ana, name: 'Test trip' });
    const benM = await addMember(tdb.db, {
      tripId: trip.tripId,
      personId: ben.personId,
      role: 'member',
    });
    await addMember(tdb.db, { tripId: trip.tripId, personId: guest, role: 'member' });
    const item = await createItem(tdb.db, {
      tripId: trip.tripId,
      ownerMembershipId: trip.ownerMembershipId,
      visibility: 'selected',
      sharedWith: [benM],
    });

    const members = await tdb.db
      .selectFrom('tribo.memberships')
      .select(['trip_role'])
      .where('trip_id', '=', trip.tripId)
      .execute();
    expect(members.map((m) => m.trip_role).sort()).toEqual(['member', 'member', 'owner']);
    const shares = await tdb.db
      .selectFrom('tribo.item_shares')
      .selectAll()
      .where('item_id', '=', item)
      .execute();
    expect(shares).toHaveLength(1);
  });

  it('cannot give a trip a second active owner (memberships_one_owner)', async () => {
    const ana = await createUser(tdb.db);
    const ben = await createUser(tdb.db);
    const trip = await createTrip(tdb.db, { owner: ana });
    await expect(
      addMember(tdb.db, { tripId: trip.tripId, personId: ben.personId, role: 'owner' }),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
