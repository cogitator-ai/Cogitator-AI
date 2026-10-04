/**
 * Serve Cogitator agents as MCP tools, for Claude Desktop, Cursor or any MCP client.
 */

import type {
  Agent,
  ResumeOptions,
  RunCheckpoint,
  RunOptions,
  RunResult,
  Tool,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolSchema,
} from '@cogitator-ai/types';
import { z } from 'zod';
import type { MCPServerConfig, MCPToolContext } from '../types';
import { MCPServer } from './mcp-server';

/** What serving agents needs from a Cogitator: running them and resuming paused runs. */
export interface AgentHost {
  run(agent: Agent, options: RunOptions): Promise<RunResult>;
  resume(agent: Agent, target: RunCheckpoint | string, options?: ResumeOptions): Promise<RunResult>;
}

export interface ServeAgentsConfig extends Partial<MCPServerConfig> {
  /** Tool name per agent, instead of the agent's name */
  toolNames?: Record<string, string>;
}

/** What an agent tool answers: the agent's reply, or the approvals its run waits for. */
export type AgentToolAnswer =
  | { status: 'completed'; output: string; threadId: string }
  | {
      status: 'paused';
      threadId: string;
      pendingApprovals: ToolApprovalRequest[];
      next: string;
    };

const askSchema = z.object({
  task: z.string().min(1).describe('What to ask the agent to do'),
  threadId: z
    .string()
    .min(1)
    .optional()
    .describe('Continue an earlier conversation: the threadId a previous answer returned'),
});

const resumeSchema = z.object({
  threadId: z.string().min(1).describe('The threadId of the paused answer'),
  approved: z.boolean().describe("The user's decision on the calls the agent waits for"),
  reason: z.string().optional().describe('Why the user declined, when they did'),
});

/**
 * MCP tools for `agents`: one per agent that takes a task (and optionally the
 * thread to continue) and answers with the agent's reply, plus a
 * `<agent>_resume` tool for agents whose tools need approval. Approvals are
 * asked from the person at the client through MCP elicitation; a client that
 * cannot answer gets a paused answer to resume once the user decided.
 */
export function agentTools(
  host: AgentHost,
  agents: readonly Agent[],
  toolNames: Record<string, string> = {}
): Tool[] {
  return agents.flatMap((agent) => {
    const name = toolNames[agent.name] ?? toToolName(agent.name);
    const resumeName = `${name}_resume`;
    const needsApprovals = agent.tools.some(
      (t) => t.requiresApproval === true || typeof t.requiresApproval === 'function'
    );

    const ask = defineTool({
      name,
      description:
        agent.config.description ??
        `Ask the ${agent.name} agent. ${firstSentence(agent.instructions)}`,
      parameters: askSchema,
      execute: async ({ task, threadId }, context) =>
        answer(
          await host.run(agent, {
            input: task,
            ...(threadId && { threadId }),
            ...runContext(context),
          }),
          resumeName
        ),
    });
    if (!needsApprovals) return [ask];

    const resume = defineTool({
      name: resumeName,
      description: `Continue a ${agent.name} answer that waits for the user's approval, with the user's decision.`,
      parameters: resumeSchema,
      execute: async ({ threadId, approved, reason }, context) =>
        answer(
          await host.resume(agent, threadId, {
            defaultDecision: approved ? { approved: true } : { approved: false, reason },
            ...runContext(context),
          }),
          resumeName
        ),
    });
    return [ask, resume];
  });
}

/**
 * Serve `agents` over MCP in one call.
 *
 * @example
 * ```ts
 * await serveAgents(cog, [researcher, writer]); // stdio, for Claude Desktop
 * await serveAgents(cog, [support], { transport: 'http', port: 3333, auth });
 * ```
 */
export async function serveAgents(
  host: AgentHost,
  agents: Agent | readonly Agent[],
  config: ServeAgentsConfig = {}
): Promise<MCPServer> {
  const list = Array.isArray(agents) ? agents : [agents as Agent];
  const { toolNames, ...serverConfig } = config;
  const server = new MCPServer({
    name: 'cogitator-agents',
    version: '1.0.0',
    transport: 'stdio',
    sessions: true,
    ...serverConfig,
  });
  server.registerTools(agentTools(host, list, toolNames));
  await server.start();
  return server;
}

function runContext(context: MCPToolContext) {
  const { elicit } = context;
  return {
    signal: context.signal,
    ...(context.userId !== undefined && { userId: context.userId }),
    onApproval: async (request: ToolApprovalRequest): Promise<ToolApprovalDecision | 'pause'> => {
      if (!elicit) return 'pause';
      const reply = await elicit({
        message: `The agent wants to run ${request.toolName} (${request.description}) with ${JSON.stringify(request.arguments)}. Approve?`,
        schema: {
          type: 'object',
          properties: {
            approve: { type: 'boolean', title: 'Approve', default: false },
            reason: { type: 'string', title: 'Reason (if you decline)' },
          },
          required: ['approve'],
        },
      });
      if (!reply) return 'pause';
      if (reply.action !== 'accept') return { approved: false, reason: 'The user declined' };
      const reason = typeof reply.content.reason === 'string' ? reply.content.reason : undefined;
      return reply.content.approve === true
        ? { approved: true }
        : { approved: false, ...(reason && { reason }) };
    },
  };
}

function answer(result: RunResult, resumeName: string): AgentToolAnswer {
  if (result.status === 'paused') {
    return {
      status: 'paused',
      threadId: result.threadId,
      pendingApprovals: [...(result.pendingApprovals ?? [])],
      next: `Ask the user whether to allow these calls, then call ${resumeName} with this threadId and their decision.`,
    };
  }
  return { status: 'completed', output: result.output, threadId: result.threadId };
}

function defineTool<TParams>(definition: {
  name: string;
  description: string;
  parameters: z.ZodType<TParams>;
  execute: (params: TParams, context: MCPToolContext) => Promise<AgentToolAnswer>;
}): Tool<TParams, AgentToolAnswer> {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    sideEffects: ['external'],
    execute: (params, context) => definition.execute(params, context),
    toJSON: (): ToolSchema => ({
      name: definition.name,
      description: definition.description,
      parameters: z.toJSONSchema(definition.parameters) as ToolSchema['parameters'],
    }),
  };
}

function toToolName(name: string): string {
  const cleaned = trimUnderscores(name.replace(/[^a-zA-Z0-9_-]+/g, '_'));
  return (cleaned || 'agent').slice(0, 56);
}

function trimUnderscores(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '_') start++;
  while (end > start && value[end - 1] === '_') end--;
  return value.slice(start, end);
}

function firstSentence(text: string): string {
  const sentence = /^[^.!?\n]+[.!?]?/.exec(text.trim())?.[0] ?? '';
  return sentence.slice(0, 200);
}
