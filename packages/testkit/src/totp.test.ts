import { describe, expect, it } from 'vitest';
import { totpFor } from './totp.js';

// RFC 6238, Appendix B: the SHA-1 seed "12345678901234567890", in base32.
const RFC_KEY = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totpFor', () => {
  it('matches the RFC 6238 SHA-1 vectors (their last six digits)', () => {
    expect(totpFor(RFC_KEY, 59_000)).toBe('287082');
    expect(totpFor(RFC_KEY, 1_111_111_109_000)).toBe('081804');
  });

  it('ignores base32 padding and letter case', () => {
    expect(totpFor(`${RFC_KEY}====`, 59_000)).toBe('287082');
    expect(totpFor(RFC_KEY.toLowerCase(), 59_000)).toBe('287082');
  });
});
