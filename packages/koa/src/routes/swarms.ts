import Router from '@koa/router';
import type { CogitatorState, SwarmListResponse, BlackboardResponse } from '../types.js';
import { KoaStreamWriter, setupSSEHeaders } from '../streaming/index.js';
import {
  generateId,
  parseSwarmRunRequest,
  swarmAgentNames,
  withSwarm,
} from '@cogitator-ai/server-shared';
import type { RunResult, SwarmMessage, SwarmEvent } from '@cogitator-ai/types';
import { getOwn } from '../utils/lookup.js';
import { isModuleNotFoundError, resolveError } from '../utils/errors.js';
import { getRequestBody, onClientDisconnect } from '../utils/request.js';
import { serializeSwarmUsage, toSwarmRunResponse } from '../utils/results.js';

export function createSwarmRoutes(): Router<CogitatorState> {
  const router = new Router<CogitatorState>();

  router.get('/swarms', (ctx) => {
    const { swarms } = ctx.state.cogitator;
    const swarmList = Object.entries(swarms).map(([name, config]) => {
      const agents = swarmAgentNames(config);

      return {
        name,
        strategy: config.strategy,
        agents,
      };
    });

    const response: SwarmListResponse = { swarms: swarmList };
    ctx.body = response;
  });

  router.post('/swarms/:name/run', async (ctx) => {
    const { swarms, runtime } = ctx.state.cogitator;
    const { name } = ctx.params;
    const swarmConfig = getOwn(swarms, name);

    if (!swarmConfig) {
      ctx.status = 404;
      ctx.body = { error: { message: `Swarm '${name}' not found`, code: 'NOT_FOUND' } };
      return;
    }

    const parsed = parseSwarmRunRequest(getRequestBody(ctx), {
      acceptContext: ctx.state.cogitator.acceptContext,
    });
    if (!parsed.ok) {
      ctx.status = 400;
      ctx.body = { error: { message: parsed.message, code: 'INVALID_INPUT' } };
      return;
    }

    let aborted = false;
    let abortSwarm: (() => void) | undefined;
    onClientDisconnect(ctx, () => {
      aborted = true;
      abortSwarm?.();
    });

    try {
      const { Swarm } = await import('@cogitator-ai/swarms');
      if (aborted) return;
      const response = await withSwarm(new Swarm(runtime, swarmConfig), async (swarm) => {
        abortSwarm = () => swarm.abort();
        const result = await swarm.run({ ...parsed.value, userId: ctx.state.auth?.userId });
        return toSwarmRunResponse(swarm, result);
      });
      if (aborted) return;

      ctx.body = response;
    } catch (error) {
      if (aborted) return;
      if (isModuleNotFoundError(error)) {
        ctx.status = 501;
        ctx.body = { error: { message: 'Swarms package not installed', code: 'UNIMPLEMENTED' } };
        return;
      }

      const { status, body } = resolveError(error, 'Swarm run error');
      ctx.status = status;
      ctx.body = body;
    }
  });

  router.post('/swarms/:name/stream', async (ctx) => {
    const { swarms, runtime } = ctx.state.cogitator;
    const { name } = ctx.params;
    const swarmConfig = getOwn(swarms, name);

    if (!swarmConfig) {
      ctx.status = 404;
      ctx.body = { error: { message: `Swarm '${name}' not found`, code: 'NOT_FOUND' } };
      return;
    }

    const parsed = parseSwarmRunRequest(getRequestBody(ctx), {
      acceptContext: ctx.state.cogitator.acceptContext,
    });
    if (!parsed.ok) {
      ctx.status = 400;
      ctx.body = { error: { message: parsed.message, code: 'INVALID_INPUT' } };
      return;
    }

    setupSSEHeaders(ctx);
    const writer = new KoaStreamWriter(ctx, {
      heartbeatMs: ctx.state.cogitator.sseHeartbeatMs,
    });
    const messageId = generateId('swarm');

    let aborted = false;
    let abortSwarm: (() => void) | undefined;
    onClientDisconnect(ctx, () => {
      aborted = true;
      writer.close();
      abortSwarm?.();
    });

    try {
      const { Swarm } = await import('@cogitator-ai/swarms');
      if (aborted) return;
      await withSwarm(new Swarm(runtime, swarmConfig), async (swarm) => {
        abortSwarm = () => swarm.abort();

        writer.start(messageId);

        const result = await swarm.run({
          ...parsed.value,
          userId: ctx.state.auth?.userId,
          onAgentStart: (agentName: string) => {
            writer.swarmEvent('agent_start', { agentName, timestamp: Date.now() });
          },
          onAgentComplete: (agentName: string, agentResult: RunResult) => {
            writer.swarmEvent('agent_complete', {
              agentName,
              output: agentResult.output,
              timestamp: Date.now(),
            });
          },
          onAgentError: (agentName: string, error: Error) => {
            writer.swarmEvent('agent_error', {
              agentName,
              error: resolveError(error, `Swarm agent ${agentName} error`).body.error.message,
            });
          },
          onMessage: (message: SwarmMessage) => {
            writer.swarmEvent('message', message);
          },
          onEvent: (event: SwarmEvent) => {
            writer.swarmEvent(event.type, event.data);
          },
        });

        if (aborted) return;

        writer.swarmEvent('swarm_completed', {
          swarmId: swarm.id,
          output: result.output,
          usage: serializeSwarmUsage(swarm.getResourceUsage()),
        });
        writer.finish(messageId);
      });
    } catch (error) {
      if (aborted) return;
      if (isModuleNotFoundError(error)) {
        writer.error('Swarms package not installed', 'UNIMPLEMENTED');
      } else {
        const { body } = resolveError(error, 'Swarm stream error');
        writer.error(body.error.message, body.error.code);
      }
    } finally {
      writer.close();
    }
  });

  router.get('/swarms/:name/blackboard', (ctx) => {
    const { swarms } = ctx.state.cogitator;
    const { name } = ctx.params;
    const swarmConfig = getOwn(swarms, name);

    if (!swarmConfig) {
      ctx.status = 404;
      ctx.body = { error: { message: `Swarm '${name}' not found`, code: 'NOT_FOUND' } };
      return;
    }

    if (!swarmConfig.blackboard?.enabled) {
      ctx.status = 400;
      ctx.body = {
        error: { message: 'Blackboard not enabled for this swarm', code: 'INVALID_INPUT' },
      };
      return;
    }

    const response: BlackboardResponse = {
      sections: swarmConfig.blackboard.sections ?? {},
    };

    ctx.body = response;
  });

  return router;
}
