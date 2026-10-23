// The files handlers over HTTP: multipart uploads parse and stream, views map, the
// Idempotency-Key replays, and every refusal leaves its log line without a file name or a
// byte of content. The rules behind each operation are proven against the documents
// service in packages/testkit.
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  CSRF_HEADER,
  encodeTypeId,
  ID_PREFIX,
  SESSION_COOKIE,
  UPLOAD_MAX_BYTES,
} from '@tribo/contract';
import { AppKey } from '@tribo/crypto';
import {
  addMember,
  createItem,
  createTestDatabase,
  createTrip,
  createUser,
  type TestDatabase,
} from '@tribo/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { composeServices, type Services } from './runtime.js';

const PASSWORD = 'correct horse battery';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = Buffer.from('%PDF-1.7\n', 'latin1');

let tdb: TestDatabase;
let app: FastifyInstance;
let services: Services;
let uploads: string;
const lines: Record<string, unknown>[] = [];
const raw: string[] = [];
const linesOf = (requestId: unknown) => lines.filter((l) => l.requestId === requestId);

beforeAll(async () => {
  tdb = await createTestDatabase();
  uploads = await mkdtemp(join(tmpdir(), 'tribo-files-http-'));
  services = composeServices(
    tdb.db,
    new AppKey(randomBytes(32)),
    new URL('https://tribo.test'),
    uploads,
  );
  const logStream = new PassThrough();
  logStream.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      raw.push(line);
      lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  app = await buildApp(services, { trustedProxies: ['loopback'], logLevel: 'info', logStream });
});
afterAll(async () => {
  await app.close();
  await tdb.destroy();
  await rm(uploads, { recursive: true, force: true });
});

