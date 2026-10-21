import { isIPv6 } from 'node:net';
import { isRateLimited, type Operation } from '@tribo/contract';
import { ApiError } from './errors.js';

/** At most `limit` requests per key in each `windowMs`. */
interface Budget {
  limit: number;
  windowMs: number;
}

/** Technical design, Operations, "Rate limits"; which operations count is `isRateLimited`. */
const BUDGETS = {
  /** Writes made without an account (auth.login, the other public writes), per client. */
  address: { limit: 10, windowMs: 60_000 },
  /** Writes by one signed-in account; from 1b, by one OAuth client too. */
  account: { limit: 120, windowMs: 60_000 },
} as const satisfies Record<string, Budget>;

/**
 * Who a write counts against: the signed-in account, or the client address when there is
 * none. The REST adapter takes the address from the trusted proxy only (decision 0008).
 * 1b adds `{ oauthClient: string }`, counted with the accounts' budget.
 */
export type Requester = { account: string } | { address: string };

/** rate_limited, with the seconds until the caller's window resets (sent as Retry-After). */
export class RateLimited extends ApiError {
  constructor(readonly retryAfterSeconds: number) {
    super('rate_limited');
    this.name = 'RateLimited';
  }
}

export interface FixedWindow {
  /** Counts one request for `key`: null within budget, else the seconds left in the window. */
  take(key: string): number | null;
  /** How many keys the current window holds. */
  readonly trackedKeys: number;
}

/**
 * Fixed windows aligned to the clock. A window's counts live in one map that is dropped
 * whole when the next window starts, so memory holds only the keys seen in the current one.
 */
export function fixedWindow(budget: Budget, now: () => number): FixedWindow {
  let current = Number.NaN;
  let counts = new Map<string, number>();
  return {
    take(key) {
      const at = now();
      const index = Math.floor(at / budget.windowMs);
      if (index !== current) {
        current = index;
        counts = new Map();
      }
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count <= budget.limit) return null;
      return Math.ceil(((index + 1) * budget.windowMs - at) / 1000);
    },
    get trackedKeys() {
      return counts.size;
    },
  };
}

const IPV4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/**
 * The bucket a client address counts in: an IPv4 address on its own, an IPv6 address by its
 * /64, the smallest prefix one subscriber is usually given, so rotating through it is no escape.
 */
export function addressBucket(address: string): string {
  const mapped = IPV4_MAPPED.exec(address)?.[1];
  if (mapped !== undefined) return mapped;
  const bare = address.split('%')[0] ?? '';
  // Anything but IPv6 (IPv4, or whatever a misconfigured proxy forwards) counts as written.
  if (!isIPv6(bare)) return address;
  const [head = '', tail] = bare.toLowerCase().split('::');
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const full = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  const prefix = full.slice(0, 4).map((g) => Number.parseInt(g, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

export interface RateLimits {
  /** Counts the request if the operation is limited; throws RateLimited when over budget. */
  admit(op: Pick<Operation, 'method' | 'status'>, requester: Requester): void;
}

/** One process's in-memory limits (Technical design: one host, in the app). */
export function createRateLimits(now: () => number = Date.now): RateLimits {
  const byAddress = fixedWindow(BUDGETS.address, now);
  const byAccount = fixedWindow(BUDGETS.account, now);
  return {
    admit(op, requester) {
      if (!isRateLimited(op)) return;
      const retryAfter =
        'account' in requester
          ? byAccount.take(requester.account)
          : byAddress.take(addressBucket(requester.address));
      if (retryAfter !== null) throw new RateLimited(retryAfter);
    },
  };
}
