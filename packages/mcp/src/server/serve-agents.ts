/**
 * Serve Cogitator agents as MCP tools, for Claude Desktop, Cursor or any MCP client.
 */

import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import type {
  Agent,
  ResumeOptions,
  RunCheckpoint,
  RunInterrupt,
  RunOptions,
  RunResult,
  Tool,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolInvoker,
  ToolSchema,
} from '@cogitator-ai/types';
import { pendingQuestions } from '@cogitator-ai/core';
import { z } from 'zod';
import type { MCPServerConfig, MCPToolContext } from '../types';
import { MCPServer } from './mcp-server';
import { elicitApproval } from './approval';
import { elicitAnswers, refusedQuestion } from './questions';

/** How often a question is asked when the run refuses its answers, before the call fails. */
const MAX_ANSWER_ATTEMPTS = 3;

/**
 * What serving agents needs from a Cogitator: running them and resuming paused runs. A host that
 * is also a `ToolInvoker` (a `Cogitator` is) runs the server's tool calls too.
 */
export interface AgentHost extends Partial<ToolInvoker> {
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
 * cannot answer gets a paused answer to resume once the user decided. Questions
 * the agent's tools ask (`context.interrupt()`) are asked through elicitation
 * too; when the client cannot answer one, the call fails with an error naming it.
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
        settle(
          host,
          agent,
          await host.run(agent, {
            input: task,
            ...(threadId && { threadId }),
            ...runContext(context),
          }),
          context,
          resumeName
        ),
    });
    if (!needsApprovals) return [ask];

    const resume = defineTool({
      name: resumeName,
      description: `Continue a ${agent.name} answer that waits for the user's approval, with the user's decision.`,
      parameters: resumeSchema,
      execute: async ({ threadId, approved, reason }, context) =>
        settle(
          host,
          agent,
          await host.resume(agent, threadId, {
            defaultDecision: approved ? { approved: true } : { approved: false, reason },
            ...runContext(context),
          }),
          context,
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
  const invokeTool = host.invokeTool?.bind(host);
  const server = new MCPServer({
    name: 'cogitator-agents',
    version: '1.0.0',
    transport: 'stdio',
    sessions: true,
    ...(invokeTool && { toolInvoker: { invokeTool } }),
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
    onApproval: async (request: ToolApprovalRequest): Promise<ToolApprovalDecision | 'pause'> =>
      (await elicitApproval(elicit, request)) ?? 'pause',
  };
}

/**
 * The answer of a run, after the questions its tools asked (`context.interrupt()`) were put to
 * the person at the client through elicitation and the run resumed with their answers, as often
 * as it asks. A question nobody can answer there fails the call with an error that names it,
 * since resuming without an answer would only pause on it again.
 */
async function settle(
  host: AgentHost,
  agent: Agent,
  initial: RunResult,
  context: MCPToolContext,
  resumeName: string
): Promise<AgentToolAnswer> {
  let result = initial;
  let questions = pendingQuestions(result);
  while (questions.length > 0) {
    result = await resumeWithAnswers(host, agent, result, questions, context);
    questions = pendingQuestions(result);
  }
  return answer(result, resumeName);
}

/**
 * Resumes `paused` with the answers of the person at the client to `questions`. An answer the
 * run refuses as not matching its question's schema (`INTERRUPT_ANSWER_INVALID`) is asked again,
 * the next form saying why, up to `MAX_ANSWER_ATTEMPTS` times per question, the other answers
 * are kept.
 *
 * @throws CogitatorError `INTERRUPT_ANSWER_INVALID` naming the question once its answers were
 * refused `MAX_ANSWER_ATTEMPTS` times. The run stays paused
 */
async function resumeWithAnswers(
  host: AgentHost,
  agent: Agent,
  paused: RunResult,
  questions: readonly RunInterrupt[],
  context: MCPToolContext
): Promise<RunResult> {
  const responses: Record<string, unknown> = {};
  const problems = new Map<string, string>();
  const asked = new Map<string, number>();
  let asking = questions;
  for (;;) {
    for (const question of asking) asked.set(question.id, (asked.get(question.id) ?? 0) + 1);
    Object.assign(responses, await elicitAnswers(context.elicit, asking, agent.name, problems));
    try {
      return await host.resume(agent, paused.checkpoint ?? paused.threadId, {
        responses: { ...responses },
        ...runContext(context),
      });
    } catch (error) {
      const refused = refusedQuestion(error, questions);
      if (!refused || context.signal?.aborted) throw error;
      const { question, problem } = refused;
      if ((asked.get(question.id) ?? 0) >= MAX_ANSWER_ATTEMPTS) {
        throw new CogitatorError({
          message:
            `Agent "${agent.name}" asked ${question.reason} ("${question.message}") ` +
            `${MAX_ANSWER_ATTEMPTS} times and refused every answer, the last one because: ${problem}. ` +
            'The run stays paused: answer it with cogitator.resume() and responses.',
          code: ErrorCode.INTERRUPT_ANSWER_INVALID,
          details: { interrupt: { ...question } },
        });
      }
      problems.set(question.id, `That answer was refused: ${problem}`);
      delete responses[question.id];
      asking = [question];
    }
  }
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
