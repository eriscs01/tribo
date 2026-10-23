import {
  encodeTypeId,
  ID_PREFIX,
  PageQuery,
  type FileMetadata,
  type FilePage,
} from '@tribo/contract';
import type { FileRecord, FilesService } from '@tribo/core';
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
    'files.upload': async (request, reply) => {
      const tripId = pathId(request, 'tripId');
      const file = await withUpload(request, (form, part) =>
        files.upload(requestContext(request), tripId, form, part),
      );
      return reply.code(201).send(fileView(file));
    },
  };
}
