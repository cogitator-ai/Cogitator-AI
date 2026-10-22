import { describe, it, expect } from 'vitest';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import {
  admitCaller,
  authorizeThreadAccess,
  checkRunLimits,
  describeHttpError,
  errorEnvelope,
  errorHeaders,
  swarmTimeoutWithin,
  workflowOptionsWithin,
} from '../contract';

describe('run limits', () => {
  it('holds what a request asks for to the cap, and gives the cap to one that asks for nothing', () => {
    const limits = { swarmTimeout: 60_000, workflowMaxIterations: 20, workflowMaxConcurrency: 2 };

    expect(swarmTimeoutWithin(120_000, limits)).toBe(60_000);
    expect(swarmTimeoutWithin(5_000, limits)).toBe(5_000);
    expect(swarmTimeoutWithin(undefined, limits)).toBe(60_000);
    expect(swarmTimeoutWithin(5_000, undefined)).toBe(5_000);
    expect(workflowOptionsWithin({ maxIterations: 50, signal: 'kept' }, limits)).toEqual({
      maxIterations: 20,
      maxConcurrency: 2,
      signal: 'kept',
    });
    expect(workflowOptionsWithin({ maxConcurrency: 1 }, {})).toEqual({ maxConcurrency: 1 });
  });

  it('refuses limits that are not positive integers or that no timer can hold', () => {
    expect(() => checkRunLimits({ swarmTimeout: 0 })).toThrow('limits.swarmTimeout');
    expect(() => checkRunLimits({ workflowMaxIterations: 2.5 })).toThrow(
      'limits.workflowMaxIterations'
    );
    expect(() => checkRunLimits({ swarmTimeout: 3e9 })).toThrow('at most');
    expect(checkRunLimits({ workflowMaxConcurrency: 3 })).toEqual({ workflowMaxConcurrency: 3 });
  });
});

describe('callers and threads', () => {
  it('turns away a caller without a user id only under the deny policy', () => {
    expect(admitCaller(undefined, 'deny')).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(admitCaller('ann', 'deny')).toBeUndefined();
    expect(admitCaller(undefined, 'allow')).toBeUndefined();
    expect(admitCaller(undefined, undefined)).toBeUndefined();
  });

  it('refuses a thread the authorizer turns down, and lets requests without one go on', async () => {
    const authorize = (auth: { userId?: string } | undefined, threadId: string) =>
      threadId.startsWith(`${auth?.userId}:`);

    expect(await authorizeThreadAccess(authorize, { userId: 'ann' }, 'bob:1')).toMatchObject({
      status: 403,
      code: 'THREAD_FORBIDDEN',
    });
    expect(await authorizeThreadAccess(authorize, { userId: 'ann' }, 'ann:1')).toBeUndefined();
    expect(await authorizeThreadAccess(authorize, undefined, undefined)).toBeUndefined();
    expect(await authorizeThreadAccess(undefined, undefined, 'bob:1')).toBeUndefined();
  });
});

describe('errors', () => {
  it('answers a Cogitator error with its status, code and whole seconds of Retry-After', () => {
    const error = new CogitatorError({
      message: 'slow down',
      code: ErrorCode.LLM_RATE_LIMITED,
      retryAfter: 1500,
    });

    const described = describeHttpError(error)!;

    expect(described).toEqual({
      status: 429,
      code: 'LLM_RATE_LIMITED',
      message: 'slow down',
      retryAfter: 2,
    });
    expect(errorEnvelope(described)).toEqual({
      error: { message: 'slow down', code: 'LLM_RATE_LIMITED' },
    });
    expect(errorHeaders(described)).toEqual({ 'Retry-After': '2' });
  });

  it('keeps the status an error names and falls back to 500 for one outside the error range', () => {
    const own = new CogitatorError({
      message: 'x',
      code: ErrorCode.INTERNAL_ERROR,
      statusCode: 409,
    });
    const odd = new CogitatorError({ message: 'x', code: ErrorCode.INTERNAL_ERROR, statusCode: 200 });

    expect(describeHttpError(own)?.status).toBe(409);
    expect(describeHttpError(odd)?.status).toBe(500);
    expect(errorHeaders(describeHttpError(own)!)).toEqual({});
  });

  it('answers a swarm that ran out of time with 504 RUN_TIMEOUT, and keeps other errors to itself', () => {
    const timeout = Object.assign(new Error("Swarm 'team' timed out after 10ms"), {
      name: 'SwarmTimeoutError',
    });

    expect(describeHttpError(timeout)).toMatchObject({ status: 504, code: 'RUN_TIMEOUT' });
    expect(describeHttpError(new Error('database password is hunter2'))).toBeUndefined();
  });
});
