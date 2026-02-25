import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { generateId } from '@cogitator-ai/server-shared';
import { HonoStreamWriter } from '../streaming/hono-stream-writer.js';
import type {
  HonoEnv,
  SwarmListResponse,
  SwarmRunRequest,
  SwarmRunResponse,
  BlackboardResponse,
} from '../types.js';
import type { RunResult, SwarmMessage, SwarmEvent } from '@cogitator-ai/types';

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
    const swarmConfig = ctx.swarms[name];

    if (!swarmConfig) {
      return c.json({ error: { message: `Swarm '${name}' not found`, code: 'NOT_FOUND' } }, 404);
    }

    let body: SwarmRunRequest;
    try {
      body = await c.req.json<SwarmRunRequest>();
    } catch {
      return c.json({ error: { message: 'Invalid JSON body', code: 'INVALID_INPUT' } }, 400);
    }

    if (!body?.input) {
      return c.json(
        { error: { message: 'Missing required field: input', code: 'INVALID_INPUT' } },
        400
      );
    }

    try {
      const { Swarm } = await import('@cogitator-ai/swarms');
      const swarm = new Swarm(ctx.runtime, swarmConfig);

      const result = await swarm.run({
        input: body.input,
        context: body.context,
        threadId: body.threadId,
        timeout: body.timeout,
      });

      const agentResults: Record<string, unknown> = {};
      for (const [agentName, agentResult] of result.agentResults.entries()) {
        agentResults[agentName] = {
          output: agentResult.output,
          usage: agentResult.usage,
        };
      }

      const resourceUsage = swarm.getResourceUsage();
      const response: SwarmRunResponse = {
        swarmId: swarm.id,
        swarmName: swarm.name,
        strategy: swarm.strategyType,
        output: result.output,
        agentResults,
        usage: {
          totalTokens: resourceUsage.totalTokens,
          totalCost: resourceUsage.totalCost,
          elapsedTime: resourceUsage.elapsedTime,
        },
      };

      return c.json(response);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Cannot find module')) {
        return c.json(
          { error: { message: 'Swarms package not installed', code: 'UNIMPLEMENTED' } },
          501
        );
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      return c.json({ error: { message, code: 'INTERNAL' } }, 500);
    }
  });

  app.post('/swarms/:name/stream', async (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const swarmConfig = ctx.swarms[name];

    if (!swarmConfig) {
      return c.json({ error: { message: `Swarm '${name}' not found`, code: 'NOT_FOUND' } }, 404);
    }

    let body: SwarmRunRequest;
    try {
      body = await c.req.json<SwarmRunRequest>();
    } catch {
      return c.json({ error: { message: 'Invalid JSON body', code: 'INVALID_INPUT' } }, 400);
    }

    if (!body?.input) {
      return c.json(
        { error: { message: 'Missing required field: input', code: 'INVALID_INPUT' } },
        400
      );
    }

    return streamSSE(c, async (stream) => {
      const writer = new HonoStreamWriter(stream);
      const messageId = generateId('swarm');

      stream.onAbort(() => writer.close());

      try {
        const { Swarm } = await import('@cogitator-ai/swarms');
        const swarm = new Swarm(ctx.runtime, swarmConfig);

        await writer.start(messageId);

        const result = await swarm.run({
          input: body.input,
          context: body.context,
          threadId: body.threadId,
          timeout: body.timeout,
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
            void writer.swarmEvent('agent_error', { agentName, error: error.message });
          },
          onMessage: (message: SwarmMessage) => {
            void writer.swarmEvent('message', message);
          },
          onEvent: (event: SwarmEvent) => {
            void writer.swarmEvent(event.type, event.data);
          },
        });

        const resourceUsage = swarm.getResourceUsage();
        await writer.swarmEvent('swarm_completed', {
          swarmId: swarm.id,
          output: result.output,
          usage: resourceUsage,
        });

        await writer.finish(messageId);
      } catch (error) {
        if (error instanceof Error && error.message.includes('Cannot find module')) {
          await writer.error('Swarms package not installed', 'UNIMPLEMENTED');
        } else {
          const message = error instanceof Error ? error.message : 'Unknown error';
          await writer.error(message, 'INTERNAL');
        }
      } finally {
        writer.close();
      }
    });
  });

  app.get('/swarms/:name/blackboard', (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const swarmConfig = ctx.swarms[name];

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
      sections: swarmConfig.blackboard.sections || {},
    };

    return c.json(response);
  });

  return app;
}
