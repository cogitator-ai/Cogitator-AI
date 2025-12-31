/**
 * OpenAI-Compatible REST API Server
 *
 * Exposes Cogitator as an OpenAI Assistants API compatible server.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import type { Cogitator } from '@cogitator-ai/core';
import type { Tool } from '@cogitator-ai/types';
import { OpenAIAdapter } from '../client/openai-adapter';
import { createAuthMiddleware, type AuthConfig } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { registerAssistantRoutes } from './routes/assistants';
import { registerThreadRoutes } from './routes/threads';
import { registerRunRoutes } from './routes/runs';
import { registerFileRoutes } from './routes/files';

export interface OpenAIServerConfig {
  /** Port to listen on */
  port?: number;

  /** Host to bind to */
  host?: string;

  /** API keys for authentication. Empty array disables auth. */
  apiKeys?: string[];

  /** Tools to make available */
  tools?: Tool[];

  /** Enable request logging */
  logging?: boolean;

  /** CORS configuration */
  cors?: {
    origin?: string | string[] | boolean;
    methods?: string[];
  };
}

/**
 * OpenAI-Compatible API Server
 *
 * @example
 * ```typescript
 * import { Cogitator } from '@cogitator-ai/core';
 * import { createOpenAIServer } from '@cogitator-ai/openai-compat';
 *
 * const cogitator = new Cogitator({ ... });
 * const server = createOpenAIServer(cogitator, {
 *   port: 8080,
 *   tools: [calculator, datetime],
 * });
 *
 * await server.start();
 * // Server is now available at http://localhost:8080
 * // Use with OpenAI SDK:
 * // const openai = new OpenAI({ baseURL: 'http://localhost:8080/v1' });
 * ```
 */
export class OpenAIServer {
  private fastify: FastifyInstance;
  private config: Required<OpenAIServerConfig>;
  private adapter: OpenAIAdapter;
  private started = false;

  constructor(cogitator: Cogitator, config: OpenAIServerConfig = {}) {
    this.config = {
      port: config.port ?? 8080,
      host: config.host ?? '0.0.0.0',
      apiKeys: config.apiKeys ?? [],
      tools: config.tools ?? [],
      logging: config.logging ?? false,
      cors: config.cors ?? { origin: true },
    };

    this.adapter = new OpenAIAdapter(cogitator, { tools: this.config.tools });

    this.fastify = Fastify({
      logger: this.config.logging
        ? {
            level: 'info',
            transport: {
              target: 'pino-pretty',
              options: {
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
              },
            },
          }
        : false,
    });

    void this.setupServer();
  }

  /**
   * Set up the Fastify server
   */
  private async setupServer(): Promise<void> {
    await this.fastify.register(fastifyCors, {
      origin: this.config.cors.origin,
      methods: this.config.cors.methods ?? ['GET', 'POST', 'DELETE', 'OPTIONS'],
    });

    await this.fastify.register(import('@fastify/multipart'), {
      limits: {
        fileSize: 512 * 1024 * 1024,
      },
    });

    if (this.config.apiKeys.length > 0) {
      const authConfig: AuthConfig = {
        apiKeys: this.config.apiKeys,
        required: true,
      };
      this.fastify.addHook('preHandler', createAuthMiddleware(authConfig));
    }

    this.fastify.setErrorHandler(errorHandler);
    this.fastify.setNotFoundHandler(notFoundHandler);

    this.fastify.get('/health', async () => ({ status: 'ok' }));

    this.fastify.get('/v1/models', async () => ({
      object: 'list',
      data: [
        {
          id: 'cogitator',
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'cogitator',
        },
      ],
    }));

    registerAssistantRoutes(this.fastify, this.adapter);
    registerThreadRoutes(this.fastify, this.adapter);
    registerRunRoutes(this.fastify, this.adapter);
    registerFileRoutes(this.fastify, this.adapter);
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('Server already started');
    }

    await this.fastify.listen({
      port: this.config.port,
      host: this.config.host,
    });

    this.started = true;
    console.log(`[OpenAI Server] Listening on http://${this.config.host}:${this.config.port}`);
    console.log(
      `[OpenAI Server] Use with OpenAI SDK: baseURL = "http://localhost:${this.config.port}/v1"`
    );
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    await this.fastify.close();
    this.started = false;
    console.log('[OpenAI Server] Stopped');
  }

  /**
   * Get the server URL
   */
  getUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  /**
   * Get the OpenAI-compatible base URL
   */
  getBaseUrl(): string {
    return `http://${this.config.host}:${this.config.port}/v1`;
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.started;
  }

  /**
   * Get the underlying adapter
   */
  getAdapter(): OpenAIAdapter {
    return this.adapter;
  }
}

/**
 * Create an OpenAI-compatible server
 */
export function createOpenAIServer(
  cogitator: Cogitator,
  config?: OpenAIServerConfig
): OpenAIServer {
  return new OpenAIServer(cogitator, config);
}