/** Every blob on the upload volume, half-written ones included. */
async function blobs(): Promise<string[]> {
  const entries = await readdir(uploads, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

let n = 0;
/** A new account, signed in over HTTP: the cookie and CSRF header every later request sends. */
async function signedInUser() {
  n += 1;
  const username = `file_traveller_${String(n)}`;
  const user = await createUser(tdb.db, { username, password: PASSWORD });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password: PASSWORD },
    remoteAddress: `2001:db8:f${n.toString(16)}::1`,
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
  const { csrfToken } = res.json<{ csrfToken: string }>();
  return {
    ...user,
    auth: { cookies: { [SESSION_COOKIE]: token }, headers: { [CSRF_HEADER]: csrfToken } },
  };
}

type Caller = Awaited<ReturnType<typeof signedInUser>>;

/** A signed-in owner, member and viewer of a trip with one shared item. */
async function world() {
  const owner = await signedInUser();
  const member = await signedInUser();
  const viewer = await signedInUser();
  const trip = await createTrip(tdb.db, { owner });
  const memberMembershipId = await addMember(tdb.db, {
    tripId: trip.tripId,
    personId: member.personId,
    role: 'member',
  });
  await addMember(tdb.db, { tripId: trip.tripId, personId: viewer.personId, role: 'viewer' });
  const itemId = await createItem(tdb.db, {
    tripId: trip.tripId,
    ownerMembershipId: trip.ownerMembershipId,
    type: 'transport',
    title: 'Ferry to Batan',
  });
  return {
    owner,
    member,
    viewer,
    trip,
    memberMembershipId,
    itemId,
    tripPath: encodeTypeId(ID_PREFIX.trip, trip.tripId),
    itemPath: encodeTypeId(ID_PREFIX.item, itemId),
  };
}

type World = Awaited<ReturnType<typeof world>>;

interface FilePart {
  name?: string;
  filename: string;
  type: string;
  data: Buffer;
}

/** A multipart/form-data body: the text fields in order, then the file part if any. */
function form(fields: [string, string][], file?: FilePart) {
  const boundary = `----tribo${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of fields) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name ?? 'file'}"; ` +
          `filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
      file.data,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function upload(
  w: World,
  caller: Pick<Caller, 'auth'>,
  body: ReturnType<typeof form>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: `/v1/trips/${w.tripPath}/files`,
    payload: body.payload,
    cookies: caller.auth.cookies,
    headers: { ...caller.auth.headers, 'content-type': body.contentType, ...headers },
  });
}

const png = (size = 2_048) => Buffer.concat([PNG, randomBytes(size - PNG.length)]);

/** The refusal line the request left: request id, operation id and code, never values. */
const refusalLine = (requestId: unknown) =>
  linesOf(requestId).find((l) => l.msg === 'request refused');

/** No line the request logged holds the file name or the opening bytes of its content. */
function logsNothingOf(requestId: unknown, filename: string, data: Buffer) {
  const mine = raw.filter((l) => l.includes(String(requestId)));
  expect(mine.length).toBeGreaterThan(0);
  for (const line of mine) {
    expect(line).not.toContain(filename);
    expect(line).not.toContain(data.subarray(PNG.length, PNG.length + 12).toString('hex'));
    expect(line).not.toContain(data.subarray(PNG.length, PNG.length + 12).toString('base64'));
  }
}

describe('files.upload over HTTP', () => {
  it('answers 201 with the file’s metadata, typed from its bytes', async () => {
    const w = await world();
    const data = png();
    const res = await upload(
      w,
      w.member,
      form(
        [
          ['kind', 'ticket'],
          ['itemId', w.itemPath],
        ],
        { filename: 'Passport Ana.png', type: 'image/png', data },
      ),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.stringMatching(/^fil_/) as string,
      tripId: w.tripPath,
      itemId: w.itemPath,
      ownerMembershipId: encodeTypeId(ID_PREFIX.membership, w.memberMembershipId),
      kind: 'ticket',
      sensitive: true,
      visibility: 'shared',
      filename: 'Passport Ana.png',
      mimeType: 'image/png',
      sizeBytes: data.length,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      version: 1,
      createdAt: expect.any(String) as string,
      updatedAt: expect.any(String) as string,
      purgedAt: null,
    });
    // A sensitive file's name never reaches the log, nor do its bytes.
    logsNothingOf(res.headers['x-request-id'], 'Passport Ana', data);
  });

  it('refuses a session write without its CSRF header, storing nothing', async () => {
    const w = await world();
    const before = await blobs();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/trips/${w.tripPath}/files`,
      payload: form([['kind', 'photo']], { filename: 'a.png', type: 'image/png', data: png() })
        .payload,
      cookies: w.owner.auth.cookies,
      headers: {
        'content-type': form([], undefined).contentType,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      code: 'forbidden',
      detail: 'missing or invalid CSRF token',
    });
    expect(await blobs()).toEqual(before);
  });

  it('answers 401 without a session', async () => {
    const w = await world();
    const res = await upload(
      w,
      { auth: { cookies: {}, headers: {} } } as Pick<Caller, 'auth'>,
      form([['kind', 'photo']], { filename: 'a.png', type: 'image/png', data: png() }),
    );
    expect(res.statusCode).toBe(401);
  });

  it('refuses a body that is not a form with one file part named file', async () => {
    const w = await world();
    const before = await blobs();
    const json = await app.inject({
      method: 'POST',
      url: `/v1/trips/${w.tripPath}/files`,
      payload: { kind: 'photo' },
      ...w.owner.auth,
    });
    expect(json.statusCode).toBe(400);
    expect(json.json()).toMatchObject({ code: 'validation_failed' });
    const noFile = await upload(w, w.owner, form([['kind', 'photo']]));
    expect(noFile.json()).toMatchObject({ code: 'validation_failed', errors: [{ path: '/file' }] });
    const misnamed = await upload(
      w,
      w.owner,
      form([['kind', 'photo']], {
        name: 'photo',
        filename: 'a.png',
        type: 'image/png',
        data: png(),
      }),
    );
    expect(misnamed.json()).toMatchObject({ code: 'validation_failed' });
    const twice = await upload(
      w,
      w.owner,
      form(
        [
          ['kind', 'photo'],
          ['kind', 'id'],
        ],
        { filename: 'a.png', type: 'image/png', data: png() },
      ),
    );
    expect(twice.json()).toMatchObject({ code: 'validation_failed' });
    expect(await blobs()).toEqual(before);
  });

  it('never lets a field named __proto__ reach an object’s prototype', async () => {
    const w = await world();
    const res = await upload(
      w,
      w.owner,
      form(
        [
          ['__proto__', 'polluted'],
          ['kind', 'photo'],
        ],
        { filename: 'a.png', type: 'image/png', data: png() },
      ),
    );
    expect(res.statusCode).toBeLessThan(500);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('answers 415 for bytes off the allowlist and logs the refusal by code', async () => {
    const w = await world();
    const before = await blobs();
    const res = await upload(
      w,
      w.owner,
      form([['kind', 'other']], {
        filename: 'ticket.pdf',
        type: 'application/pdf',
        data: Buffer.from('<html><script>alert(1)</script></html>'),
      }),
    );
    expect(res.statusCode).toBe(415);
    expect(refusalLine(res.headers['x-request-id'])).toMatchObject({
      operationId: 'files.upload',
      problem: 'file_type_not_allowed',
      status: 415,
    });
    expect(await blobs()).toEqual(before);
  });

  it('answers 413 file_too_large one byte past 25 MiB and stores exactly 25 MiB', async () => {
    const w = await world();
    const before = await blobs();
    const over = await upload(
      w,
      w.owner,
      form([['kind', 'photo']], {
        filename: 'big.png',
        type: 'image/png',
        data: png(UPLOAD_MAX_BYTES + 1),
      }),
    );
    expect(over.statusCode).toBe(413);
    expect(over.json()).toMatchObject({ code: 'file_too_large' });
    expect(refusalLine(over.headers['x-request-id'])).toMatchObject({ problem: 'file_too_large' });
    expect(await blobs()).toEqual(before);
    const exact = await upload(
      w,
      w.owner,
      form([['kind', 'photo']], {
        filename: 'big.png',
        type: 'image/png',
        data: png(UPLOAD_MAX_BYTES),
      }),
    );
    expect(exact.statusCode).toBe(201);
    expect(exact.json()).toMatchObject({ sizeBytes: UPLOAD_MAX_BYTES });
  });

  it('logs a forbidden upload by operation and code', async () => {
    const w = await world();
    const data = png();
    const res = await upload(
      w,
      w.viewer,
      form([['kind', 'id']], { filename: 'Viewer passport.png', type: 'image/png', data }),
    );
    expect(res.statusCode).toBe(403);
    expect(refusalLine(res.headers['x-request-id'])).toMatchObject({
      operationId: 'files.upload',
      problem: 'forbidden',
    });
    logsNothingOf(res.headers['x-request-id'], 'Viewer passport', data);
  });

  it('replays a repeat under the same Idempotency-Key, writing one row and one blob', async () => {
    const w = await world();
    const data = png();
    const body = () => form([['kind', 'voucher']], { filename: 'v.png', type: 'image/png', data });
    const first = await upload(w, w.owner, body(), { 'idempotency-key': 'voucher-1' });
    expect(first.statusCode).toBe(201);
    const stored = await blobs();
    const again = await upload(w, w.owner, body(), { 'idempotency-key': 'voucher-1' });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await blobs()).toEqual(stored);
    const files = await tdb.db
      .selectFrom('tribo.files')
      .select('id')
      .where('trip_id', '=', w.trip.tripId)
      .execute();
    expect(files).toHaveLength(1);

    // Another file under the same key is refused, and its blob does not stay.
    const other = await upload(
      w,
      w.owner,
      form([['kind', 'voucher']], { filename: 'v.png', type: 'image/png', data: png() }),
      { 'idempotency-key': 'voucher-1' },
    );
    expect(other.statusCode).toBe(422);
    expect(other.json()).toMatchObject({ code: 'idempotency_key_reused' });
    expect(await blobs()).toEqual(stored);
  });

  it('refuses a PDF sent as an image the same way it refuses an unknown type', async () => {
    const w = await world();
    const res = await upload(
      w,
      w.owner,
      form([['kind', 'other']], { filename: 'scan.png', type: 'image/png', data: PDF }),
    );
    expect(res.statusCode).toBe(415);
  });
});

