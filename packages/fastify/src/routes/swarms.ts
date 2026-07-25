import type { FastifyPluginAsync } from 'fastify';
import type {
  SwarmListResponse,
  SwarmRunRequest,
  SwarmRunResponse,
  BlackboardResponse,
} from '../types.js';
import { SwarmRunRequestSchema } from '../types.js';
import { FastifyStreamWriter, generateId } from '../streaming/index.js';
import {
  CogitatorError,
  type RunResult,
  type SwarmMessage,
  type SwarmEvent,
} from '@cogitator-ai/types';

interface SwarmParams {
  name: string;
}

export const swarmRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/swarms', async () => {
    const swarmList = Object.entries(fastify.cogitator.swarms).map(([name, config]) => {
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
    return response;
  });

  fastify.post<{ Params: SwarmParams; Body: SwarmRunRequest }>(
    '/swarms/:name/run',
    {
      schema: {
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        body: SwarmRunRequestSchema,
      },
    },
    async (request, reply) => {
      const { name } = request.params;
      const swarmConfig = Object.hasOwn(fastify.cogitator.swarms, name)
        ? fastify.cogitator.swarms[name]
        : undefined;

      if (!swarmConfig) {
        return reply.status(404).send({
          error: { message: `Swarm '${name}' not found`, code: 'NOT_FOUND' },
        });
      }

      try {
        const { Swarm } = await import('@cogitator-ai/swarms');
        const swarm = new Swarm(fastify.cogitator.runtime, swarmConfig);

        const result = await swarm.run({
          input: request.body.input,
          context: request.body.context,
          threadId: request.body.threadId,
          timeout: request.body.timeout,
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

        return response;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
          return reply.status(501).send({
            error: { message: 'Swarms package not installed', code: 'UNIMPLEMENTED' },
          });
        }

        if (CogitatorError.isCogitatorError(error)) {
          return reply.status(500).send({ error: { message: error.message, code: error.code } });
        }
        request.log.error({ err: error }, 'swarm run error');
        return reply
          .status(500)
          .send({ error: { message: 'Internal server error', code: 'INTERNAL' } });
      }
    }
  );

  fastify.post<{ Params: SwarmParams; Body: SwarmRunRequest }>(
    '/swarms/:name/stream',
    {
      schema: {
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        body: SwarmRunRequestSchema,
      },
    },
    async (request, reply) => {
      const { name } = request.params;
      const swarmConfig = Object.hasOwn(fastify.cogitator.swarms, name)
        ? fastify.cogitator.swarms[name]
        : undefined;

      if (!swarmConfig) {
        return reply.status(404).send({
          error: { message: `Swarm '${name}' not found`, code: 'NOT_FOUND' },
        });
      }

      const writer = new FastifyStreamWriter(reply);
      const messageId = generateId('swarm');

      request.raw.on('close', () => {
        writer.close();
      });

      try {
        const { Swarm } = await import('@cogitator-ai/swarms');
        const swarm = new Swarm(fastify.cogitator.runtime, swarmConfig);

        writer.start(messageId);

        const result = await swarm.run({
          input: request.body.input,
          context: request.body.context,
          threadId: request.body.threadId,
          timeout: request.body.timeout,
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
        if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
          writer.error('Swarms package not installed', 'UNIMPLEMENTED');
        } else if (CogitatorError.isCogitatorError(error)) {
          writer.error(error.message, error.code);
        } else {
          request.log.error({ err: error }, 'swarm stream error');
          writer.error('Internal server error', 'INTERNAL');
        }
      } finally {
        writer.close();
      }
    }
  );

  fastify.get<{ Params: SwarmParams }>(
    '/swarms/:name/blackboard',
    {
      schema: {
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
    },
    async (request, reply) => {
      const { name } = request.params;
      const swarmConfig = Object.hasOwn(fastify.cogitator.swarms, name)
        ? fastify.cogitator.swarms[name]
        : undefined;

      if (!swarmConfig) {
        return reply.status(404).send({
          error: { message: `Swarm '${name}' not found`, code: 'NOT_FOUND' },
        });
      }

      if (!swarmConfig.blackboard?.enabled) {
        return reply.status(400).send({
          error: { message: 'Blackboard not enabled for this swarm', code: 'INVALID_INPUT' },
        });
      }

      const response: BlackboardResponse = {
        sections: swarmConfig.blackboard.sections || {},
      };

      return response;
    }
  );
};
