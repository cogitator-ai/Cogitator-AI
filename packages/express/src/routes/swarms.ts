import { Router } from 'express';
import type { Response } from 'express';
import type {
  RouteContext,
  CogitatorRequest,
  SwarmListResponse,
  SwarmRunRequest,
  SwarmRunResponse,
  BlackboardResponse,
} from '../types.js';
import { ExpressStreamWriter, setupSSEHeaders, generateId } from '../streaming/index.js';
import type { RunResult, SwarmMessage, SwarmEvent } from '@cogitator-ai/types';

export function createSwarmRoutes(ctx: RouteContext): Router {
  const router = Router();

  router.get('/swarms', (_req, res) => {
    const swarmList = Object.entries(ctx.swarms).map(([name, config]) => {
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
    res.json(response);
  });

  router.post('/swarms/:name/run', async (req: CogitatorRequest, res: Response) => {
    const { name } = req.params;
    const swarmConfig = ctx.swarms[name];

    if (!swarmConfig) {
      res.status(404).json({
        error: { message: `Swarm '${name}' not found`, code: 'NOT_FOUND' },
      });
      return;
    }

    const body = req.body as SwarmRunRequest;
    if (!body?.input) {
      res.status(400).json({
        error: { message: 'Missing required field: input', code: 'INVALID_INPUT' },
      });
      return;
    }

    try {
      const { Swarm } = await import('@cogitator-ai/swarms');
      const swarm = new Swarm(ctx.cogitator, swarmConfig);

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

      res.json(response);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Cannot find module')) {
        res.status(501).json({
          error: { message: 'Swarms package not installed', code: 'UNIMPLEMENTED' },
        });
        return;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: { message, code: 'INTERNAL' },
      });
    }
  });

  router.post('/swarms/:name/stream', async (req: CogitatorRequest, res: Response) => {
    const { name } = req.params;
    const swarmConfig = ctx.swarms[name];

    if (!swarmConfig) {
      res.status(404).json({
        error: { message: `Swarm '${name}' not found`, code: 'NOT_FOUND' },
      });
      return;
    }

    const body = req.body as SwarmRunRequest;
    if (!body?.input) {
      res.status(400).json({
        error: { message: 'Missing required field: input', code: 'INVALID_INPUT' },
      });
      return;
    }

    setupSSEHeaders(res);
    const writer = new ExpressStreamWriter(res);
    const messageId = generateId('swarm');

    req.on('close', () => {
      writer.close();
    });

    try {
      const { Swarm } = await import('@cogitator-ai/swarms');
      const swarm = new Swarm(ctx.cogitator, swarmConfig);

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

  router.get('/swarms/:name/blackboard', async (req: CogitatorRequest, res: Response) => {
    const { name } = req.params;
    const swarmConfig = ctx.swarms[name];

    if (!swarmConfig) {
      res.status(404).json({
        error: { message: `Swarm '${name}' not found`, code: 'NOT_FOUND' },
      });
      return;
    }

    if (!swarmConfig.blackboard?.enabled) {
      res.status(400).json({
        error: { message: 'Blackboard not enabled for this swarm', code: 'INVALID_INPUT' },
      });
      return;
    }

    const response: BlackboardResponse = {
      sections: swarmConfig.blackboard.sections || {},
    };

    res.json(response);
  });

  return router;
}