describe('files.list over HTTP', () => {
  it('answers a page of the files the caller sees, and 404 to a stranger with its log line', async () => {
    const w = await world();
    const data = png();
    const made = await upload(
      w,
      w.member,
      form([['kind', 'photo']], { filename: 'beach.png', type: 'image/png', data }),
    );
    await upload(
      w,
      w.member,
      form(
        [
          ['kind', 'id'],
          ['visibility', 'private'],
        ],
        { filename: 'passport.png', type: 'image/png', data: png() },
      ),
    );
    const res = await app.inject({
      method: 'GET',
      url: `/v1/trips/${w.tripPath}/files?limit=10`,
      ...w.viewer.auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [made.json()], nextCursor: null });

    const stranger = await signedInUser();
    const refused = await app.inject({
      method: 'GET',
      url: `/v1/trips/${w.tripPath}/files`,
      ...stranger.auth,
    });
    expect(refused.statusCode).toBe(404);
    expect(refusalLine(refused.headers['x-request-id'])).toMatchObject({
      operationId: 'files.list',
      problem: 'not_found',
    });
  });
});

describe('files.get over HTTP', () => {
  it('answers the file to a member, and the same 404 for a private file as for none', async () => {
    const w = await world();
    const shared = await upload(
      w,
      w.member,
      form([['kind', 'photo']], { filename: 'beach.png', type: 'image/png', data: png() }),
    );
    const secret = await upload(
      w,
      w.member,
      form(
        [
          ['kind', 'photo'],
          ['visibility', 'private'],
        ],
        { filename: 'mine.png', type: 'image/png', data: png() },
      ),
    );
    const get = (caller: Caller, id: string) =>
      app.inject({ method: 'GET', url: `/v1/files/${id}`, ...caller.auth });
    const ok = await get(w.viewer, shared.json<{ id: string }>().id);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(shared.json());
    const hidden = await get(w.owner, secret.json<{ id: string }>().id);
    const none = await get(
      w.owner,
      encodeTypeId(ID_PREFIX.file, '019a0f3c-5b2e-7c41-9d3a-6e8f1a2b3c4d'),
    );
    expect([hidden.statusCode, none.statusCode]).toEqual([404, 404]);
    const strip = (body: Record<string, unknown>) => ({ ...body, requestId: 0, instance: 0 });
    expect(strip(hidden.json())).toEqual(strip(none.json()));
    expect(refusalLine(hidden.headers['x-request-id'])).toMatchObject({
      operationId: 'files.get',
      problem: 'not_found',
    });
  });
});

