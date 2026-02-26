/**
 * Files API Routes
 *
 * Implements OpenAI Files API endpoints.
 */

import type { FastifyInstance } from 'fastify';
import type { OpenAIAdapter } from '../../client/openai-adapter';
import type { FileObject, FilePurpose, ListResponse } from '../../types/openai-types';

export function registerFileRoutes(fastify: FastifyInstance, adapter: OpenAIAdapter) {
  const threadManager = adapter.getThreadManager();

  fastify.post('/v1/files', async (request, reply) => {
    const parts = (
      request as {
        parts(): AsyncIterableIterator<{
          type: 'file' | 'field';
          fieldname: string;
          filename?: string;
          file?: AsyncIterable<Buffer>;
          value?: string;
        }>;
      }
    ).parts();

    let fileContent: Buffer | null = null;
    let filename = 'file';
    let purpose: FilePurpose = 'assistants';

    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'file' && part.file) {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        fileContent = Buffer.concat(chunks);
        filename = part.filename ?? 'file';
      } else if (part.type === 'field' && part.fieldname === 'purpose') {
        purpose = part.value as FilePurpose;
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

    const file = await threadManager.addFile(fileContent, filename);

    const response: FileObject = {
      id: file.id,
      object: 'file',
      bytes: fileContent.length,
      created_at: file.created_at,
      filename: file.filename,
      purpose,
      status: 'processed',
    };

    return reply.status(201).send(response);
  });

  fastify.get<{ Querystring: { purpose?: FilePurpose } }>('/v1/files', async (_request, reply) => {
    const files = await threadManager.listFiles();

    const data: FileObject[] = files.map((file) => ({
      id: file.id,
      object: 'file' as const,
      bytes: file.content.length,
      created_at: file.created_at,
      filename: file.filename,
      purpose: 'assistants' as FilePurpose,
      status: 'processed' as const,
    }));

    const response: ListResponse<FileObject> = {
      object: 'list',
      data,
      has_more: false,
    };

    return reply.send(response);
  });

  fastify.get<{ Params: { file_id: string } }>('/v1/files/:file_id', async (request, reply) => {
    const file = await threadManager.getFile(request.params.file_id);

    if (!file) {
      return reply.status(404).send({
        error: {
          message: `No file found with id '${request.params.file_id}'`,
          type: 'invalid_request_error',
          code: 'not_found',
        },
      });
    }

    const response: FileObject = {
      id: file.id,
      object: 'file',
      bytes: file.content.length,
      created_at: file.created_at,
      filename: file.filename,
      purpose: 'assistants',
      status: 'processed',
    };

    return reply.send(response);
  });

  fastify.get<{ Params: { file_id: string } }>(
    '/v1/files/:file_id/content',
    async (request, reply) => {
      const file = await threadManager.getFile(request.params.file_id);

      if (!file) {
        return reply.status(404).send({
          error: {
            message: `No file found with id '${request.params.file_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${file.filename}"`);
      return reply.send(file.content);
    }
  );

  fastify.delete<{ Params: { file_id: string } }>('/v1/files/:file_id', async (request, reply) => {
    const deleted = await threadManager.deleteFile(request.params.file_id);

    if (!deleted) {
      return reply.status(404).send({
        error: {
          message: `No file found with id '${request.params.file_id}'`,
          type: 'invalid_request_error',
          code: 'not_found',
        },
      });
    }

    return reply.send({
      id: request.params.file_id,
      object: 'file',
      deleted: true,
    });
  });
}
