import { describe, expect, it } from 'vitest';
import { attachment } from './content-disposition.js';

describe('attachment', () => {
  it('names an ASCII file plainly, in both forms', () => {
    expect(attachment('Ferry ticket.pdf')).toBe(
      `attachment; filename="Ferry ticket.pdf"; filename*=UTF-8''Ferry%20ticket.pdf`,
    );
  });

  it('percent-encodes everything RFC 8187 does not allow bare, and falls back to _ in ASCII', () => {
    expect(attachment('Café — Batanes.jpg')).toBe(
      `attachment; filename="Caf_ _ Batanes.jpg"; filename*=UTF-8''Caf%C3%A9%20%E2%80%94%20Batanes.jpg`,
    );
    expect(attachment("it's (1)*.png")).toBe(
      `attachment; filename="it's (1)*.png"; filename*=UTF-8''it%27s%20%281%29%2A.png`,
    );
  });

  it('cannot end the quoted name or the header early', () => {
    const header = attachment('a"b\\c\r\nSet-Cookie: x=1;.pdf');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.startsWith('attachment; filename="a_b_c__Set-Cookie: x=1;.pdf"; ')).toBe(true);
  });
});
