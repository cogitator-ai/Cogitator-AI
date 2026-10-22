import type Router from '@koa/router';
import type { RouterContext } from '@koa/router';
import type { Context, Middleware, Next } from 'koa';
import type { CogitatorState } from '../types.js';
import { notFound } from '../utils/errors.js';

/** The name of the route that answers what no other route of the router serves */
const UNMATCHED_ROUTE = 'cogitator:unmatched';

/**
 * A path that matches every request, in the syntax of each path-to-regexp major `@koa/router`
 * has shipped with: 8 first, then 6. A router compiles a path when it is registered and throws
 * on the syntax of the other one.
 */
const ANY_PATH = ['{/*rest}', '(.*)'] as const;

/** Whether a route of the router other than the unmatched one serves the request */
function servedByRoute(ctx: Context): boolean {
  const matched = (ctx as Context & Pick<RouterContext, 'matched'>).matched ?? [];
  return matched.some(
    (layer) => layer.name !== UNMATCHED_ROUTE && layer.methods.includes(ctx.method)
  );
}

/**
 * `middleware`, for the requests a route of the router serves. Any other request passes
 * through untouched, so the middleware downstream of the router gets it as it came.
 */
export function forRoutes(middleware: Middleware): Middleware {
  return (ctx, next) => (servedByRoute(ctx) ? middleware(ctx, next) : next());
}

/**
 * The methods the routes of the router serve on the request's path, besides the unmatched one,
 * with `HEAD` wherever `GET` is served and `OPTIONS`; none when no route serves the path
 */
function allowedMethods(ctx: Context): string[] {
  const matched = (ctx as Context & Pick<RouterContext, 'matched'>).matched ?? [];
  const methods = new Set(
    matched.filter((layer) => layer.name !== UNMATCHED_ROUTE).flatMap((layer) => layer.methods)
  );
  if (methods.size === 0) return [];
  if (methods.has('GET')) methods.add('HEAD');
  methods.add('OPTIONS');
  return [...methods].sort();
}

function unanswered(ctx: Context): boolean {
  return ctx.respond !== false && !ctx.headerSent && ctx.status === 404 && ctx.body == null;
}

async function runChain(chain: readonly Middleware[], ctx: Context, last: () => void) {
  const dispatch = async (at: number): Promise<void> => {
    const middleware = chain[at];
    if (middleware) await middleware(ctx, () => dispatch(at + 1));
    else last();
  };
  await dispatch(0);
}

/**
 * Registers the last route of the router, the one for the requests no other route serves. It
 * lets the middleware downstream of the router answer them first. What is left unanswered goes
 * through `guards`, the authentication and anonymous policy of the API, and is answered with
 * `404 NOT_FOUND` in the error envelope, so under `anonymous: 'deny'` an anonymous caller gets
 * `401` on every path and cannot tell which paths exist. An `OPTIONS` request for a path a route
 * serves answers `204` with the methods it serves in `Allow`, which `router.allowedMethods()`
 * would answer for every path once this route matches them all, so the app needs no
 * `allowedMethods()`.
 */
export function routeUnmatched(
  router: Router<CogitatorState>,
  guards: readonly Middleware[]
): void {
  const answer = async (ctx: Context, next: Next) => {
    const allowed = ctx.method === 'OPTIONS' ? allowedMethods(ctx) : [];
    if (allowed.length > 0) {
      ctx.set('Allow', allowed.join(', '));
      ctx.status = 204;
      return;
    }
    await next();
    if (!unanswered(ctx)) return;
    await runChain(guards, ctx, () => notFound(ctx, 'Not found'));
  };

  for (const [at, path] of ANY_PATH.entries()) {
    try {
      router.all(UNMATCHED_ROUTE, path, answer);
      return;
    } catch (error) {
      if (at === ANY_PATH.length - 1) throw error;
    }
  }
}
