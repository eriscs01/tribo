import { describe, expect, it } from 'vitest';
import { checkIfMatch } from './write-path.js';

describe('checkIfMatch', () => {
  it('ignores If-Match on operations that declare none', () => {
    expect(() => {
      checkIfMatch('no', undefined, 3);
    }).not.toThrow();
    expect(() => {
      checkIfMatch('no', 1, 3);
    }).not.toThrow();
  });

  it.each(['version', 'board_version', 'budget_version'] as const)(
    '%s: requires the header and matches it against the loaded counter',
    (declared) => {
      expect(() => {
        checkIfMatch(declared, undefined, 3);
      }).toThrow(expect.objectContaining({ code: 'if_match_required' }));
      expect(() => {
        checkIfMatch(declared, 2, 3);
      }).toThrow(expect.objectContaining({ code: 'version_conflict' }));
      expect(() => {
        checkIfMatch(declared, 3, 3);
      }).not.toThrow();
    },
  );

  it('version_or_new needs If-Match only once the aggregate exists', () => {
    expect(() => {
      checkIfMatch('version_or_new', undefined, undefined);
    }).not.toThrow();
    expect(() => {
      checkIfMatch('version_or_new', undefined, 1);
    }).toThrow(expect.objectContaining({ code: 'if_match_required' }));
  });

  it('treats a counter operation that loaded no counter as a programming error', () => {
    expect(() => {
      checkIfMatch('version', 1, undefined);
    }).toThrow(/loaded no counter/);
  });
});
