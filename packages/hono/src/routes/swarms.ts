import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { generateId } from '@cogitator-ai/server-shared';
import { HonoStreamWriter } from '../streaming/hono-stream-writer.js';
import type { HonoEnv, SwarmListResponse, BlackboardResponse } from '../types.js';
import type { RunResult, SwarmMessage, SwarmEvent } from '@cogitator-ai/types';
import { getOwn } from '../utils/lookup.js';
import { isModuleNotFoundError, resolveError } from '../utils/errors.js';
import {
  createRequestAbortController,
  errorResponse,
  invalidInput,
  invalidJson,
  readJsonBody,
  requestAborted,
} from '../utils/request.js';
import { serializeSwarmUsage, toSwarmRunResponse } from '../utils/results.js';
import { parseSwarmRunRequest } from '../utils/validation.js';

export function createSwarmRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.get('/swarms', (c) => {
    const ctx = c.get('cogitator');
    const swarmList = Object.entries(ctx.swarms).map(([name, config]) => {
      const agents: string[] = [];
      if (config.supervisor) agents.push(config.supervisor.name);
      if (config.workers) agents.push(...config.workers.map((w) => w.name));
      if (config.agents) agents.push(...config.agents.map((a) => a.name));
      if (config.moderator) agents.push(config.moderator.name);

      return { name, strategy: config.strategy, agents };
    });

    const response: SwarmListResponse = { swarms: swarmList };
    return c.json(response);
  });

  app.post('/swarms/:name/run', async (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const swarmConfig = getOwn(ctx.swarms, name);

    if (!swarmConfig) {
      return c.json({ error: { message: `Swarm '${name}' not found`, code: 'NOT_FOUND' } }, 404);
    }

    const body = await readJsonBody(c);
    if (!body.ok) return invalidJson(c);
    const parsed = parseSwarmRunRequest(body.value);
    if (!parsed.ok) return invalidInput(c, parsed.message);

    const abortController = createRequestAbortController(c);

    try {
      const { Swarm } = await import('@cogitator-ai/swarms');
      const swarm = new Swarm(ctx.runtime, swarmConfig);
      if (abortController.signal.aborted) return requestAborted(c);
      abortController.signal.addEventListener('abort', () => swarm.abort(), { once: true });

      const result = await swarm.run({
        ...parsed.value,
        userId: c.get('cogitatorAuth')?.userId,
      });
      if (abortController.signal.aborted) return requestAborted(c);

      return c.json(toSwarmRunResponse(swarm, result));
    } catch (error) {
      if (abortController.signal.aborted) return requestAborted(c);
      if (isModuleNotFoundError(error)) {
        return c.json(
          { error: { message: 'Swarms package not installed', code: 'UNIMPLEMENTED' } },
          501
        );
      }
      return errorResponse(c, error, 'Swarm run error');
    }
  });

  app.post('/swarms/:name/stream', async (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const swarmConfig = getOwn(ctx.swarms, name);

    if (!swarmConfig) {
      return c.json({ error: { message: `Swarm '${name}' not found`, code: 'NOT_FOUND' } }, 404);
    }

    const body = await readJsonBody(c);
    if (!body.ok) return invalidJson(c);
    const parsed = parseSwarmRunRequest(body.value);
    if (!parsed.ok) return invalidInput(c, parsed.message);

    const abortController = createRequestAbortController(c);

    return streamSSE(c, async (stream) => {
      const writer = new HonoStreamWriter(stream);
      const messageId = generateId('swarm');

      stream.onAbort(() => {
        writer.close();
        abortController.abort();
      });

      try {
        const { Swarm } = await import('@cogitator-ai/swarms');
        const swarm = new Swarm(ctx.runtime, swarmConfig);
        if (abortController.signal.aborted) return;
        abortController.signal.addEventListener('abort', () => swarm.abort(), { once: true });

        await writer.start(messageId);

        const result = await swarm.run({
          ...parsed.value,
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
              error: resolveError(error, `Swarm agent ${agentName} error`).body.error.message,
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
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (isModuleNotFoundError(error)) {
          await writer.error('Swarms package not installed', 'UNIMPLEMENTED');
        } else {
          const { body: errorBody } = resolveError(error, 'Swarm stream error');
          await writer.error(errorBody.error.message, errorBody.error.code);
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

    if (!swarmConfig) {
      return c.json({ error: { message: `Swarm '${name}' not found`, code: 'NOT_FOUND' } }, 404);
    }

    if (!swarmConfig.blackboard?.enabled) {
      return c.json(
        { error: { message: 'Blackboard not enabled for this swarm', code: 'INVALID_INPUT' } },
        400
      );
    }

    const response: BlackboardResponse = {
      sections: swarmConfig.blackboard.sections ?? {},
    };

    return c.json(response);
  });

  return app;
}
