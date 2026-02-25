import Router from '@koa/router';
import type {
  CogitatorState,
  SwarmListResponse,
  SwarmRunRequest,
  SwarmRunResponse,
  BlackboardResponse,
} from '../types.js';
import { KoaStreamWriter, setupSSEHeaders } from '../streaming/index.js';
import { generateId } from '@cogitator-ai/server-shared';
import type { RunResult, SwarmMessage, SwarmEvent } from '@cogitator-ai/types';

export function createSwarmRoutes(): Router<CogitatorState> {
  const router = new Router<CogitatorState>();

  router.get('/swarms', (ctx) => {
    const { swarms } = ctx.state.cogitator;
    const swarmList = Object.entries(swarms).map(([name, config]) => {
      const agents: string[] = [];
      if (config.supervisor) agents.push(config.supervisor.name);
      if (config.workers) agents.push(...config.workers.map((w) => w.name));
      if (config.agents) agents.push(...config.agents.map((a) => a.name));
      if (config.moderator) agents.push(config.moderator.name);

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
    const swarmConfig = swarms[name];

    if (!swarmConfig) {
      ctx.status = 404;
      ctx.body = { error: { message: `Swarm '${name}' not found`, code: 'NOT_FOUND' } };
      return;
    }

    const body = (ctx.request as unknown as { body: SwarmRunRequest }).body;
    if (!body?.input) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Missing required field: input', code: 'INVALID_INPUT' } };
      return;
    }

    try {
      const { Swarm } = await import('@cogitator-ai/swarms');
      const swarm = new Swarm(runtime, swarmConfig);

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

      ctx.body = response;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Cannot find module')) {
        ctx.status = 501;
        ctx.body = { error: { message: 'Swarms package not installed', code: 'UNIMPLEMENTED' } };
        return;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      ctx.status = 500;
      ctx.body = { error: { message, code: 'INTERNAL' } };
    }
  });

  router.post('/swarms/:name/stream', async (ctx) => {
    const { swarms, runtime } = ctx.state.cogitator;
    const { name } = ctx.params;
    const swarmConfig = swarms[name];

    if (!swarmConfig) {
      ctx.status = 404;
      ctx.body = { error: { message: `Swarm '${name}' not found`, code: 'NOT_FOUND' } };
      return;
    }

    const body = (ctx.request as unknown as { body: SwarmRunRequest }).body;
    if (!body?.input) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Missing required field: input', code: 'INVALID_INPUT' } };
      return;
    }

    setupSSEHeaders(ctx);
    const writer = new KoaStreamWriter(ctx);
    const messageId = generateId('swarm');

    ctx.req.on('close', () => {
      writer.close();
    });

    try {
      const { Swarm } = await import('@cogitator-ai/swarms');
      const swarm = new Swarm(runtime, swarmConfig);

      writer.start(messageId);

      const result = await swarm.run({
        input: body.input,
        context: body.context,
        threadId: body.threadId,
        timeout: body.timeout,
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
          writer.swarmEvent('agent_error', { agentName, error: error.message });
        },
        onMessage: (message: SwarmMessage) => {
          writer.swarmEvent('message', message);
        },
        onEvent: (event: SwarmEvent) => {
          writer.swarmEvent(event.type, event.data);
        },
      });

      const resourceUsage = swarm.getResourceUsage();
      writer.swarmEvent('swarm_completed', {
        swarmId: swarm.id,
        output: result.output,
        usage: resourceUsage,
      });

      writer.finish(messageId);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Cannot find module')) {
        writer.error('Swarms package not installed', 'UNIMPLEMENTED');
      } else {
        const message = error instanceof Error ? error.message : 'Unknown error';
        writer.error(message, 'INTERNAL');
      }
    } finally {
      writer.close();
    }
  });

  router.get('/swarms/:name/blackboard', (ctx) => {
    const { swarms } = ctx.state.cogitator;
    const { name } = ctx.params;
    const swarmConfig = swarms[name];

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
      sections: swarmConfig.blackboard.sections || {},
    };

    ctx.body = response;
  });

  return router;
}
