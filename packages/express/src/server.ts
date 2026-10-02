import { Router, json } from 'express';
import type { Server as HttpServer } from 'http';
import type { CogitatorServerConfig, RouteContext } from './types.js';
import {
  createAuthMiddleware,
  createRateLimitMiddleware,
  createCorsMiddleware,
  errorHandler,
  notFoundHandler,
} from './middleware/index.js';
import {
  createHealthRoutes,
  createAgentRoutes,
  createThreadRoutes,
  createToolRoutes,
  createWorkflowRoutes,
  createSwarmRoutes,
} from './routes/index.js';
import { generateOpenAPISpec, serveSwaggerUI } from './swagger/index.js';
import { setupWebSocket } from './websocket/index.js';

const DEFAULT_CONFIG = {
  basePath: '/cogitator',
  enableWebSocket: false,
  enableSwagger: true,
};

export class CogitatorServer {
  private app: Router;
  private cogitator: CogitatorServerConfig['cogitator'];
  private agents: NonNullable<CogitatorServerConfig['agents']>;
  private workflows: NonNullable<CogitatorServerConfig['workflows']>;
  private swarms: NonNullable<CogitatorServerConfig['swarms']>;
  private config: Required<NonNullable<CogitatorServerConfig['config']>>;
  private routeContext: RouteContext | null = null;
  private initialized = false;

  constructor(options: CogitatorServerConfig) {
    this.app = options.app;
    this.cogitator = options.cogitator;
    this.agents = options.agents || {};
    this.workflows = options.workflows || {};
    this.swarms = options.swarms || {};

    const cfg = options.config ?? {};
    this.config = {
      ...DEFAULT_CONFIG,
      ...cfg,
      auth: cfg.auth,
      rateLimit: cfg.rateLimit,
      cors: cfg.cors,
      swagger: cfg.swagger ?? {},
      websocket: cfg.websocket ?? {},
    } as Required<NonNullable<CogitatorServerConfig['config']>>;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const router = Router();
    const basePath = this.config.basePath;

    router.use(json());

    if (this.config.cors) {
      router.use(createCorsMiddleware(this.config.cors));
    }

    router.use(createAuthMiddleware(this.config.auth));

    if (this.config.rateLimit) {
      router.use(createRateLimitMiddleware(this.config.rateLimit));
    }

    const ctx: RouteContext = {
      cogitator: this.cogitator,
      agents: this.agents,
      workflows: this.workflows,
      swarms: this.swarms,
      config: this.config,
    };
    this.routeContext = ctx;

    router.use(createHealthRoutes(ctx));
    router.use(createAgentRoutes(ctx));
    router.use(createThreadRoutes(ctx));
    router.use(createToolRoutes(ctx));
    router.use(createWorkflowRoutes(ctx));
    router.use(createSwarmRoutes(ctx));

    if (this.config.enableSwagger) {
      this.setupSwagger(router, ctx);
    }

    router.use(notFoundHandler);
    router.use(errorHandler);

    this.app.use(basePath, router);

    this.initialized = true;
    console.log(`[CogitatorServer] Initialized at ${basePath}`);
  }

  private setupSwagger(router: Router, ctx: RouteContext): void {
    const spec = generateOpenAPISpec(ctx, this.config.swagger);

    router.get('/openapi.json', (_req, res) => {
      res.json(spec);
    });

    router.get('/docs', serveSwaggerUI(spec));
  }

  /**
   * Attach the WebSocket endpoint (`<basePath>/ws` by default) to an HTTP server.
   * Requires `config.enableWebSocket: true` and a prior `init()` call.
   * The configured `auth` function is applied to the upgrade request.
   */
  async attachWebSocket(server: HttpServer): Promise<import('ws').WebSocketServer> {
    if (!this.config.enableWebSocket) {
      throw new Error('WebSocket support is disabled; set config.enableWebSocket to true');
    }
    if (!this.routeContext) {
      throw new Error('CogitatorServer.init() must be called before attachWebSocket()');
    }
    const wss = await setupWebSocket(server, this.routeContext, this.config.websocket);
    if (!wss) {
      throw new Error("WebSocket support requires the 'ws' package: pnpm add ws");
    }
    return wss;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }
}
