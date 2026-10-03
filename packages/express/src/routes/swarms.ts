import { Router } from 'express';
import type { Response } from 'express';
import type {
  RouteContext,
  CogitatorRequest,
  SwarmListResponse,
  SwarmRunResponse,
  BlackboardResponse,
} from '../types.js';
import { ExpressStreamWriter, setupSSEHeaders, generateId } from '../streaming/index.js';
import type { RunResult, SwarmMessage, SwarmEvent } from '@cogitator-ai/types';
import {
  handleRouteError,
  isModuleNotFound,
  onClientDisconnect,
  parseRunBody,
  resolveError,
  sendError,
} from './utils.js';

const SWARMS_MISSING = 'Swarms package not installed';

export function createSwarmRoutes(ctx: RouteContext): Router {
  const router = Router();

  const findSwarm = (name: string) =>
    Object.hasOwn(ctx.swarms, name) ? ctx.swarms[name] : undefined;

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

  router.post(
    '/swarms/:name/run',
    async (req: CogitatorRequest<{ name: string }>, res: Response) => {
      const { name } = req.params;
      const swarmConfig = findSwarm(name);

      if (!swarmConfig) {
        sendError(res, 404, `Swarm '${name}' not found`, 'NOT_FOUND');
        return;
      }

      const parsed = parseRunBody(req.body, true);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message, 'INVALID_INPUT');
        return;
      }
      const body = parsed.value;

      let disconnected = false;
      let abortSwarm: (() => void) | undefined;
      onClientDisconnect(res, () => {
        disconnected = true;
        abortSwarm?.();
      });

      try {
        const { Swarm } = await import('@cogitator-ai/swarms');
        const swarm = new Swarm(ctx.cogitator, swarmConfig);
        abortSwarm = () => swarm.abort();
        if (disconnected) swarm.abort();

        const result = await swarm.run({
          input: body.input,
          context: body.context,
          threadId: body.threadId,
          userId: req.cogitator?.auth?.userId,
          timeout: body.timeout,
        });

        if (disconnected) return;

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
        if (isModuleNotFound(error)) {
          sendError(res, 501, SWARMS_MISSING, 'UNIMPLEMENTED');
          return;
        }
        if (disconnected) return;
        handleRouteError(res, error, 'Swarm run error');
      }
    }
  );

  router.post(
    '/swarms/:name/stream',
    async (req: CogitatorRequest<{ name: string }>, res: Response) => {
      const { name } = req.params;
      const swarmConfig = findSwarm(name);

      if (!swarmConfig) {
        sendError(res, 404, `Swarm '${name}' not found`, 'NOT_FOUND');
        return;
      }

      const parsed = parseRunBody(req.body, true);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message, 'INVALID_INPUT');
        return;
      }
      const body = parsed.value;

      setupSSEHeaders(res);
      const writer = new ExpressStreamWriter(res);
      const messageId = generateId('swarm');

      let disconnected = false;
      let abortSwarm: (() => void) | undefined;
      onClientDisconnect(res, () => {
        disconnected = true;
        abortSwarm?.();
        writer.close();
      });

      try {
        const { Swarm } = await import('@cogitator-ai/swarms');
        const swarm = new Swarm(ctx.cogitator, swarmConfig);
        abortSwarm = () => swarm.abort();
        if (disconnected) swarm.abort();

        writer.start(messageId);

        const result = await swarm.run({
          input: body.input,
          context: body.context,
          threadId: body.threadId,
          userId: req.cogitator?.auth?.userId,
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
            writer.swarmEvent('agent_error', {
              agentName,
              error: resolveError(error, `Swarm agent ${agentName}`).message,
            });
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
          usage: {
            totalTokens: resourceUsage.totalTokens,
            totalCost: resourceUsage.totalCost,
            elapsedTime: resourceUsage.elapsedTime,
          },
        });

        writer.finish(messageId);
      } catch (error) {
        if (isModuleNotFound(error)) {
          writer.error(SWARMS_MISSING, 'UNIMPLEMENTED');
        } else if (!disconnected) {
          const resolved = resolveError(error, 'Swarm stream error');
          writer.error(resolved.message, resolved.code);
        }
      } finally {
        writer.close();
      }
    }
  );

  router.get(
    '/swarms/:name/blackboard',
    (req: CogitatorRequest<{ name: string }>, res: Response) => {
      const { name } = req.params;
      const swarmConfig = findSwarm(name);

      if (!swarmConfig) {
        sendError(res, 404, `Swarm '${name}' not found`, 'NOT_FOUND');
        return;
      }

      if (!swarmConfig.blackboard?.enabled) {
        sendError(res, 400, 'Blackboard not enabled for this swarm', 'INVALID_INPUT');
        return;
      }

      const response: BlackboardResponse = {
        sections: swarmConfig.blackboard.sections || {},
      };

      res.json(response);
    }
  );

  return router;
}
