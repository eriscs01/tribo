import { contributors } from '../roles.js';

/** files.upload: owner, organizer, member (operations.csv); the owner is the caller's membership. */
export const canUploadFile = contributors;
