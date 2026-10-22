import type { FastifyPluginAsync } from 'fastify';
import type {
  SwarmListResponse,
  SwarmRunRequest,
  SwarmRunResponse,
  BlackboardResponse,
} from '../types.js';
import { swarmRunRequestSchema } from '../types.js';
import { FastifyStreamWriter, generateId } from '../streaming/index.js';
import type { RunResult, SwarmMessage, SwarmEvent } from '@cogitator-ai/types';
import {
  parseSwarmRunRequest,
  swarmAgentNames,
  swarmTimeoutWithin,
  withSwarm,
} from '@cogitator-ai/server-shared';
import {
  isModuleNotFound,
  onClientDisconnect,
  refuseThread,
  resolveError,
  sendError,
  sendRouteError,
  validateBody,
} from './utils.js';

interface SwarmParams {
  name: string;
}

const paramsSchema = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
} as const;

const SWARMS_MISSING = 'Swarms package not installed';

export const swarmRoutes: FastifyPluginAsync = async (fastify) => {
  const findSwarm = (name: string) =>
    Object.hasOwn(fastify.cogitator.swarms, name) ? fastify.cogitator.swarms[name] : undefined;

  fastify.get('/swarms', async () => {
    const swarmList = Object.entries(fastify.cogitator.swarms).map(([name, config]) => {
      const agents = swarmAgentNames(config);

      return {
        name,
        strategy: config.strategy,
        agents,
      };
    });

    const response: SwarmListResponse = { swarms: swarmList };
    return response;
  });

  const runBody = validateBody((body) =>
    parseSwarmRunRequest(body, { acceptContext: fastify.cogitator.acceptContext })
  );
  const runSchema = { params: paramsSchema, body: swarmRunRequestSchema(fastify.cogitator.limits) };

  fastify.post<{ Params: SwarmParams; Body: SwarmRunRequest }>(
    '/swarms/:name/run',
    { schema: runSchema, preValidation: runBody },
    async (request, reply) => {
      const { name } = request.params;
      const swarmConfig = findSwarm(name);

      if (!swarmConfig) {
        return sendError(reply, 404, `Swarm '${name}' not found`, 'NOT_FOUND');
      }

      if (await refuseThread(request, reply, request.body.threadId)) return reply;

      let disconnected = false;
      let abortSwarm: (() => void) | undefined;
      onClientDisconnect(reply, () => {
        disconnected = true;
        abortSwarm?.();
      });

      try {
        const { Swarm } = await import('@cogitator-ai/swarms');
        return await withSwarm(
          new Swarm(fastify.cogitator.runtime, swarmConfig),
          async (swarm): Promise<SwarmRunResponse> => {
            abortSwarm = () => swarm.abort();
            if (disconnected) swarm.abort();

            const result = await swarm.run({
              input: request.body.input,
              context: request.body.context,
              threadId: request.body.threadId,
              userId: request.cogitatorAuth?.userId,
              timeout: swarmTimeoutWithin(request.body.timeout, fastify.cogitator.limits),
            });

            const agentResults: Record<string, unknown> = {};
            for (const [agentName, agentResult] of result.agentResults.entries()) {
              agentResults[agentName] = {
                output: agentResult.output,
                usage: agentResult.usage,
              };
            }

            const resourceUsage = swarm.getResourceUsage();
            return {
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
          }
        );
      } catch (error) {
        if (isModuleNotFound(error)) {
          return sendError(reply, 501, SWARMS_MISSING, 'UNIMPLEMENTED');
        }
        return sendRouteError(request, reply, error, 'swarm run error');
      }
    }
  );

  fastify.post<{ Params: SwarmParams; Body: SwarmRunRequest }>(
    '/swarms/:name/stream',
    { schema: runSchema, preValidation: runBody },
    async (request, reply) => {
      const { name } = request.params;
      const swarmConfig = findSwarm(name);

      if (!swarmConfig) {
        return sendError(reply, 404, `Swarm '${name}' not found`, 'NOT_FOUND');
      }

      if (await refuseThread(request, reply, request.body.threadId)) return reply;

      const writer = new FastifyStreamWriter(reply, {
        heartbeatMs: fastify.cogitator.sseHeartbeatMs,
      });
      const messageId = generateId('swarm');

      let disconnected = false;
      let abortSwarm: (() => void) | undefined;
      onClientDisconnect(reply, () => {
        disconnected = true;
        abortSwarm?.();
        writer.close();
      });

      try {
        const { Swarm } = await import('@cogitator-ai/swarms');
        await withSwarm(new Swarm(fastify.cogitator.runtime, swarmConfig), async (swarm) => {
          abortSwarm = () => swarm.abort();
          if (disconnected) swarm.abort();

          writer.start(messageId);

          const result = await swarm.run({
            input: request.body.input,
            context: request.body.context,
            threadId: request.body.threadId,
            userId: request.cogitatorAuth?.userId,
            timeout: swarmTimeoutWithin(request.body.timeout, fastify.cogitator.limits),
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
                error: resolveError(request, error, `swarm agent ${agentName} error`).message,
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
        });
      } catch (error) {
        if (isModuleNotFound(error)) {
          return sendError(reply, 501, SWARMS_MISSING, 'UNIMPLEMENTED');
        }
        if (!disconnected) {
          const resolved = resolveError(request, error, 'swarm stream error');
          writer.error(resolved.message, resolved.code);
        }
      } finally {
        writer.close();
      }

      return reply;
    }
  );

  fastify.get<{ Params: SwarmParams }>(
    '/swarms/:name/blackboard',
    { schema: { params: paramsSchema } },
    async (request, reply) => {
      const { name } = request.params;
      const swarmConfig = findSwarm(name);

      if (!swarmConfig) {
        return sendError(reply, 404, `Swarm '${name}' not found`, 'NOT_FOUND');
      }

      if (!swarmConfig.blackboard?.enabled) {
        return sendError(reply, 400, 'Blackboard not enabled for this swarm', 'INVALID_INPUT');
      }

      const response: BlackboardResponse = {
        sections: swarmConfig.blackboard.sections || {},
      };

      return response;
    }
  );
};
