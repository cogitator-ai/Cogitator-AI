/**
 * Webhook Trigger
 *
 * HTTP-based workflow triggers with authentication,
 * rate limiting, payload validation, and deduplication.
 */

import { nanoid } from 'nanoid';
import * as crypto from 'node:crypto';
import type {
  WebhookTriggerConfig,
  WebhookAuthConfig,
  TriggerContext,
  WorkflowTrigger,
} from '@cogitator-ai/types';
import { type RateLimiter, createRateLimiter } from './rate-limiter';

/**
 * Incoming webhook request
 */
export interface WebhookRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, string>;
  ip?: string;
}

/**
 * Webhook response
 */
export interface WebhookResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * Webhook trigger state
 */
export interface WebhookTriggerState {
  triggerId: string;
  workflowName: string;
  config: WebhookTriggerConfig;
  triggerCount: number;
  errorCount: number;
  lastTriggered?: number;
  lastError?: string;
  enabled: boolean;
  createdAt: number;
}

/**
 * Webhook handler result
 */
export interface WebhookHandlerResult {
  triggered: boolean;
  runId?: string;
  response: WebhookResponse;
}

/**
 * Authentication error
 */
export class WebhookAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookAuthError';
  }
}

/**
 * Rate limit error
 */
export class WebhookRateLimitError extends Error {
  readonly retryAfter: number;
  readonly remaining: number;
  readonly resetAt: number;

  constructor(retryAfter: number, remaining: number, resetAt: number) {
    super('Rate limit exceeded');
    this.name = 'WebhookRateLimitError';
    this.retryAfter = retryAfter;
    this.remaining = remaining;
    this.resetAt = resetAt;
  }
}

/**
 * Webhook trigger executor
 */
export class WebhookTriggerExecutor {
  private triggers = new Map<string, WebhookTriggerState>();
  private triggersByPath = new Map<string, Map<string, WebhookTriggerState>>();
  private rateLimiters = new Map<string, RateLimiter>();
  private deduplicationCache = new Map<string, number>();
  private cleanupInterval?: ReturnType<typeof setInterval>;
  private onFire?: (trigger: WorkflowTrigger, context: TriggerContext) => Promise<string>;

  constructor(options: {
    onFire?: (trigger: WorkflowTrigger, context: TriggerContext) => Promise<string>;
    cleanupIntervalMs?: number;
  } = {}) {
    this.onFire = options.onFire;

    const cleanupMs = options.cleanupIntervalMs ?? 60000;
    this.cleanupInterval = setInterval(() => {
      this.cleanupDeduplicationCache();
    }, cleanupMs);
  }

  /**
   * Register a webhook trigger
   */
  register(
    workflowName: string,
    config: WebhookTriggerConfig,
    externalId?: string
  ): string {
    const triggerId = externalId ?? nanoid();
    const now = Date.now();

    const state: WebhookTriggerState = {
      triggerId,
      workflowName,
      config,
      triggerCount: 0,
      errorCount: 0,
      enabled: true,
      createdAt: now,
    };

    this.triggers.set(triggerId, state);

    const pathKey = this.normalizePathKey(config.path, config.method);
    let pathTriggers = this.triggersByPath.get(pathKey);
    if (!pathTriggers) {
      pathTriggers = new Map();
      this.triggersByPath.set(pathKey, pathTriggers);
    }
    pathTriggers.set(triggerId, state);

    if (config.rateLimit) {
      const rateLimiter = createRateLimiter({
        capacity: config.rateLimit.requests,
        window: config.rateLimit.window,
        burstLimit: config.rateLimit.burstLimit,
      });
      this.rateLimiters.set(triggerId, rateLimiter);
    }

    return triggerId;
  }

  /**
   * Unregister a trigger
   */
  unregister(triggerId: string): void {
    const state = this.triggers.get(triggerId);
    if (!state) return;

    const pathKey = this.normalizePathKey(state.config.path, state.config.method);
    const pathTriggers = this.triggersByPath.get(pathKey);
    if (pathTriggers) {
      pathTriggers.delete(triggerId);
      if (pathTriggers.size === 0) {
        this.triggersByPath.delete(pathKey);
      }
    }

    const rateLimiter = this.rateLimiters.get(triggerId);
    if (rateLimiter) {
      rateLimiter.dispose();
      this.rateLimiters.delete(triggerId);
    }

    this.triggers.delete(triggerId);
  }

  /**
   * Enable a trigger
   */
  enable(triggerId: string): void {
    const state = this.triggers.get(triggerId);
    if (!state) throw new Error(`Trigger not found: ${triggerId}`);
    state.enabled = true;
  }

  /**
   * Disable a trigger
   */
  disable(triggerId: string): void {
    const state = this.triggers.get(triggerId);
    if (!state) throw new Error(`Trigger not found: ${triggerId}`);
    state.enabled = false;
  }

