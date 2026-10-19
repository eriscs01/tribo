import type { Release } from '../config.js';
import type { CliIo } from './io.js';

/** `tribo release show`: the release and commit this image was built from. */
export function releaseShow(deps: { release: Release; io: CliIo }): Promise<void> {
  deps.io.say(`Tribo ${deps.release.version} (${deps.release.commit})`);
  return Promise.resolve();
}
