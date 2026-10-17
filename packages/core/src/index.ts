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
