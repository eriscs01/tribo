// File schemas: documents uploaded to a trip (tickets, vouchers, ID scans, photos), each
// optionally attached to one of its items. Only metadata travels as JSON; the bytes go up
// as multipart (files.upload) and come down as themselves (files.download).
import * as z from 'zod';
import { ID_PREFIX, typeId } from './ids.js';
import { page } from './page.js';
import { Instant } from './time.js';

/** id, ticket and voucher are sensitive (generated from the kind, never set). */
export const FileKind = z.enum(['id', 'ticket', 'voucher', 'photo', 'other']).meta({
  id: 'FileKind',
});

export type FileKind = z.infer<typeof FileKind>;

/** shared: every member who sees its item; private: its owner alone. */
export const FileVisibility = z.enum(['shared', 'private']).meta({ id: 'FileVisibility' });

export type FileVisibility = z.infer<typeof FileVisibility>;

/** The allowlist: a type is read from the file's first bytes, never from the client. */
export const FileMimeType = z
  .enum(['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp'])
  .meta({ id: 'FileMimeType' });

export type FileMimeType = z.infer<typeof FileMimeType>;

/** A display name: no path, no control characters, at most 255 characters. */
const Filename = z.string().trim().min(1).max(255);

export const FileMetadata = z
  .strictObject({
    id: typeId(ID_PREFIX.file),
    tripId: typeId(ID_PREFIX.trip),
    /** The item it belongs to; null for a file of the trip as a whole. */
    itemId: typeId(ID_PREFIX.item).nullable(),
    ownerMembershipId: typeId(ID_PREFIX.membership),
    kind: FileKind,
    sensitive: z.boolean(),
    visibility: FileVisibility,
    /** `purged` once retention has deleted the bytes. */
    filename: z.string(),
    mimeType: FileMimeType,
    sizeBytes: z.int().min(1),
    /** SHA-256 of the bytes as uploaded, in hex. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    version: z.int().min(1),
    createdAt: Instant,
    updatedAt: Instant,
    /** When retention deleted the bytes; files.download then answers file_purged. */
    purgedAt: Instant.nullable(),
  })
  .meta({ id: 'FileMetadata' });

export type FileMetadata = z.infer<typeof FileMetadata>;

/** files.list: one page of the trip's files the caller may see, oldest first. */
export const FilePage = page(FileMetadata, 'FilePage');

export type FilePage = z.infer<typeof FilePage>;

/**
 * files.upload's text fields, sent before the one `file` part. The owner is the caller's
 * membership; an item must be one the caller sees in the same trip. Inlined in the OpenAPI
 * document (a form has no id).
 */
export const FileUploadForm = z.strictObject({
  kind: FileKind,
  visibility: FileVisibility.default('shared'),
  itemId: typeId(ID_PREFIX.item).optional(),
});

export type FileUploadForm = z.infer<typeof FileUploadForm>;

/**
 * What files.upload's write validates and its Idempotency-Key hashes: the form, and what the
 * server learnt of the file while storing it, so two different files under one key differ.
 */
export const FileUploadInput = FileUploadForm.extend({
  file: z.strictObject({
    filename: Filename,
    mimeType: FileMimeType,
    sizeBytes: z.int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
}).meta({ id: 'FileUploadInput' });

export type FileUploadInput = z.infer<typeof FileUploadInput>;

/**
 * files.update: JSON Merge Patch of a file's metadata; absent keys stay. A new name keeps an
 * extension of the file's type, or none; itemId null detaches it from its item.
 */
export const FilePatch = z
  .strictObject({
    filename: Filename.optional(),
    itemId: typeId(ID_PREFIX.item).nullable().optional(),
    visibility: FileVisibility.optional(),
  })
  .meta({ id: 'FilePatch' });

export type FilePatch = z.infer<typeof FilePatch>;
