import { anyMember, contributors, itemOwnerOrOrganizer } from '../roles.js';

/** files.list: every role; the file predicate narrows what each one sees. */
export const canListFiles = anyMember;

/** files.get: as files.list. */
export const canGetFile = anyMember;

/** files.download: as files.get; a sensitive file's download is audited (decision 0022). */
export const canDownloadFile = anyMember;

/** files.upload: owner, organizer, member (operations.csv); the owner is the caller's membership. */
export const canUploadFile = contributors;

/**
 * files.update: the file's owner (whatever their role is now), organizers and the trip
 * owner: the rule an item's owner has, which a file's owner shares.
 */
export const canUpdateFile = itemOwnerOrOrganizer;

/** files.delete: as files.update; the blob stays until the retention purge. */
export const canDeleteFile = itemOwnerOrOrganizer;
