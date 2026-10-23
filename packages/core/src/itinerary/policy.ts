import { anyMember } from '../roles.js';

/** itinerary.get: owner, organizer, member, viewer (operations.csv). The story adds what a trip role can't say. */
export const canGetItinerary = anyMember;

/** trips.dashboard: owner, organizer, member, viewer (operations.csv); masking narrows the rest. */
export const canReadDashboard = anyMember;

/** me.tasks: the caller's own trips, in whatever role; masking and visibility narrow what they read. */
export const canListMyTasks = anyMember;

/** trips.offlineBundle: owner, organizer, member, viewer (operations.csv); masking and visibility narrow what they read. */
export const canReadOfflineBundle = anyMember;
