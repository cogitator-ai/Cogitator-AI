import { hook, HttpError, httpError } from '@tetsujs/core';
import type { Requires } from '@tetsujs/core';
import { admitCaller } from '@cogitator-ai/server-shared';
import type { AnonymousPolicy } from '@cogitator-ai/server-shared';
import { refusalError } from './errors.js';
import type { AuthContext, Authenticate, CogitatorDeps } from './types.js';

/** What the caller hook adds to the context of every guarded route. */
export interface CallerFields {
  cogitatorAuth: AuthContext | undefined;
}

const ANONYMOUS: CallerFields = { cogitatorAuth: undefined };

function admit(auth: AuthContext | undefined): CallerFields {
  if (!auth) throw httpError(401, 'UNAUTHORIZED', 'Unauthorized');
  return { cogitatorAuth: auth };
}

/**
 * The `beforeParse` hook that establishes the caller as `ctx.cogitatorAuth`.
 *
 * It runs before the body is read, so a refused request costs no parsing. Without
 * an `authenticate` function every caller is anonymous.
 */
export function callerHook(authenticate: Authenticate | undefined) {
  return hook.beforeParse((ctx): CallerFields | Promise<CallerFields> => {
    if (!authenticate) return { ...ANONYMOUS };
    let auth: ReturnType<Authenticate>;
    try {
      auth = authenticate(ctx);
    } catch (error) {
      throw refusal(error);
    }
    return auth instanceof Promise
      ? auth.then(admit, (error: unknown) => {
          throw refusal(error);
        })
      : admit(auth);
  });
}

/**
 * What an `authenticate` function that failed answers: an `HttpError` it threw on purpose as
 * it is, anything else (a token that does not verify, an expired session) as `401`, since the
 * caller could not be established. It is not a fault of the server.
 */
function refusal(error: unknown): HttpError {
  return error instanceof HttpError ? error : httpError(401, 'UNAUTHORIZED', 'Unauthorized');
}

/** The hook `callerHook()` builds, which `auth` also accepts ready-made. */
export type CallerHook = ReturnType<typeof callerHook>;

/**
 * The caller hook for `auth`: built from a function, or taken as it is when it is
 * already a hook — a `callerHook()` wrapped in `secured()` from `@tetsujs/openapi`,
 * so the generated document describes the security scheme and the `401`.
 */
export function resolveCaller(auth: CogitatorDeps['auth']): CallerHook {
  return typeof auth === 'function' || auth === undefined ? callerHook(auth) : auth;
}

/**
 * The `beforeParse` hook that runs after the caller hook and turns away a caller without a
 * `userId` with `401 UNAUTHORIZED` when `anonymous` is `'deny'`. Under `'allow'` it lets
 * every caller the caller hook admitted through.
 */
export function anonymousHook(anonymous: AnonymousPolicy | undefined) {
  return hook.beforeParse((ctx: Requires<CallerFields>) => {
    const refusal = admitCaller(ctx.cogitatorAuth?.userId, anonymous);
    if (refusal) throw refusalError(refusal);
  });
}
