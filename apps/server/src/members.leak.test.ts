// members.list never shows an emergency contact: every role reads it masked over HTTP, and
// its plaintext appears nowhere in the response (library.people.reveal is the one way in).
import { randomBytes } from 'node:crypto';
import { CSRF_HEADER, encodeTypeId, ID_PREFIX, SESSION_COOKIE } from '@tribo/contract';
import { AppKey } from '@tribo/crypto';
import {
  addMember,
  createTestDatabase,
  createTrip,
  createUser,
  type TestDatabase,
  type TripRole,
} from '@tribo/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { composeServices, type Services } from './runtime.js';

const PASSWORD = 'correct horse battery';

let tdb: TestDatabase;
let app: FastifyInstance;
let services: Services;

beforeAll(async () => {
  tdb = await createTestDatabase();
  services = composeServices(tdb.db, new AppKey(randomBytes(32)), new URL('https://tribo.test'));
  app = await buildApp(services, { trustedProxies: ['loopback'], logLevel: 'silent' });
});
afterAll(async () => {
  await app.close();
  await tdb.destroy();
});

let n = 0;
async function signedInUser() {
  n += 1;
  const username = `masked_${String(n)}`;
  const user = await createUser(tdb.db, { username, password: PASSWORD });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password: PASSWORD },
    // One client per account, so signing many in stays under the per-address login limit.
    remoteAddress: `2001:db8:${n.toString(16)}::1`,
  });
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
  const { csrfToken } = res.json<{ csrfToken: string }>();
  return {
    ...user,
    auth: { cookies: { [SESSION_COOKIE]: token }, headers: { [CSRF_HEADER]: csrfToken } },
  };
}

describe('members.list masks emergency contacts for every role', () => {
  it('shows {masked: true} and never the contact itself, to owner, organizer, member and viewer', async () => {
    const owner = await signedInUser();
    const { tripId } = await createTrip(tdb.db, { owner });
    const callers = [owner];
    for (const role of ['organizer', 'member', 'viewer'] satisfies TripRole[]) {
      // eslint-disable-next-line no-await-in-loop -- accounts are made one at a time
      const user = await signedInUser();
      // eslint-disable-next-line no-await-in-loop -- each membership follows its account
      await addMember(tdb.db, { tripId, personId: user.personId, role });
      callers.push(user);
    }
    const guest = await services.library.createPerson(
      { requestId: 'req-guest', surface: 'web', userId: owner.userId },
      {
        displayName: 'Mara',
        emergencyContact: { name: 'Nena Santos', relation: 'aunt', phone: '+63 917 555 0101' },
      },
    );
    await addMember(tdb.db, { tripId, personId: guest.id, role: 'member' });

    for (const caller of callers) {
      // eslint-disable-next-line no-await-in-loop -- one caller at a time
      const res = await app.inject({
        method: 'GET',
        url: `/v1/trips/${encodeTypeId(ID_PREFIX.trip, tripId)}/members`,
        ...caller.auth,
      });
      expect(res.statusCode).toBe(200);
      const mara = res
        .json<{ items: { person: { id: string; emergencyContact: unknown } }[] }>()
        .items.find((m) => m.person.id === encodeTypeId(ID_PREFIX.person, guest.id));
      expect(mara?.person.emergencyContact).toEqual({ masked: true });
      expect(res.body).not.toMatch(/Nena|Santos|aunt|917/);
    }
  });
});