  /**
   * Handle an incoming webhook request
   */
  async handle(request: WebhookRequest): Promise<WebhookHandlerResult | null> {
    const pathKey = this.normalizePathKey(request.path, request.method);
    const pathTriggers = this.triggersByPath.get(pathKey);

    if (!pathTriggers || pathTriggers.size === 0) {
      return null;
    }

    const trigger = Array.from(pathTriggers.values()).find(t => t.enabled);
    if (!trigger) {
      return null;
    }

    return this.handleTrigger(trigger, request);
  }

  /**
   * Handle a specific trigger
   */
  async handleTrigger(
    state: WebhookTriggerState,
    request: WebhookRequest
  ): Promise<WebhookHandlerResult> {
    const config = state.config;

    try {
      await this.authenticate(request, config.auth);

      const clientKey = this.getClientKey(request);
      this.checkRateLimit(state.triggerId, clientKey);

      if (config.deduplicationKey && config.deduplicationWindow) {
        const dedupKey = config.deduplicationKey(request.body);
        if (this.isDuplicate(state.triggerId, dedupKey, config.deduplicationWindow)) {
          return {
            triggered: false,
            response: {
              status: 200,
              body: { deduplicated: true, message: 'Request already processed' },
            },
          };
        }
      }

      if (config.validatePayload && !config.validatePayload(request.body)) {
        return {
          triggered: false,
          response: {
            status: 400,
            body: { error: 'Invalid payload' },
          },
        };
      }

      const payload = config.transformPayload
        ? config.transformPayload(request.body)
        : request.body;

      const context: TriggerContext = {
        triggerId: state.triggerId,
        triggerType: 'webhook',
        timestamp: Date.now(),
        payload,
        headers: this.normalizeHeaders(request.headers),
        metadata: {
          path: request.path,
          method: request.method,
          query: request.query,
          ip: request.ip,
        },
      };

      state.lastTriggered = Date.now();
      state.triggerCount++;

      const workflowTrigger = this.toWorkflowTrigger(state);
      const runId = await this.onFire?.(workflowTrigger, context);

      return {
        triggered: true,
        runId,
        response: {
          status: 202,
          body: {
            accepted: true,
            runId,
            triggerId: state.triggerId,
          },
        },
      };
    } catch (error) {
      state.errorCount++;
      state.lastError = error instanceof Error ? error.message : String(error);

      if (error instanceof WebhookAuthError) {
        return {
          triggered: false,
          response: {
            status: 401,
            body: { error: 'Unauthorized' },
          },
        };
      }

      if (error instanceof WebhookRateLimitError) {
        return {
          triggered: false,
          response: {
            status: 429,
            headers: {
              'Retry-After': String(Math.ceil(error.retryAfter / 1000)),
              'X-RateLimit-Remaining': String(error.remaining),
              'X-RateLimit-Reset': String(Math.ceil(error.resetAt / 1000)),
            },
            body: { error: 'Rate limit exceeded', retryAfter: error.retryAfter },
          },
        };
      }

      return {
        triggered: false,
        response: {
          status: 500,
          body: { error: 'Internal server error' },
        },
      };
    }
  }

  /**
   * Get trigger state
   */
  getState(triggerId: string): WebhookTriggerState | undefined {
    return this.triggers.get(triggerId);
  }

  /**
   * Get all triggers for a workflow
   */
  getTriggersForWorkflow(workflowName: string): WebhookTriggerState[] {
    return Array.from(this.triggers.values()).filter(
      t => t.workflowName === workflowName
    );
  }

  /**
   * Get all enabled triggers
   */
  getEnabledTriggers(): WebhookTriggerState[] {
    return Array.from(this.triggers.values()).filter(t => t.enabled);
  }

  /**
   * Get all triggers
   */
  getAll(): WebhookTriggerState[] {
    return Array.from(this.triggers.values());
  }

  /**
   * Get registered paths
   */
  getRegisteredPaths(): { path: string; method: string; triggerId: string }[] {
    const paths: { path: string; method: string; triggerId: string }[] = [];

    for (const state of this.triggers.values()) {
      paths.push({
        path: state.config.path,
        method: state.config.method,
        triggerId: state.triggerId,
      });
    }

    return paths;
  }

