import { registry, type Operation } from '@tribo/contract';
import { describe, expect, it } from 'vitest';
import { ApiError } from './errors.js';
import { addressBucket, createRateLimits, fixedWindow, RateLimited } from './rate-limit.js';

const op = (id: string): Operation => {
  const found = registry.find((o) => o.id === id);
  if (!found) throw new Error(`${id} missing`);
  return found;
};

describe('fixedWindow', () => {
  it('admits the budget, then answers the seconds left in the window', () => {
    let now = 120_000;
    const window = fixedWindow({ limit: 2, windowMs: 60_000 }, () => now);
    expect(window.take('a')).toBeNull();
    expect(window.take('a')).toBeNull();
    now += 20_500;
    expect(window.take('a')).toBe(40);
    expect(window.take('b')).toBeNull();
  });

  it('starts every key afresh in the next window, and forgets the idle ones', () => {
    let now = 0;
    const window = fixedWindow({ limit: 1, windowMs: 1_000 }, () => now);
    for (let i = 0; i < 100; i += 1) window.take(`key-${String(i)}`);
    expect(window.trackedKeys).toBe(100);
    expect(window.take('key-0')).toBe(1);
    now = 1_000;
    expect(window.take('key-0')).toBeNull();
    expect(window.trackedKeys).toBe(1);
  });
});

describe('addressBucket', () => {
  it('keeps an IPv4 address whole and unwraps an IPv4-mapped one', () => {
    expect(addressBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(addressBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('reduces an IPv6 address to its /64, however it is written', () => {
    expect(addressBucket('2001:db8:1:2::a')).toBe('2001:db8:1:2::/64');
    expect(addressBucket('2001:0DB8:0001:0002:ffff:0:0:b')).toBe('2001:db8:1:2::/64');
    expect(addressBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressBucket('::1')).toBe('0:0:0:0::/64');
    expect(addressBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });
});

describe('createRateLimits', () => {
  const limits = (now = () => 0) => createRateLimits(now);

  it('refuses the 11th write without an account from one address', () => {
    const rl = limits();
    for (let i = 0; i < 10; i += 1) rl.admit(op('auth.login'), { address: '203.0.113.1' });
    const refusal = (() => {
      try {
        rl.admit(op('auth.login'), { address: '203.0.113.1' });
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(refusal).toBeInstanceOf(RateLimited);
    expect(refusal).toBeInstanceOf(ApiError);
    expect(refusal).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 60 });
  });

  it('refuses the 121st write by one account, whatever its address', () => {
    const rl = limits();
    for (let i = 0; i < 120; i += 1) rl.admit(op('auth.mfa.setup'), { account: 'u1' });
    expect(() => {
      rl.admit(op('auth.mfa.setup'), { account: 'u1' });
    }).toThrow(RateLimited);
    expect(() => {
      rl.admit(op('auth.mfa.setup'), { account: 'u2' });
    }).not.toThrow();
  });

  it('never counts a read', () => {
    const rl = limits();
    expect(() => {
      for (let i = 0; i < 200; i += 1) rl.admit(op('me.get'), { account: 'u1' });
      for (let i = 0; i < 200; i += 1) rl.admit(op('meta.liveness'), { address: '203.0.113.2' });
    }).not.toThrow();
  });
});
