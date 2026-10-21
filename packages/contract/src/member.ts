// Member schemas: a trip's memberships, the people in them and their roles.
import * as z from 'zod';
import { ID_PREFIX, typeId } from './ids.js';
import { page } from './page.js';
import { Person } from './person.js';
import { Instant } from './time.js';

/** A membership's role in its trip; the trip has exactly one owner. */
export const TripRole = z.enum(['owner', 'organizer', 'member', 'viewer']).meta({ id: 'TripRole' });

export type TripRole = z.infer<typeof TripRole>;

/**
 * A membership as members.list returns it, with the person behind it. A placeholder
 * traveller is a person with `hasAccount: false`; the emergency contact is masked for every
 * reader (library.people.reveal shows it).
 */
export const Member = z
  .strictObject({
    id: typeId(ID_PREFIX.membership),
    tripId: typeId(ID_PREFIX.trip),
    role: TripRole,
    /** Whether costs show to this member: always for every role but viewer, which needs the grant. */
    canViewCosts: z.boolean(),
    person: Person,
    version: z.int().min(1),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .meta({ id: 'Member' });

export type Member = z.infer<typeof Member>;

/** members.list: the trip's active memberships, oldest first. */
export const MemberPage = page(Member, 'MemberPage');

export type MemberPage = z.infer<typeof MemberPage>;
