import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { InviteCreated } from './invite.js';
import { MfaConfirm } from './mfa.js';
import { secret, withoutSecrets } from './secret.js';

const Created = z.strictObject({
  id: z.string(),
  token: secret(z.string()).optional(),
  redacted: z.boolean(),
});

describe('withoutSecrets', () => {
  it('drops each field marked secret and says redacted', () => {
    expect(withoutSecrets(Created, { id: 'a', token: 't', redacted: false })).toEqual({
      body: { id: 'a', redacted: true },
      redacted: true,
    });
  });

  it('leaves a body with no secret value as it is', () => {
    expect(withoutSecrets(Created, { id: 'a', redacted: false })).toEqual({
      body: { id: 'a', redacted: false },
      redacted: false,
    });
  });

  it('leaves a body whose schema marks nothing secret as it is', () => {
    const body = { id: 'a', name: 'b' };
    expect(withoutSecrets(z.object({ id: z.string(), name: z.string() }), body)).toEqual({
      body,
      redacted: false,
    });
    expect(withoutSecrets(undefined, body)).toEqual({ body, redacted: false });
  });

  it('marks the shown-once values the contract already has', () => {
    expect(
      withoutSecrets(InviteCreated, {
        id: 'i',
        token: 't',
        link: 'https://x/join#t',
        redacted: false,
      }).body,
    ).toEqual({ id: 'i', redacted: true });
    expect(withoutSecrets(MfaConfirm, { recoveryCodes: ['a'], redacted: false }).body).toEqual({
      redacted: true,
    });
  });
});
