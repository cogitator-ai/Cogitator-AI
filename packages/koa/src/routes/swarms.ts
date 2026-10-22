import Router from '@koa/router';
import type { CogitatorState, SwarmListResponse, BlackboardResponse } from '../types.js';
import { KoaStreamWriter, setupSSEHeaders } from '../streaming/index.js';
import {
  generateId,
  parseSwarmRunRequest,
  swarmAgentNames,
  swarmTimeoutWithin,
  withSwarm,
} from '@cogitator-ai/server-shared';
import type { RunResult, SwarmMessage, SwarmEvent } from '@cogitator-ai/types';
import { getOwn } from '../utils/lookup.js';
import {
  describeError,
  invalidInput,
  isModuleNotFoundError,
  notFound,
  notInstalled,
  respondWithError,
  sendError,
} from '../utils/errors.js';
import { getRequestBody, onClientDisconnect, refuseThread } from '../utils/request.js';
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
      notFound(ctx, `Swarm '${name}' not found`);
      return;
    }

    const parsed = parseSwarmRunRequest(getRequestBody(ctx), {
      acceptContext: ctx.state.cogitator.acceptContext,
    });
    if (!parsed.ok) {
      invalidInput(ctx, parsed.message);
      return;
    }
    const refusal = await refuseThread(ctx, parsed.value.threadId);
    if (refusal) {
      sendError(ctx, refusal);
      return;
    }
    const timeout = swarmTimeoutWithin(parsed.value.timeout, ctx.state.cogitator.limits);

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
        const result = await swarm.run({
          ...parsed.value,
          timeout,
          userId: ctx.state.auth?.userId,
        });
        return toSwarmRunResponse(swarm, result);
      });
      if (aborted) return;

      ctx.body = response;
    } catch (error) {
      if (aborted) return;
      if (isModuleNotFoundError(error)) {
        notInstalled(ctx, 'Swarms');
        return;
      }

      respondWithError(ctx, error, 'Swarm run error');
    }
  });

  router.post('/swarms/:name/stream', async (ctx) => {
    const { swarms, runtime } = ctx.state.cogitator;
    const { name } = ctx.params;
    const swarmConfig = getOwn(swarms, name);

    if (!swarmConfig) {
      notFound(ctx, `Swarm '${name}' not found`);
      return;
    }

    const parsed = parseSwarmRunRequest(getRequestBody(ctx), {
      acceptContext: ctx.state.cogitator.acceptContext,
    });
    if (!parsed.ok) {
      invalidInput(ctx, parsed.message);
      return;
    }
    const refusal = await refuseThread(ctx, parsed.value.threadId);
    if (refusal) {
      sendError(ctx, refusal);
      return;
    }
    const timeout = swarmTimeoutWithin(parsed.value.timeout, ctx.state.cogitator.limits);

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
          timeout,
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
              error: describeError(error, `Swarm agent ${agentName} error`).message,
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
        const failure = describeError(error, 'Swarm stream error');
        writer.error(failure.message, failure.code);
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
      notFound(ctx, `Swarm '${name}' not found`);
      return;
    }

    if (!swarmConfig.blackboard?.enabled) {
      invalidInput(ctx, 'Blackboard not enabled for this swarm');
      return;
    }

    const response: BlackboardResponse = {
      sections: swarmConfig.blackboard.sections ?? {},
    };

    ctx.body = response;
  });

  return router;
}
