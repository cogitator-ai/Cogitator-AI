/**
 * Approval Store implementations
 *
 * Features:
 * - In-memory store for development/testing
 * - File-based store for persistence
 * - Response callbacks for async notifications
 * - TTL-based cleanup
 */

import type {
  ApprovalStore,
  ApprovalRequest,
  ApprovalResponse,
} from '@cogitator-ai/types';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * In-memory approval store for development and testing
 */
export class InMemoryApprovalStore implements ApprovalStore {
  private requests = new Map<string, ApprovalRequest>();
  private responses = new Map<string, ApprovalResponse>();
  private callbacks = new Map<string, Set<(response: ApprovalResponse) => void>>();
  private ttl: number;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(options: { ttl?: number; cleanupInterval?: number } = {}) {
    this.ttl = options.ttl ?? 7 * 24 * 60 * 60 * 1000;

    if (options.cleanupInterval) {
      this.cleanupInterval = setInterval(
        () => this.cleanup(),
        options.cleanupInterval
      );
    }
  }

  async createRequest(request: ApprovalRequest): Promise<void> {
    this.requests.set(request.id, { ...request });
  }

  async getRequest(id: string): Promise<ApprovalRequest | null> {
    return this.requests.get(id) ?? null;
  }

  async getPendingRequests(workflowId?: string): Promise<ApprovalRequest[]> {
    const pending: ApprovalRequest[] = [];

    for (const request of this.requests.values()) {
      if (this.responses.has(request.id)) continue;

      if (workflowId && request.workflowId !== workflowId) continue;

      pending.push(request);
    }

    return pending;
  }

  async getPendingForAssignee(assignee: string): Promise<ApprovalRequest[]> {
    const pending: ApprovalRequest[] = [];

    for (const request of this.requests.values()) {
      if (this.responses.has(request.id)) continue;

      const isAssigned =
        request.assignee === assignee ||
        request.assigneeGroup?.includes(assignee);

      if (isAssigned) {
        pending.push(request);
      }
    }

    return pending;
  }

  async submitResponse(response: ApprovalResponse): Promise<void> {
    this.responses.set(response.requestId, { ...response });

    const callbacks = this.callbacks.get(response.requestId);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(response);
        } catch {
        }
      }
      this.callbacks.delete(response.requestId);
    }
  }

  async getResponse(requestId: string): Promise<ApprovalResponse | null> {
    return this.responses.get(requestId) ?? null;
  }

  async deleteRequest(id: string): Promise<void> {
    this.requests.delete(id);
    this.responses.delete(id);
    this.callbacks.delete(id);
  }

  onResponse(
    requestId: string,
    callback: (response: ApprovalResponse) => void
  ): () => void {
    const existingResponse = this.responses.get(requestId);
    if (existingResponse) {
      queueMicrotask(() => callback(existingResponse));
      return () => {};
    }

    let callbacks = this.callbacks.get(requestId);
    if (!callbacks) {
      callbacks = new Set();
      this.callbacks.set(requestId, callbacks);
    }
    callbacks.add(callback);

    return () => {
      callbacks?.delete(callback);
      if (callbacks?.size === 0) {
        this.callbacks.delete(requestId);
      }
    };
  }

  /**
   * Clean up expired requests
   */
  private cleanup(): void {
    const now = Date.now();

    for (const [id, request] of this.requests) {
      if (now - request.createdAt > this.ttl) {
        this.deleteRequest(id);
      }
    }
  }

  /**
   * Stop cleanup interval
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  /**
   * Get all requests (for debugging)
   */
  getAllRequests(): ApprovalRequest[] {
    return Array.from(this.requests.values());
  }

  /**
   * Get all responses (for debugging)
   */
  getAllResponses(): ApprovalResponse[] {
    return Array.from(this.responses.values());
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.requests.clear();
    this.responses.clear();
    this.callbacks.clear();
  }
}

/**
 * File-based approval store for persistence across restarts
 */
export class FileApprovalStore implements ApprovalStore {
  private readonly directory: string;
  private callbacks = new Map<string, Set<(response: ApprovalResponse) => void>>();
  private watchInterval?: ReturnType<typeof setInterval>;
  private lastResponseCheck = new Map<string, number>();

  constructor(options: {
    directory: string;
    pollInterval?: number;
  }) {
    this.directory = options.directory;

    if (options.pollInterval) {
      this.watchInterval = setInterval(
        () => this.checkForResponses(),
        options.pollInterval
      );
    }
  }

  private getRequestPath(id: string): string {
    return path.join(this.directory, 'requests', `${id}.json`);
  }

  private getResponsePath(requestId: string): string {
    return path.join(this.directory, 'responses', `${requestId}.json`);
  }

  async createRequest(request: ApprovalRequest): Promise<void> {
    const filePath = this.getRequestPath(request.id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(request, null, 2), 'utf-8');
  }

  async getRequest(id: string): Promise<ApprovalRequest | null> {
    try {
      const content = await fs.readFile(this.getRequestPath(id), 'utf-8');
      return JSON.parse(content) as ApprovalRequest;
    } catch {
      return null;
    }
  }

