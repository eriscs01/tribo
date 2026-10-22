import { describe, expect, it } from 'vitest';
import {
  base32,
  hashSecret,
  newRecoveryCode,
  normalizeRecoveryCode,
  NO_PASSWORD,
  totpAt,
  totpUri,
  totpValid,
  verifySecret,
} from './credentials.js';
import { countsAsFailure, type LoginStep } from './policy.js';

// RFC 6238 appendix B, SHA-1 rows, last six digits.
const rfcSecret = Buffer.from('12345678901234567890');

describe('TOTP', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches the RFC 6238 vector at T=%i', (t, code) => {
    expect(totpAt(rfcSecret, t)).toBe(code);
  });

  it('accepts one 30-second step of drift either side, and no more', () => {
    const now = 1_234_567_890_000;
    expect(totpValid(rfcSecret, totpAt(rfcSecret, now / 1000), now)).toBe(true);
    expect(totpValid(rfcSecret, totpAt(rfcSecret, now / 1000 - 30), now)).toBe(true);
    expect(totpValid(rfcSecret, totpAt(rfcSecret, now / 1000 + 30), now)).toBe(true);
    expect(totpValid(rfcSecret, totpAt(rfcSecret, now / 1000 - 90), now)).toBe(false);
    expect(totpValid(rfcSecret, '12345', now)).toBe(false);
  });

  it('encodes the secret as RFC 4648 base32 in the otpauth URI', () => {
    expect(base32(rfcSecret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(totpUri(rfcSecret, 'Tribo', 'alice')).toBe(
      'otpauth://totp/Tribo%3Aalice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Tribo&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('secrets', () => {
  it('hashes with Argon2id at 19 MiB, 2 passes, 1 lane', async () => {
    const phc = await hashSecret('correct horse battery');
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifySecret(phc, 'correct horse battery')).toBe(true);
    expect(await verifySecret(phc, 'Correct horse battery')).toBe(false);
  });

  it("never verifies against '!' or a malformed hash", async () => {
    expect(await verifySecret(NO_PASSWORD, '!')).toBe(false);
    expect(await verifySecret('not-a-hash', 'x')).toBe(false);
  });

  it('forgives case and a missing dash in a typed recovery code', () => {
    const code = newRecoveryCode();
    expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(normalizeRecoveryCode(code.toUpperCase().replace('-', ' '))).toBe(code);
  });
});

describe('lockout policy', () => {
  it.each<[LoginStep, boolean]>([
    ['wrong_password', true],
    ['wrong_second_factor', true],
    ['unknown_user', false],
    ['locked', false],
    ['disabled', false],
    ['mfa_required', false],
  ])('%s counts towards the lockout: %s', (step, counts) => {
    expect(countsAsFailure(step)).toBe(counts);
  });
});
