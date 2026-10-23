import { FileKind, FileMimeType, FileVisibility } from '@tribo/contract';
import { VALUE_SETS } from '@tribo/db';
import { describe, expect, it } from 'vitest';

// The database's CHECKs own the closed sets; the contract's enums must match them.
describe('file value sets', () => {
  it('FileKind, FileVisibility and FileMimeType are tribo.files’ CHECKs', () => {
    expect(FileKind.options).toEqual(VALUE_SETS['tribo.files.kind']);
    expect(FileVisibility.options).toEqual(VALUE_SETS['tribo.files.visibility']);
    expect(FileMimeType.options).toEqual(VALUE_SETS['tribo.files.mime_type']);
  });
});
