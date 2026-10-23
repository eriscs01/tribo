import { anyMember, contributors } from '../roles.js';

/** files.list: every role; the file predicate narrows what each one sees. */
export const canListFiles = anyMember;

/** files.upload: owner, organizer, member (operations.csv); the owner is the caller's membership. */
export const canUploadFile = contributors;
