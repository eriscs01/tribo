// Me schemas: the caller's account and their own person profile.
import * as z from 'zod';
import { Username } from './account.js';
import { DueSoon } from './dashboard.js';
import { ID_PREFIX, typeId } from './ids.js';
import { Item } from './item.js';
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

/** One of the caller's open tasks, with the name of the trip it is in. */
export const MyTask = z.strictObject({ tripName: z.string(), item: Item }).meta({ id: 'MyTask' });

/**
 * me.tasks: the caller's open tasks across the trips they are in, by due date (a task assigned
 * to them, or owned by them with nobody assigned), and the due-soon list of the same rules
 * as the trip dashboard's. Only items the caller can see, and only their own reminders.
 */
export const MyTasks = z
  .strictObject({ tasks: z.array(MyTask), dueSoon: z.array(DueSoon) })
  .meta({ id: 'MyTasks' });

export type MyTasks = z.infer<typeof MyTasks>;
