import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { ifMatch } from './context.js';

const withIfMatch = (value?: string) =>
  ({ headers: value === undefined ? {} : { 'if-match': value } }) as unknown as FastifyRequest;

describe('ifMatch', () => {
  it('reads the counter from a strong, weak or bare entity tag', () => {
    expect(ifMatch(withIfMatch('"3"'))).toBe(3);
    expect(ifMatch(withIfMatch('W/"12"'))).toBe(12);
    expect(ifMatch(withIfMatch(' 7 '))).toBe(7);
  });

  it('is undefined without the header, so the write path can answer if_match_required', () => {
    expect(ifMatch(withIfMatch())).toBeUndefined();
  });

  it('turns a header that names no counter into one that matches no version', () => {
    for (const value of ['*', '"1", "2"', 'abc', '""', '"-1"']) {
      expect(ifMatch(withIfMatch(value)), value).toBeNaN();
    }
  });
});
