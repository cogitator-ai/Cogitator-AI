/**
 * Files API Routes
 *
 * Implements OpenAI Files API endpoints.
 */

import type { FastifyInstance } from 'fastify';
import type { OpenAIAdapter } from '../../client/openai-adapter';
import type { StoredFile } from '../../client/storage';
import type { FileObject, FilePurpose, ListResponse } from '../../types/openai-types';
import { sendInvalidRequest, sendNotFound } from './shared';

const FILE_PURPOSES: readonly FilePurpose[] = [
  'assistants',
  'assistants_output',
  'batch',
  'batch_output',
  'fine-tune',
  'fine-tune-results',
  'vision',
];

function isFilePurpose(value: unknown): value is FilePurpose {
  return typeof value === 'string' && (FILE_PURPOSES as readonly string[]).includes(value);
}

function toFileObject(file: StoredFile): FileObject {
  return {
    id: file.id,
    object: 'file',
    bytes: file.content.length,
    created_at: file.created_at,
    filename: file.filename,
    purpose: file.purpose ?? 'assistants',
    status: 'processed',
  };
}

/**
 * Content-Disposition value that is safe for any filename (RFC 6266 / 5987)
 */
function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

interface MultipartPart {
  type: 'file' | 'field';
  fieldname: string;
  filename?: string;
  file?: AsyncIterable<Buffer>;
  value?: unknown;
}

export function registerFileRoutes(fastify: FastifyInstance, adapter: OpenAIAdapter) {
  const threadManager = adapter.getThreadManager();

  fastify.post('/v1/files', async (request, reply) => {
    if (!request.isMultipart()) {
      return sendInvalidRequest(reply, 'Expected a multipart/form-data request');
    }

    const parts = (request as unknown as { parts(): AsyncIterableIterator<MultipartPart> }).parts();

    let fileContent: Buffer | null = null;
    let filename = 'file';
    let purpose: FilePurpose = 'assistants';

    for await (const part of parts) {
      if (part.type === 'file' && part.file) {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        if (part.fieldname === 'file') {
          fileContent = Buffer.concat(chunks);
          filename = part.filename ?? 'file';
        }
      } else if (part.type === 'field' && part.fieldname === 'purpose') {
        if (!isFilePurpose(part.value)) {
          return sendInvalidRequest(reply, `Invalid purpose: ${String(part.value)}`, 'purpose');
        }
        purpose = part.value;
      }
    }

    if (!fileContent) {
      return reply.status(400).send({
        error: {
          message: 'Missing file in request',
          type: 'invalid_request_error',
          code: 'missing_file',
        },
      });
    }

    const file = await threadManager.addFile(fileContent, filename, purpose);
    return reply.status(201).send(toFileObject({ ...file, content: fileContent }));
  });

  fastify.get<{ Querystring: { purpose?: string } }>('/v1/files', async (request, reply) => {
    const { purpose } = request.query;
    if (purpose !== undefined && !isFilePurpose(purpose)) {
      return sendInvalidRequest(reply, `Invalid purpose: ${purpose}`, 'purpose');
    }

    const files = await threadManager.listFiles();
    const data = files
      .map(toFileObject)
      .filter((file) => !purpose || file.purpose === purpose)
      .sort((a, b) => b.created_at - a.created_at);

    const response: ListResponse<FileObject> = {
      object: 'list',
      data,
      first_id: data[0]?.id,
      last_id: data[data.length - 1]?.id,
      has_more: false,
    };

    return reply.send(response);
  });

  fastify.get<{ Params: { file_id: string } }>('/v1/files/:file_id', async (request, reply) => {
    const file = await threadManager.getFile(request.params.file_id);
    if (!file) {
      return sendNotFound(reply, 'file', request.params.file_id);
    }
    return reply.send(toFileObject(file));
  });

  fastify.get<{ Params: { file_id: string } }>(
    '/v1/files/:file_id/content',
    async (request, reply) => {
      const file = await threadManager.getFile(request.params.file_id);
      if (!file) {
        return sendNotFound(reply, 'file', request.params.file_id);
      }

      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', contentDisposition(file.filename));
      return reply.send(file.content);
    }
  );

  fastify.delete<{ Params: { file_id: string } }>('/v1/files/:file_id', async (request, reply) => {
    const deleted = await threadManager.deleteFile(request.params.file_id);
    if (!deleted) {
      return sendNotFound(reply, 'file', request.params.file_id);
    }

    return reply.send({
      id: request.params.file_id,
      object: 'file',
      deleted: true,
    });
  });
}
