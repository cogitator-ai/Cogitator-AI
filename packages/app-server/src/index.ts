/**
 * The Cogitator app-server: threads, turns and reviews of a `Cogitator` over JSON-RPC 2.0, on
 * stdio as NDJSON, with a typed client generated from the protocol's Zod schemas.
 *
 * @example
 * ```ts
 * import { Agent, Cogitator } from '@cogitator-ai/core';
 * import { SessionHost, createAppServer, serveStdio } from '@cogitator-ai/app-server';
 *
 * const cogitator = new Cogitator({ memory: { adapter: 'sqlite', sqlite: { path: 'sessions.db' } } });
 * const host = new SessionHost({ cogitator, agents: { assistant: new Agent({ name: 'assistant', model: 'ollama/qwen3:8b', instructions: 'Help.' }) } });
 * await serveStdio(createAppServer(host));
 * await host.close();
 * ```
 *
 * @packageDocumentation
 */

export {
  SessionHost,
  type ApprovalAsk,
  type ApprovalAsker,
  type AppServerRunContext,
  type AppServerRunner,
  type SessionHostListener,
  type SessionHostOptions,
  type SessionHostReviewOptions,
  type TurnStartOptions,
} from './host/session-host.js';
export {
  MAX_REVIEW_CHANGES_CHARS,
  REVIEW_INSTRUCTIONS,
  gitReviewContext,
  reviewPrompt,
  type ReviewContextReader,
} from './host/review.js';
export { describeAppServerError } from './host/errors.js';
export {
  AppServer,
  AppServerConnection,
  createAppServer,
  type AppServerOptions,
  type AppServerSend,
} from './server/app-server.js';
export {
  OrderedLineWriter,
  serveStdio,
  type ServeStdioOptions,
  type StdioOutput,
} from './server/stdio.js';
export * from './codegen/index.js';
export * from './protocol/index.js';
