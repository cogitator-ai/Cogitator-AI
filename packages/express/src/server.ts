import { Router, json } from 'express';
import type { CogitatorServerConfig, RouteContext, CorsConfig, RateLimitConfig } from './types.js';
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

const DEFAULT_CONFIG = {
  basePath: '/cogitator',
  enableWebSocket: false,
  enableSwagger: true,
  requestTimeout: 30000,
};

export class CogitatorServer {
  private app: Router;
  private cogitator: CogitatorServerConfig['cogitator'];
  private agents: CogitatorServerConfig['agents'];
  private workflows: CogitatorServerConfig['workflows'];
  private swarms: CogitatorServerConfig['swarms'];
  private config: Required<NonNullable<CogitatorServerConfig['config']>>;
  private initialized = false;

  constructor(options: CogitatorServerConfig) {
    this.app = options.app;
    this.cogitator = options.cogitator;
    this.agents = options.agents || {};
    this.workflows = options.workflows || {};
    this.swarms = options.swarms || {};

    this.config = {
      ...DEFAULT_CONFIG,
      auth: options.config?.auth,
      rateLimit: options.config?.rateLimit as RateLimitConfig,
      cors: options.config?.cors as CorsConfig,
      swagger: options.config?.swagger || {},
      websocket: options.config?.websocket || {},
      ...options.config,
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
      agents: this.agents!,
      workflows: this.workflows!,
      swarms: this.swarms!,
      config: this.config,
    };

    router.use(createHealthRoutes(ctx));
    router.use(createAgentRoutes(ctx));
    router.use(createThreadRoutes(ctx));
    router.use(createToolRoutes(ctx));
    router.use(createWorkflowRoutes(ctx));
    router.use(createSwarmRoutes(ctx));

    if (this.config.enableSwagger) {
      await this.setupSwagger(router, ctx);
    }

    if (this.config.enableWebSocket) {
      console.log('[CogitatorServer] WebSocket support enabled but requires separate setup');
    }

    router.use(notFoundHandler);
    router.use(errorHandler);

    this.app.use(basePath, router);

    this.initialized = true;
    console.log(`[CogitatorServer] Initialized at ${basePath}`);
  }

  private async setupSwagger(router: Router, ctx: RouteContext): Promise<void> {
    try {
      const { generateOpenAPISpec, serveSwaggerUI } = await import('./swagger/index.js');
      const spec = generateOpenAPISpec(ctx, this.config.swagger || {});

      router.get('/openapi.json', (_req, res) => {
        res.json(spec);
      });

      router.get('/docs', serveSwaggerUI(spec));
    } catch {
      console.warn('[CogitatorServer] Swagger setup failed, continuing without docs');
    }
  }

  get isInitialized(): boolean {
    return this.initialized;
  }
}
