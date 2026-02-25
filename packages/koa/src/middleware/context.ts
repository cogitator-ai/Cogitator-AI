import type { Context, Next } from 'koa';
import type { CogitatorAppOptions, CogitatorState, RouteContext } from '../types.js';
import { generateId } from '@cogitator-ai/server-shared';

export function createContextMiddleware(opts: CogitatorAppOptions) {
  const routeCtx: RouteContext = {
    runtime: opts.cogitator,
    agents: opts.agents ?? {},
    workflows: opts.workflows ?? {},
    swarms: opts.swarms ?? {},
  };

  return async (ctx: Context, next: Next) => {
    const state = ctx.state as CogitatorState;
    state.cogitator = routeCtx;
    state.requestId = generateId('req');
    state.startTime = Date.now();
    await next();
  };
}
