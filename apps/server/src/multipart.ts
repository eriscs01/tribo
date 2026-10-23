import multipart from '@fastify/multipart';
import { UPLOAD_MAX_BYTES } from '@tribo/contract';
import type { UploadPart } from '@tribo/core';
import { ApiError } from '@tribo/platform';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** The one part of a form operation's body that carries the file (Operation.form). */
const FILE_FIELD = 'file';

const invalid = (path: string, message: string) =>
  new ApiError('validation_failed', { errors: [{ path, message }] });

/**
 * multipart/form-data for the operations that declare a form (decision 0021). Nothing is
 * buffered or written to disk here: the file part is handed on as a stream. Its limit is
 * one byte past the ceiling so the blob store's meter, not busboy's silent truncation,
 * decides file_too_large; a part busboy does cut is refused all the same.
 */
export async function registerMultipart(app: FastifyInstance) {
  await app.register(multipart, {
    limits: {
      fieldNameSize: 64,
      fieldSize: 1_024,
      fields: 8,
      fileSize: UPLOAD_MAX_BYTES + 1,
      files: 1,
      parts: 9,
      headerPairs: 64,
    },
  });
}

/**
 * Runs `use` with a form's text fields, which must come first, and its one `file` part.
 * Whatever `use` leaves unread is discarded, so the request always ends; parts after the
 * file are ignored.
 */
export async function withUpload<T>(
  request: FastifyRequest,
  use: (fields: Record<string, unknown>, file: UploadPart) => Promise<T>,
): Promise<T> {
  if (!request.isMultipart()) throw invalid('/', 'expected multipart/form-data');
  const fields = new Map<string, unknown>();
  for await (const part of request.parts()) {
    if (part.type === 'field') {
      if (part.fieldname === FILE_FIELD || fields.has(part.fieldname) || part.valueTruncated) {
        throw invalid(`/${part.fieldname}`, 'one short value per field, before the file');
      }
      fields.set(part.fieldname, part.value);
    } else if (part.fieldname !== FILE_FIELD) {
      throw invalid(`/${part.fieldname}`, `the file goes in a part named ${FILE_FIELD}`);
    } else {
      const content = part.file;
      content.once('limit', () => content.destroy(new ApiError('file_too_large')));
      try {
        return await use(Object.fromEntries(fields), {
          filename: part.filename,
          contentType: part.mimetype,
          content,
        });
      } finally {
        content.resume();
      }
    }
  }
  throw invalid(`/${FILE_FIELD}`, 'a file part is required');
}
