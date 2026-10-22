import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  generateId,
  parseSwarmRunRequest,
  swarmAgentNames,
  swarmTimeoutWithin,
  withSwarm,
} from '@cogitator-ai/server-shared';
import { HonoStreamWriter } from '../streaming/hono-stream-writer.js';
import type { HonoEnv, SwarmListResponse, BlackboardResponse } from '../types.js';
import type { RunResult, SwarmMessage, SwarmEvent } from '@cogitator-ai/types';
import { getOwn } from '../utils/lookup.js';
import { describeError, isModuleNotFoundError } from '../utils/errors.js';
import {
  createRequestAbortController,
  holdConnectionOpen,
  errorResponse,
  invalidInput,
  bodyRefused,
  notFound,
  notInstalled,
  readJsonBody,
  refuseThread,
  requestAborted,
  sendError,
} from '../utils/request.js';
import { serializeSwarmUsage, toSwarmRunResponse } from '../utils/results.js';

export function createSwarmRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.get('/swarms', (c) => {
    const ctx = c.get('cogitator');
    const swarmList = Object.entries(ctx.swarms).map(([name, config]) => {
      const agents = swarmAgentNames(config);

      return { name, strategy: config.strategy, agents };
    });

    const response: SwarmListResponse = { swarms: swarmList };
    return c.json(response);
  });

  app.post('/swarms/:name/run', async (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const swarmConfig = getOwn(ctx.swarms, name);

    if (!swarmConfig) return notFound(c, `Swarm '${name}' not found`);

    const body = await readJsonBody(c);
    if (!body.ok) return bodyRefused(c, body.refusal);
    const parsed = parseSwarmRunRequest(body.value, { acceptContext: ctx.acceptContext });
    if (!parsed.ok) return invalidInput(c, parsed.message);
    const refusal = await refuseThread(c, parsed.value.threadId);
    if (refusal) return sendError(c, refusal);
    const timeout = swarmTimeoutWithin(parsed.value.timeout, ctx.limits);

    holdConnectionOpen(c);
    const abortController = createRequestAbortController(c);

    try {
      const { Swarm } = await import('@cogitator-ai/swarms');
      if (abortController.signal.aborted) return requestAborted(c);
      const response = await withSwarm(new Swarm(ctx.runtime, swarmConfig), async (swarm) => {
        abortController.signal.addEventListener('abort', () => swarm.abort(), { once: true });
        const result = await swarm.run({
          ...parsed.value,
          timeout,
          userId: c.get('cogitatorAuth')?.userId,
        });
        return toSwarmRunResponse(swarm, result);
      });
      if (abortController.signal.aborted) return requestAborted(c);

      return c.json(response);
    } catch (error) {
      if (abortController.signal.aborted) return requestAborted(c);
      if (isModuleNotFoundError(error)) {
        return notInstalled(c, 'Swarms');
      }
      return errorResponse(c, error, 'Swarm run error');
    }
  });

  app.post('/swarms/:name/stream', async (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const swarmConfig = getOwn(ctx.swarms, name);

    if (!swarmConfig) return notFound(c, `Swarm '${name}' not found`);

    const body = await readJsonBody(c);
    if (!body.ok) return bodyRefused(c, body.refusal);
    const parsed = parseSwarmRunRequest(body.value, { acceptContext: ctx.acceptContext });
    if (!parsed.ok) return invalidInput(c, parsed.message);
    const refusal = await refuseThread(c, parsed.value.threadId);
    if (refusal) return sendError(c, refusal);
    const timeout = swarmTimeoutWithin(parsed.value.timeout, ctx.limits);

    const abortController = createRequestAbortController(c);

    return streamSSE(c, async (stream) => {
      const writer = new HonoStreamWriter(stream, { heartbeatMs: ctx.sseHeartbeatMs });
      const messageId = generateId('swarm');

      stream.onAbort(() => {
        writer.close();
        abortController.abort();
      });

      try {
        const { Swarm } = await import('@cogitator-ai/swarms');
        if (abortController.signal.aborted) return;
        await withSwarm(new Swarm(ctx.runtime, swarmConfig), async (swarm) => {
          abortController.signal.addEventListener('abort', () => swarm.abort(), { once: true });

          await writer.start(messageId);

          const result = await swarm.run({
            ...parsed.value,
            timeout,
            userId: c.get('cogitatorAuth')?.userId,
            onAgentStart: (agentName: string) => {
              void writer.swarmEvent('agent_start', { agentName, timestamp: Date.now() });
            },
            onAgentComplete: (agentName: string, agentResult: RunResult) => {
              void writer.swarmEvent('agent_complete', {
                agentName,
                output: agentResult.output,
                timestamp: Date.now(),
              });
            },
            onAgentError: (agentName: string, error: Error) => {
              void writer.swarmEvent('agent_error', {
                agentName,
                error: describeError(error, `Swarm agent ${agentName} error`).message,
              });
            },
            onMessage: (message: SwarmMessage) => {
              void writer.swarmEvent('message', message);
            },
            onEvent: (event: SwarmEvent) => {
              void writer.swarmEvent(event.type, event.data);
            },
          });

          if (abortController.signal.aborted) return;

          await writer.swarmEvent('swarm_completed', {
            swarmId: swarm.id,
            output: result.output,
            usage: serializeSwarmUsage(swarm.getResourceUsage()),
          });
          await writer.finish(messageId);
        });
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (isModuleNotFoundError(error)) {
          await writer.error('Swarms package not installed', 'UNIMPLEMENTED');
        } else {
          const failure = describeError(error, 'Swarm stream error');
          await writer.error(failure.message, failure.code);
        }
      } finally {
        writer.close();
      }
    });
  });

  app.get('/swarms/:name/blackboard', (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const swarmConfig = getOwn(ctx.swarms, name);

    if (!swarmConfig) return notFound(c, `Swarm '${name}' not found`);

    if (!swarmConfig.blackboard?.enabled) {
      return invalidInput(c, 'Blackboard not enabled for this swarm');
    }

    const response: BlackboardResponse = {
      sections: swarmConfig.blackboard.sections ?? {},
    };

    return c.json(response);
  });

  return app;
}
