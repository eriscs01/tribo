import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_STATUS } from './errors.js';
import { decodeTypeId, encodeTypeId, ID_PREFIX, typeId, TypeIdError } from './ids.js';
import { Money } from './money.js';
import { Problem, problem } from './problem.js';
import { Instant, TimeInput } from './time.js';

describe('TypeID', () => {
  // Test vector from the TypeID specification.
  const uuid = '01890a5d-ac96-774b-bcce-b302099a8057';
  const suffix = '01h455vb4pex5vsknk084sn02q';

  it('encodes and decodes the spec vector', () => {
    expect(encodeTypeId('trp', uuid)).toBe(`trp_${suffix}`);
    expect(decodeTypeId('trp', `trp_${suffix}`)).toBe(uuid);
  });

  it('round-trips UUIDv7 values for every prefix', () => {
    const samples = [
      '00000000-0000-7000-8000-000000000000',
      'ffffffff-ffff-7fff-bfff-ffffffffffff',
      '019a0f3c-5b2e-7c41-9d3a-6e8f1a2b3c4d',
    ];
    for (const prefix of Object.values(ID_PREFIX)) {
      for (const u of samples) expect(decodeTypeId(prefix, encodeTypeId(prefix, u))).toBe(u);
    }
  });

  it('rejects a wrong prefix, an overflowing first char and letters outside the alphabet', () => {
    expect(() => decodeTypeId('itm', `trp_${suffix}`)).toThrow(TypeIdError);
    expect(() => decodeTypeId('trp', `trp_8${suffix.slice(1)}`)).toThrow(TypeIdError);
    expect(() => decodeTypeId('trp', `trp_${suffix.slice(0, -1)}u`)).toThrow(TypeIdError);
    expect(() => encodeTypeId('trp', 'not-a-uuid')).toThrow(TypeIdError);
  });

  it('validates ids in schemas', () => {
    expect(typeId('trp').safeParse(`trp_${suffix}`).success).toBe(true);
    expect(typeId('trp').safeParse(`itm_${suffix}`).success).toBe(false);
  });
});

describe('errors and problem details', () => {
  it('keeps the 29 design codes plus internal_error and the dev-only not_implemented', () => {
    expect(ERROR_CODES).toHaveLength(31);
    expect(ERROR_STATUS.internal_error).toBe(500);
    expect(ERROR_STATUS.version_conflict).toBe(412);
    expect(ERROR_STATUS.if_match_required).toBe(428);
    expect(ERROR_STATUS.not_implemented).toBe(501);
  });

  it('builds RFC 9457 bodies that parse', () => {
    const body = problem('not_found', 'req-1', { detail: 'no such trip' });
    expect(body).toMatchObject({ status: 404, code: 'not_found', requestId: 'req-1' });
    expect(Problem.parse(body)).toEqual(body);
    expect(Problem.safeParse({ ...body, code: 'teapot' }).success).toBe(false);
  });
});

describe('money and time', () => {
  it('takes integer minor units and ISO 4217 codes', () => {
    expect(Money.safeParse({ amountMinor: 125050, currency: 'PHP' }).success).toBe(true);
    expect(Money.safeParse({ amountMinor: 1250.5, currency: 'PHP' }).success).toBe(false);
    expect(Money.safeParse({ amountMinor: 1, currency: 'php' }).success).toBe(false);
  });

  it('takes wall-clock time plus zone or an all-day date, never both', () => {
    const ok = [{ local: '2026-11-11T07:40', tz: 'Asia/Manila' }, { date: '2026-11-11' }];
    const bad = [
      { local: '2026-11-11T07:40', tz: 'Asia/Manila', date: '2026-11-11' },
      { local: '2026-11-11T07:40+08:00', tz: 'Asia/Manila' },
      { local: '2026-02-30T07:40', tz: 'Asia/Manila' },
      { local: '2026-11-11T24:00', tz: 'Asia/Manila' },
      { local: '2026-11-11T07:40', tz: 'Mars/Olympus' },
      // R17: abbreviations and POSIX specs resolve in Intl but are refused by tribo.iana_tz.
      { local: '2026-11-11T07:40', tz: 'EST' },
      { local: '2026-11-11T07:40', tz: 'EST5EDT' },
      { local: '2026-11-11T07:40' },
    ];
    for (const v of ok) expect(TimeInput.safeParse(v).success, JSON.stringify(v)).toBe(true);
    for (const v of bad) expect(TimeInput.safeParse(v).success, JSON.stringify(v)).toBe(false);
  });

  it('returns instants in UTC', () => {
    expect(Instant.safeParse('2026-11-10T23:40:00Z').success).toBe(true);
    expect(Instant.safeParse('2026-11-11T07:40').success).toBe(false);
  });
});
