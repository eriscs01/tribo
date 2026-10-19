import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Memory } from './transitions.ts';

/** What survives a restart: per PR number, what was already emitted. */
export interface WatchState {
  prs: Record<string, Memory>;
}

export interface StateStore {
  load(): WatchState | Promise<WatchState>;
  save(state: WatchState): void | Promise<void>;
}

/** Failure to read or write the state file; names the file, never its content. */
export class StateError extends Error {
  readonly code: 'state_unreadable' | 'state_unwritable';

  readonly path: string;

  constructor(code: 'state_unreadable' | 'state_unwritable', path: string) {
    super(`${code}: ${path}`);
    this.code = code;
    this.path = path;
  }
}

/** The state as one JSON file, replaced atomically so a crash mid-write leaves the old one. */
export function createFileStore(path: string): StateStore {
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { prs: {} };
        throw new StateError('state_unreadable', path);
      }
      try {
        const state = JSON.parse(text) as WatchState;
        if (typeof state.prs !== 'object') throw new TypeError('no prs');
        return state;
      } catch {
        throw new StateError('state_unreadable', path);
      }
    },
    async save(state) {
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
        await rename(`${path}.tmp`, path);
      } catch {
        throw new StateError('state_unwritable', path);
      }
    },
  };
}
