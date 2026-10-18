import { randomBytes } from 'node:crypto';
import { AppKey, keyring, type Keyring } from '@tribo/crypto';

/** A fresh random app key for one test run: sealed values open only within that run. */
export function testKeys(): Keyring {
  return keyring(new AppKey(randomBytes(32)));
}