  async getPendingRequests(workflowId?: string): Promise<ApprovalRequest[]> {
    const requestsDir = path.join(this.directory, 'requests');
    const responsesDir = path.join(this.directory, 'responses');

    try {
      await fs.mkdir(requestsDir, { recursive: true });
    } catch {
    }

    const pending: ApprovalRequest[] = [];

    try {
      const files = await fs.readdir(requestsDir);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const requestId = file.replace('.json', '');
        const responsePath = path.join(responsesDir, `${requestId}.json`);

        try {
          await fs.access(responsePath);
          continue;
        } catch {
        }

        try {
          const content = await fs.readFile(
            path.join(requestsDir, file),
            'utf-8'
          );
          const request = JSON.parse(content) as ApprovalRequest;

          if (!workflowId || request.workflowId === workflowId) {
            pending.push(request);
          }
        } catch {
        }
      }
    } catch {
    }

    return pending;
  }

  async getPendingForAssignee(assignee: string): Promise<ApprovalRequest[]> {
    const allPending = await this.getPendingRequests();

    return allPending.filter(
      (request) =>
        request.assignee === assignee ||
        request.assigneeGroup?.includes(assignee)
    );
  }

  async submitResponse(response: ApprovalResponse): Promise<void> {
    const filePath = this.getResponsePath(response.requestId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(response, null, 2), 'utf-8');

    const callbacks = this.callbacks.get(response.requestId);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(response);
        } catch {
        }
      }
      this.callbacks.delete(response.requestId);
    }
  }

  async getResponse(requestId: string): Promise<ApprovalResponse | null> {
    try {
      const content = await fs.readFile(
        this.getResponsePath(requestId),
        'utf-8'
      );
      return JSON.parse(content) as ApprovalResponse;
    } catch {
      return null;
    }
  }

  async deleteRequest(id: string): Promise<void> {
    try {
      await fs.unlink(this.getRequestPath(id));
    } catch {
    }

    try {
      await fs.unlink(this.getResponsePath(id));
    } catch {
    }

    this.callbacks.delete(id);
  }

  onResponse(
    requestId: string,
    callback: (response: ApprovalResponse) => void
  ): () => void {
    this.getResponse(requestId).then((existingResponse) => {
      if (existingResponse) {
        callback(existingResponse);
      }
    });

    let callbacks = this.callbacks.get(requestId);
    if (!callbacks) {
      callbacks = new Set();
      this.callbacks.set(requestId, callbacks);
    }
    callbacks.add(callback);

    return () => {
      callbacks?.delete(callback);
      if (callbacks?.size === 0) {
        this.callbacks.delete(requestId);
      }
    };
  }

  /**
   * Check for new responses (called by poll interval)
   */
  private async checkForResponses(): Promise<void> {
    const responsesDir = path.join(this.directory, 'responses');

    try {
      const files = await fs.readdir(responsesDir);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const requestId = file.replace('.json', '');
        const callbacks = this.callbacks.get(requestId);

        if (!callbacks || callbacks.size === 0) continue;

        const filePath = path.join(responsesDir, file);
        const stats = await fs.stat(filePath);
        const lastCheck = this.lastResponseCheck.get(requestId) ?? 0;

        if (stats.mtimeMs > lastCheck) {
          this.lastResponseCheck.set(requestId, stats.mtimeMs);

          const content = await fs.readFile(filePath, 'utf-8');
          const response = JSON.parse(content) as ApprovalResponse;

          for (const callback of callbacks) {
            try {
              callback(response);
            } catch {
            }
          }

          this.callbacks.delete(requestId);
        }
      }
    } catch {
    }
  }

  /**
   * Stop polling
   */
  dispose(): void {
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = undefined;
    }
  }

  /**
   * Clean up expired requests
   */
  async cleanup(maxAge: number): Promise<number> {
    const now = Date.now();
    let deleted = 0;

    const requestsDir = path.join(this.directory, 'requests');

    try {
      const files = await fs.readdir(requestsDir);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(requestsDir, file);

        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const request = JSON.parse(content) as ApprovalRequest;

          if (now - request.createdAt > maxAge) {
            const id = file.replace('.json', '');
            await this.deleteRequest(id);
            deleted++;
          }
        } catch {
        }
      }
    } catch {
    }

    return deleted;
  }
}

/**
 * Create an approval store that delegates responses
 * to another store (e.g., for delegation handling)
 */
export function withDelegation(
  store: ApprovalStore,
  options: {
    onDelegation?: (
      request: ApprovalRequest,
      from: string,
      to: string
    ) => Promise<void>;
  } = {}
): ApprovalStore {
  return {
    ...store,

    async submitResponse(response: ApprovalResponse): Promise<void> {
      if (response.delegatedTo) {
        const request = await store.getRequest(response.requestId);

        if (request) {
          const delegatedRequest: ApprovalRequest = {
            ...request,
            assignee: response.delegatedTo,
            metadata: {
              ...request.metadata,
              delegatedFrom: response.respondedBy,
              delegatedAt: response.respondedAt,
              delegationReason: response.delegationReason,
            },
          };

          await store.createRequest(delegatedRequest);

          await options.onDelegation?.(
            delegatedRequest,
            response.respondedBy,
            response.delegatedTo
          );

          return;
        }
      }

      await store.submitResponse(response);
    },
  };
}