describe('files.update over HTTP', () => {
  it('renames under If-Match and answers 412 to a stale one, with its log line', async () => {
    const w = await world();
    const made = await upload(
      w,
      w.member,
      form([['kind', 'photo']], { filename: 'beach.png', type: 'image/png', data: png() }),
    );
    const { id } = made.json<{ id: string }>();
    const patch = (version: string, payload: Record<string, unknown>) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/files/${id}`,
        payload,
        cookies: w.member.auth.cookies,
        headers: { ...w.member.auth.headers, 'if-match': version },
      });
    const ok = await patch('"1"', { filename: 'Beach day.png', itemId: w.itemPath });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ filename: 'Beach day.png', itemId: w.itemPath, version: 2 });
    const stale = await patch('"1"', { visibility: 'private' });
    expect(stale.statusCode).toBe(412);
    expect(refusalLine(stale.headers['x-request-id'])).toMatchObject({
      operationId: 'files.update',
      problem: 'version_conflict',
    });
    logsNothingOf(ok.headers['x-request-id'], 'Beach day', png());
  });
});

describe('files.delete over HTTP', () => {
  it('answers 204, keeps the blob, and the file is gone from reads', async () => {
    const w = await world();
    const made = await upload(
      w,
      w.member,
      form([['kind', 'photo']], { filename: 'beach.png', type: 'image/png', data: png() }),
    );
    const { id } = made.json<{ id: string }>();
    const stored = await blobs();
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/files/${id}`,
      cookies: w.member.auth.cookies,
      headers: { ...w.member.auth.headers, 'if-match': '"1"' },
    });
    expect(res.statusCode).toBe(204);
    expect(await blobs()).toEqual(stored);
    const gone = await app.inject({ method: 'GET', url: `/v1/files/${id}`, ...w.member.auth });
    expect(gone.statusCode).toBe(404);
  });
});

