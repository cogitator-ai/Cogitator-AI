/**
 * OpenAI-Compatible REST API Server
 *
 * Exposes Cogitator as an OpenAI Assistants API compatible server.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import type { Cogitator } from '@cogitator-ai/core';
import type { Tool } from '@cogitator-ai/types';
import type { ThreadStorage } from '../client/storage';
import { OpenAIAdapter, COGITATOR_MODEL_ID } from '../client/openai-adapter';
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

  /**
   * Cogitator model used for assistants/runs that request the advertised
   * `cogitator` model id (e.g. 'openai/gpt-4o', 'ollama/llama3.1')
   */
  defaultModel?: string;

  /** Maximum upload size for POST /v1/files in bytes (default: 512 MB) */
  maxFileSize?: number;

  /** Persistence backend (connect it before passing). Default: in-memory */
  storage?: ThreadStorage;

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
  private config: Required<Omit<OpenAIServerConfig, 'defaultModel' | 'storage'>> &
    Pick<OpenAIServerConfig, 'defaultModel' | 'storage'>;
  private adapter: OpenAIAdapter;
  private started = false;
  private ready: Promise<void>;
  private boundPort?: number;

  constructor(cogitator: Cogitator, config: OpenAIServerConfig = {}) {
    this.config = {
      port: config.port ?? 8080,
      host: config.host ?? '0.0.0.0',
      apiKeys: config.apiKeys ?? [],
      tools: config.tools ?? [],
      defaultModel: config.defaultModel,
      storage: config.storage,
      maxFileSize: config.maxFileSize ?? 512 * 1024 * 1024,
      logging: config.logging ?? false,
      cors: config.cors ?? { origin: true },
    };

    this.adapter = new OpenAIAdapter(cogitator, {
      tools: this.config.tools,
      defaultModel: this.config.defaultModel,
      storage: this.config.storage,
    });

    this.fastify = Fastify({
      logger: this.config.logging ? { level: 'info' } : false,
    });

    this.ready = this.setupServer();
    this.ready.catch(() => {});
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
        fileSize: this.config.maxFileSize,
      },
    });

    if (this.config.apiKeys.length > 0) {
      const authConfig: AuthConfig = {
        apiKeys: this.config.apiKeys,
        required: true,
        publicPaths: ['/health'],
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
          id: COGITATOR_MODEL_ID,
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

    await this.ready;
    await this.fastify.listen({
      port: this.config.port,
      host: this.config.host,
    });

    const address = this.fastify.server.address();
    this.boundPort = typeof address === 'object' && address ? address.port : this.config.port;
    this.started = true;

    if (this.config.logging) {
      this.fastify.log.info(`OpenAI-compatible API available at ${this.getBaseUrl()}`);
    }
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
  }

  /**
   * Get the server URL (uses the bound port, so `port: 0` works)
   */
  getUrl(): string {
    const host =
      this.config.host === '0.0.0.0' || this.config.host === '::' ? 'localhost' : this.config.host;
    const formattedHost = host.includes(':') ? `[${host}]` : host;
    return `http://${formattedHost}:${this.boundPort ?? this.config.port}`;
  }

  /**
   * Get the OpenAI-compatible base URL
   */
  getBaseUrl(): string {
    return `${this.getUrl()}/v1`;
  }

  /**
   * Resolves once all routes and plugins are registered (start() awaits it).
   * Useful for `fastify.inject`-style testing via {@link getFastify}.
   */
  async waitUntilReady(): Promise<void> {
    await this.ready;
    await this.fastify.ready();
  }

  /**
   * Get the underlying Fastify instance
   */
  getFastify(): FastifyInstance {
    return this.fastify;
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
