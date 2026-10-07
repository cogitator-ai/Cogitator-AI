/**
 * OpenAI-Compatible REST API Server
 *
 * Exposes registered Cogitator agents over the Chat Completions and Responses APIs, and the
 * deprecated Assistants API.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import type { Cogitator } from '@cogitator-ai/core';
import type { Agent, Tool } from '@cogitator-ai/types';
import { resolveSseHeartbeatMs } from '@cogitator-ai/server-shared';
import type { ThreadStorage } from '../client/storage';
import { OpenAIAdapter } from '../client/openai-adapter';
import { createAuthMiddleware, type AuthConfig } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { registerAssistantRoutes } from './routes/assistants';
import { registerThreadRoutes } from './routes/threads';
import { registerRunRoutes } from './routes/runs';
import { registerFileRoutes } from './routes/files';
import { registerChatCompletionRoutes } from './routes/chat-completions';
import { registerResponseRoutes, ResponseStore } from './routes/responses';
import { registerModelRoutes } from './routes/models';
import { AgentTurnRunner } from './agents/agent-turn';
import { AgentDirectory } from './agents/shared';

export interface OpenAIServerConfig {
  /** Port to listen on */
  port?: number;

  /**
   * Host to bind to. Default: `127.0.0.1`, reachable from this machine only. Binding a
   * public interface (`0.0.0.0`, `::` or an external address) needs `apiKeys`, or
   * `allowUnauthenticatedPublicAccess`.
   */
  host?: string;

  /**
   * API keys for authentication. Without keys every caller may create assistants with any
   * instructions and run the server's tools, so `start()` refuses a public `host` unless
   * `allowUnauthenticatedPublicAccess` is set.
   */
  apiKeys?: string[];

  /**
   * Serve a public `host` without `apiKeys`, for a server behind a gateway that
   * authenticates callers itself. Default: `false`.
   */
  allowUnauthenticatedPublicAccess?: boolean;

  /**
   * How often a run stream writes an SSE comment while the run is silent, in milliseconds,
   * so a proxy or load balancer does not cut a run that waits on a slow tool. Default: 5000.
   * `0` turns heartbeats off.
   */
  sseHeartbeatMs?: number;

  /**
   * Agents served by `POST /v1/chat/completions` and `POST /v1/responses`, by the model id
   * clients send (and `GET /v1/models` lists). Each answers with its own instructions, model and
   * tools, and functions a client declares in `tools` come back to it as tool calls.
   */
  agents?: Record<string, Agent>;

  /** Largest request body `POST /v1/chat/completions` and `POST /v1/responses` accept, in bytes (default: 20 MB) */
  maxRequestBodyBytes?: number;

  /** How many responses `POST /v1/responses` keeps in memory for `previous_response_id` and `GET` (default: 1000) */
  maxStoredResponses?: number;

  /** Tools every Assistants API run can use */
  tools?: Tool[];

  /**
   * Cogitator model used for assistants/runs that request the advertised
   * `cogitator` model id (e.g. 'openai/gpt-6.1-sol', 'ollama/qwen3:8b')
   */
  defaultModel?: string;

  /** Maximum upload size for POST /v1/files in bytes (default: 512 MB) */
  maxFileSize?: number;

  /** Persistence backend (connect it before passing). Default: in-memory */
  storage?: ThreadStorage;

  /** Enable request logging */
  logging?: boolean;

  /**
   * CORS for browsers on other origins. Default: none, so a web page on another origin
   * cannot call the server from a visitor's browser. Set `origin` to the origins that may.
   */
  cors?: {
    origin?: string | string[] | boolean;
    methods?: string[];
  };
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '::1', '[::1]']);

/** True for a host only this machine can reach: `localhost`, `::1` or `127.0.0.0/8` */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase()) || /^127(?:\.\d{1,3}){3}$/.test(host);
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
 *   agents: { support: supportAgent },
 * });
 *
 * await server.start();
 * const openai = new OpenAI({ baseURL: server.getBaseUrl(), apiKey: 'unused' });
 * const completion = await openai.chat.completions.create({
 *   model: 'support',
 *   messages: [{ role: 'user', content: 'Hi' }],
 * });
 * ```
 */
export class OpenAIServer {
  private fastify: FastifyInstance;
  private config: Required<Omit<OpenAIServerConfig, 'defaultModel' | 'storage' | 'cors'>> &
    Pick<OpenAIServerConfig, 'defaultModel' | 'storage' | 'cors'>;
  private adapter: OpenAIAdapter;
  private agentRunner: AgentTurnRunner;
  private directory: AgentDirectory;
  private responses: ResponseStore;
  private started = false;
  private ready: Promise<void>;
  private boundPort?: number;

  constructor(cogitator: Cogitator, config: OpenAIServerConfig = {}) {
    this.config = {
      port: config.port ?? 8080,
      host: config.host ?? '127.0.0.1',
      apiKeys: config.apiKeys ?? [],
      allowUnauthenticatedPublicAccess: config.allowUnauthenticatedPublicAccess ?? false,
      sseHeartbeatMs: resolveSseHeartbeatMs(config.sseHeartbeatMs),
      agents: config.agents ?? {},
      maxRequestBodyBytes: config.maxRequestBodyBytes ?? 20 * 1024 * 1024,
      maxStoredResponses: config.maxStoredResponses ?? 1000,
      tools: config.tools ?? [],
      defaultModel: config.defaultModel,
      storage: config.storage,
      maxFileSize: config.maxFileSize ?? 512 * 1024 * 1024,
      logging: config.logging ?? false,
      cors: config.cors,
    };

    this.adapter = new OpenAIAdapter(cogitator, {
      tools: this.config.tools,
      defaultModel: this.config.defaultModel,
      storage: this.config.storage,
    });
    this.directory = new AgentDirectory(this.config.agents);
    this.agentRunner = new AgentTurnRunner(cogitator);
    this.responses = new ResponseStore(this.config.maxStoredResponses);

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
    if (this.config.cors) {
      await this.fastify.register(fastifyCors, {
        origin: this.config.cors.origin ?? false,
        methods: this.config.cors.methods ?? ['GET', 'POST', 'DELETE', 'OPTIONS'],
      });
    }

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

    registerModelRoutes(this.fastify, this.directory);
    registerChatCompletionRoutes(this.fastify, {
      directory: this.directory,
      runner: this.agentRunner,
      heartbeatMs: this.config.sseHeartbeatMs,
      bodyLimit: this.config.maxRequestBodyBytes,
    });
    registerResponseRoutes(this.fastify, {
      directory: this.directory,
      runner: this.agentRunner,
      store: this.responses,
      heartbeatMs: this.config.sseHeartbeatMs,
      bodyLimit: this.config.maxRequestBodyBytes,
    });

    registerAssistantRoutes(this.fastify, this.adapter);
    registerThreadRoutes(this.fastify, this.adapter);
    registerRunRoutes(this.fastify, this.adapter, { heartbeatMs: this.config.sseHeartbeatMs });
    registerFileRoutes(this.fastify, this.adapter);
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('Server already started');
    }
    if (
      this.config.apiKeys.length === 0 &&
      !this.config.allowUnauthenticatedPublicAccess &&
      !isLoopbackHost(this.config.host)
    ) {
      throw new Error(
        `Refusing to serve ${this.config.host} without apiKeys: anyone who can reach it could ` +
          'create assistants and run the server tools. Set apiKeys, bind a loopback host such as ' +
          '127.0.0.1, or set allowUnauthenticatedPublicAccess when a gateway authenticates callers.'
      );
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
