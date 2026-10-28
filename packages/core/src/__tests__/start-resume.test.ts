import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CogitatorError, ErrorCode, type RunCheckpoint } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import {
  answer,
  callTools,
  deferred,
  scriptedBackend,
  userTexts,
} from './helpers/scripted-backend';

function pausing() {
  const executed = vi.fn(async ({ target }: { target: string }) => `deployed ${target}`);
  const deploy = tool({
    name: 'deploy',
    description: 'Deploys',
    parameters: z.object({ target: z.string() }),
    requiresApproval: true,
    execute: executed,
  });
  const agent = new Agent({
    name: 'releaser',
    model: 'mock/m',
    instructions: 'Release.',
    tools: [deploy],
  });
  return { agent, executed };
}

describe('startResume', () => {
  it('resumes a paused run with a handle that steers it', async () => {
    const scripted = scriptedBackend([
      callTools([{ id: 'c1', name: 'deploy', arguments: { target: 'prod' } }]),
      answer('shipped'),
    ]);
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { mock: scripted.backend } },
    });
    const { agent, executed } = pausing();
    const paused = await cog.run(agent, { input: 'release', threadId: 't-steer' });
    expect(paused.status).toBe('paused');

    const handle = cog.startResume(agent, 't-steer', {
      decisions: { c1: { approved: true } },
    });
    expect(handle.steer('Mention the changelog')).toBe(true);
    const result = await handle.result;

    expect(result.status).toBe('completed');
    expect(result.output).toBe('shipped');
    expect(executed).toHaveBeenCalledWith({ target: 'prod' }, expect.anything());
    const last = scripted.requests.at(-1);
    expect(last && userTexts(last)).toContain('Mention the changelog');
    await cog.close();
  });

  it('resumes from a checkpoint and stops with abort()', async () => {
    const reached = deferred();
    const scripted = scriptedBackend([
      callTools([{ id: 'c1', name: 'deploy', arguments: { target: 'eu' } }]),
      async (request) => {
        reached.resolve();
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      },
    ]);
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { mock: scripted.backend } },
    });
    const { agent } = pausing();
    const paused = await cog.run(agent, { input: 'release', threadId: 't-abort' });
    const checkpoint = paused.checkpoint;
    if (!checkpoint) throw new Error('no checkpoint');

    const handle = cog.startResume(agent, checkpoint, { defaultDecision: { approved: true } });
    handle.followUp('and then?');
    await reached.promise;
    expect(handle.abort()).toEqual([{ kind: 'followUp', content: 'and then?' }]);
    await expect(handle.result).rejects.toBeDefined();
    await cog.close();
  });

  it('refuses at once a checkpoint resume() refuses', async () => {
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { mock: scriptedBackend([answer('x')]).backend } },
    });
    const { agent } = pausing();
    const unsupported = { version: 2, runId: 'r', threadId: 't' } as unknown as RunCheckpoint;
    let thrown: unknown;
    try {
      cog.startResume(agent, unsupported);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CogitatorError);
    expect((thrown as CogitatorError).code).toBe(ErrorCode.VALIDATION_ERROR);
    await expect(cog.resume(agent, unsupported)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    await cog.close();
  });
});