  /**
   * Dispose the executor
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    for (const rateLimiter of this.rateLimiters.values()) {
      rateLimiter.dispose();
    }

    this.rateLimiters.clear();
    this.triggers.clear();
    this.triggersByPath.clear();
    this.deduplicationCache.clear();
  }

  private async authenticate(
    request: WebhookRequest,
    auth?: WebhookAuthConfig
  ): Promise<void> {
    if (!auth || auth.type === 'none') {
      return;
    }

    const authHeader = this.getHeader(request.headers, 'authorization');
    const customHeader = auth.headerName
      ? this.getHeader(request.headers, auth.headerName)
      : undefined;

    switch (auth.type) {
      case 'bearer': {
        if (!authHeader?.startsWith('Bearer ')) {
          throw new WebhookAuthError('Missing or invalid Bearer token');
        }
        const token = authHeader.slice(7);
        if (token !== auth.secret) {
          throw new WebhookAuthError('Invalid token');
        }
        break;
      }

      case 'basic': {
        if (!authHeader?.startsWith('Basic ')) {
          throw new WebhookAuthError('Missing or invalid Basic auth');
        }
        const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
        if (credentials !== auth.secret) {
          throw new WebhookAuthError('Invalid credentials');
        }
        break;
      }

      case 'hmac': {
        const signature = customHeader ?? this.getHeader(request.headers, 'x-signature');
        if (!signature || !auth.secret) {
          throw new WebhookAuthError('Missing signature');
        }

        const algorithm = auth.algorithm === 'sha512' ? 'sha512' : 'sha256';
        const payload = typeof request.body === 'string'
          ? request.body
          : JSON.stringify(request.body);

        const expectedSignature = crypto
          .createHmac(algorithm, auth.secret)
          .update(payload)
          .digest('hex');

        const actualSignature = signature.replace(/^sha(256|512)=/, '');

        if (!crypto.timingSafeEqual(
          Buffer.from(actualSignature),
          Buffer.from(expectedSignature)
        )) {
          throw new WebhookAuthError('Invalid signature');
        }
        break;
      }

      case 'api-key': {
        const headerName = auth.headerName ?? 'x-api-key';
        const apiKey = this.getHeader(request.headers, headerName);
        if (!apiKey || apiKey !== auth.secret) {
          throw new WebhookAuthError('Invalid API key');
        }
        break;
      }

      default:
        throw new WebhookAuthError(`Unknown auth type: ${auth.type}`);
    }
  }

  private checkRateLimit(triggerId: string, clientKey: string): void {
    const rateLimiter = this.rateLimiters.get(triggerId);
    if (!rateLimiter) return;

    const result = rateLimiter.consume(clientKey);
    if (!result.allowed) {
      throw new WebhookRateLimitError(
        result.retryAfter ?? 0,
        result.remaining,
        result.resetAt
      );
    }
  }

  private isDuplicate(
    triggerId: string,
    dedupKey: string,
    windowMs: number
  ): boolean {
    const cacheKey = `${triggerId}:${dedupKey}`;
    const existing = this.deduplicationCache.get(cacheKey);

    if (existing && Date.now() - existing < windowMs) {
      return true;
    }

    this.deduplicationCache.set(cacheKey, Date.now());
    return false;
  }

  private cleanupDeduplicationCache(): void {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000;

    for (const [key, timestamp] of this.deduplicationCache) {
      if (now - timestamp > maxAge) {
        this.deduplicationCache.delete(key);
      }
    }
  }

  private normalizePathKey(path: string, method: string): string {
    return `${method.toUpperCase()}:${path.toLowerCase()}`;
  }

  private getClientKey(request: WebhookRequest): string {
    return request.ip ?? 'unknown';
  }

  private getHeader(
    headers: Record<string, string | string[] | undefined>,
    name: string
  ): string | undefined {
    const value = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  private normalizeHeaders(
    headers: Record<string, string | string[] | undefined>
  ): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) {
        normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      }
    }
    return normalized;
  }

  private toWorkflowTrigger(state: WebhookTriggerState): WorkflowTrigger {
    return {
      id: state.triggerId,
      workflowName: state.workflowName,
      type: 'webhook',
      config: state.config,
      enabled: state.enabled,
      createdAt: state.createdAt,
      lastTriggered: state.lastTriggered,
      triggerCount: state.triggerCount,
      errorCount: state.errorCount,
      lastError: state.lastError,
    };
  }
}

/**
 * Create a webhook trigger executor
 */
export function createWebhookTrigger(options: {
  onFire?: (trigger: WorkflowTrigger, context: TriggerContext) => Promise<string>;
} = {}): WebhookTriggerExecutor {
  return new WebhookTriggerExecutor(options);
}

/**
 * Validate a webhook trigger config
 */
export function validateWebhookTriggerConfig(config: WebhookTriggerConfig): string[] {
  const errors: string[] = [];

  if (!config.path) {
    errors.push('Path is required');
  } else if (!config.path.startsWith('/')) {
    errors.push('Path must start with /');
  }

  const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  if (!validMethods.includes(config.method)) {
    errors.push(`Invalid method: ${config.method}`);
  }

  if (config.auth) {
    const validAuthTypes = ['bearer', 'basic', 'hmac', 'api-key', 'none'];
    if (!validAuthTypes.includes(config.auth.type)) {
      errors.push(`Invalid auth type: ${config.auth.type}`);
    }
    if (config.auth.type !== 'none' && !config.auth.secret) {
      errors.push('Auth secret is required for non-none auth types');
    }
  }

  if (config.rateLimit) {
    if (config.rateLimit.requests < 1) {
      errors.push('Rate limit requests must be at least 1');
    }
    if (config.rateLimit.window < 1000) {
      errors.push('Rate limit window must be at least 1000ms');
    }
  }

  return errors;
}
