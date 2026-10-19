// Modules expose only their service.ts; see the boundary rule in CLAUDE.md.
export { writePath } from './write-path.js';
export {
  createIdentityService,
  startTotpEnrolment,
  totpMatches,
  type ClientInfo,
  type IdentityService,
  type NewAdmin,
  type SignedIn,
} from './identity/service.js';
export {
  createTripsService,
  type TripCreator,
  type TripRecord,
  type TripsService,
  type TripStatus,
} from './trips/service.js';
export {
  createItemsService,
  type ItemRecord,
  type ItemsService,
  type ItemTimeRecord,
} from './items/service.js';
export {
  createLibraryService,
  type LibraryHitRecord,
  type LibraryService,
  type PersonRecord,
  type PlaceRecord,
  type VendorRecord,
} from './library/service.js';
export {
  requestEvents,
  verifyChains,
  type ChainReport,
  type RequestEvent,
} from './audit/service.js';
