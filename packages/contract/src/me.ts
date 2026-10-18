// Me schemas: the caller's account and their own person profile.
import * as z from 'zod';
import { Username } from './account.js';
import { ID_PREFIX, typeId } from './ids.js';
import { Person } from './person.js';

/** me.get and me.update: the account signed in, and its person (sensitive fields masked). */
export const Me = z
  .strictObject({
    account: z.strictObject({
      id: typeId(ID_PREFIX.user),
      username: Username,
      platformRole: z.enum(['admin', 'user']),
    }),
    person: Person,
  })
  .meta({ id: 'Me' });

export type Me = z.infer<typeof Me>;
