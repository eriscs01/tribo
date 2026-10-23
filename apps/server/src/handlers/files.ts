import {
  encodeTypeId,
  ID_PREFIX,
  PageQuery,
  type FileMetadata,
  type FilePage,
} from '@tribo/contract';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import type { FileRecord, FilesService } from '@tribo/core';
import { ApiError } from '@tribo/platform';
import { attachment } from '../content-disposition.js';
import { ifMatch, pathId, requestContext, signedIn } from '../context.js';
import { withUpload } from '../multipart.js';
import { parsedQuery, type Handlers } from '../routes.js';

function fileView(file: FileRecord): FileMetadata {
  return {
    id: encodeTypeId(ID_PREFIX.file, file.id),
    tripId: encodeTypeId(ID_PREFIX.trip, file.tripId),
    itemId: file.itemId === null ? null : encodeTypeId(ID_PREFIX.item, file.itemId),
    ownerMembershipId: encodeTypeId(ID_PREFIX.membership, file.ownerMembershipId),
    kind: file.kind,
    sensitive: file.sensitive,
    visibility: file.visibility,
    filename: file.filename,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    version: file.version,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
    purgedAt: file.purgedAt?.toISOString() ?? null,
  };
}

/**
 * Resolves once the stream holds its first authenticated chunk (or has ended), rejects if
 * it fails first (events.once rejects on 'error'): a download answers only once it can
 * start with real bytes.
 */
async function opened(content: Readable): Promise<void> {
  await once(content, 'readable');
}

export function filesHandlers(files: FilesService): Handlers {
  return {
    'files.list': async (request): Promise<FilePage> => {
      const page = await files.list(
        signedIn(request).userId,
        pathId(request, 'tripId'),
        parsedQuery(request, PageQuery),
      );
      return { items: page.items.map(fileView), nextCursor: page.nextCursor };
    },
    'files.get': async (request) =>
      fileView(await files.get(signedIn(request).userId, pathId(request, 'fileId'))),
    'files.update': async (request) =>
      fileView(
        await files.update(
          requestContext(request),
          pathId(request, 'fileId'),
          request.body,
          ifMatch(request),
        ),
      ),
    'files.delete': async (request, reply) => {
      await files.delete(
        requestContext(request),
        pathId(request, 'fileId'),
        request.body,
        ifMatch(request),
      );
      return reply.code(204).send();
    },
    // Decision 0022: the bytes as an attachment that nothing sniffs, caches or runs.
    'files.download': async (request, reply) => {
      const fileId = pathId(request, 'fileId');
      const { file, content } = await files.download(requestContext(request), fileId);
      try {
        await opened(content);
      } catch (error) {
        content.destroy();
        request.log.error({ fileId, err: error }, 'file content unreadable');
        throw new ApiError('internal_error');
      }
      // Past the first chunk the status is sent: a failure can only cut the response short.
      content.once('error', (error) => {
        request.log.error({ fileId, err: error }, 'file download failed');
      });
      return reply
        .code(200)
        .headers({
          'content-type': file.mimeType,
          'content-length': String(file.sizeBytes),
          'content-disposition': attachment(file.filename),
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
        })
        .send(content);
    },
    'files.upload': async (request, reply) => {
      const tripId = pathId(request, 'tripId');
      const file = await withUpload(request, (form, part) =>
        files.upload(requestContext(request), tripId, form, part),
      );
      return reply.code(201).send(fileView(file));
    },
  };
}