describe('files.download over HTTP', () => {
  const download = (caller: Caller, id: string) =>
    app.inject({ method: 'GET', url: `/v1/files/${id}/content`, ...caller.auth });

  async function uploaded(w: World, kind: string, filename: string, data: Buffer) {
    const res = await upload(
      w,
      w.member,
      form([['kind', kind]], { filename, type: 'image/png', data }),
    );
    expect(res.statusCode).toBe(201);
    const { id } = res.json<{ id: string }>();
    const row = await tdb.db
      .selectFrom('tribo.files')
      .select('blob_key')
      .where('trip_id', '=', w.trip.tripId)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    return { id, path: join(uploads, row.blob_key) };
  }

  it('sends the bytes as an attachment nothing sniffs, caches or runs', async () => {
    const w = await world();
    const data = png(100_000);
    const { id } = await uploaded(w, 'id', 'Passport “Ana”.png', data);
    const res = await download(w.viewer, id);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(data)).toBe(true);
    expect(res.headers).toMatchObject({
      'content-type': 'image/png',
      'content-length': String(data.length),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': `attachment; filename="Passport _Ana_.png"; filename*=UTF-8''Passport%20%E2%80%9CAna%E2%80%9D.png`,
    });
    logsNothingOf(res.headers['x-request-id'], 'Passport', data);
  });

  it('answers 404 to a stranger and 410 file_purged for a purged file, each logged by code', async () => {
    const w = await world();
    const { id } = await uploaded(w, 'photo', 'a.png', png());
    const stranger = await signedInUser();
    const refused = await download(stranger, id);
    expect(refused.statusCode).toBe(404);
    expect(refusalLine(refused.headers['x-request-id'])).toMatchObject({
      operationId: 'files.download',
      problem: 'not_found',
    });
    await tdb.db
      .updateTable('tribo.files')
      .set({ purged_at: new Date(), filename: 'purged' })
      .where('trip_id', '=', w.trip.tripId)
      .execute();
    const purged = await download(w.member, id);
    expect(purged.statusCode).toBe(410);
    expect(purged.json()).toMatchObject({ code: 'file_purged' });
  });

  it('answers 500 with a logged line, never bytes, when the blob is missing or damaged at its start', async () => {
    const w = await world();
    const damaged = await uploaded(w, 'photo', 'a.png', png());
    const blob = await readFile(damaged.path);
    blob[20] = 255 - (blob[20] ?? 0);
    await writeFile(damaged.path, blob);
    const res = await download(w.member, damaged.id);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'internal_error' });
    expect(
      linesOf(res.headers['x-request-id']).find((l) => l.msg === 'file content unreadable'),
    ).toMatchObject({
      operationId: 'files.download',
    });
    const missing = await uploaded(w, 'photo', 'b.png', png());
    await rm(missing.path);
    const gone = await download(w.member, missing.id);
    expect(gone.statusCode).toBe(500);
    expect(
      linesOf(gone.headers['x-request-id']).some((l) => l.msg === 'file content unreadable'),
    ).toBe(true);
  });

  it('cuts the response short and logs it when a later chunk does not authenticate', async () => {
    const w = await world();
    const data = png(300_000);
    const { id, path } = await uploaded(w, 'photo', 'big.png', data);
    const blob = await readFile(path);
    blob[blob.length - 30] = 255 - (blob[blob.length - 30] ?? 0);
    await writeFile(path, blob);
    const res = await download(w.member, id).catch((error: unknown) => error as Error);
    if (!(res instanceof Error)) {
      expect(res.rawPayload.length).toBeLessThan(data.length);
      expect(res.rawPayload.equals(data.subarray(0, res.rawPayload.length))).toBe(true);
    }
    await expect.poll(() => lines.some((l) => l.msg === 'file download failed')).toBe(true);
  });
});
