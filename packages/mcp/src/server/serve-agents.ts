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
  ToolApp,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolInvoker,
  ToolSchema,
} from '@cogitator-ai/types';
import { pendingQuestions } from '@cogitator-ai/core';
import { z } from 'zod';
import type {
  MCPElicitRequest,
  MCPElicitResult,
  MCPInputPending,
  MCPServerConfig,
  MCPToolContext,
  MCPToolInput,
} from '../types';
import { MCPServer } from './mcp-server';
import { approvalDecision, approvalForm, elicitApproval } from './approval';
import { answerOfReply, elicitAnswers, questionRequest, refusedQuestion } from './questions';

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

/** How the agent tools of {@link agentTools} answer approvals */
export interface AgentToolsOptions {
  /**
   * Let an approval save an "always allow" rule (`remember: true`): the elicitation form offers
   * it when a call suggests a rule, and `<agent>_resume` takes `remember`. Off by default, since
   * the model at the client calls `<agent>_resume` and could otherwise allow calls for good on its
   * own
   */
  allowRemember?: boolean;
  /**
   * An MCP App per agent, by agent name (see `mcpApp()`): the agent's tool points at it, so a host
   * shows the app with the agent's answers, and the server serves it
   */
  apps?: Record<string, ToolApp>;
}

export interface ServeAgentsConfig extends Partial<MCPServerConfig>, AgentToolsOptions {
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

/** What an agent tool keeps between rounds of a call that asks the user */
const RoundStateSchema = z.object({
  agent: z.string(),
  threadId: z.string(),
  approvals: z.array(z.object({ toolCallId: z.string(), offersAlways: z.boolean() })),
  questions: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['approval', 'input', 'plan', 'budget']),
      reason: z.string(),
      message: z.string(),
      responseSchema: z.record(z.string(), z.unknown()).optional(),
      details: z.record(z.string(), z.unknown()).optional(),
      single: z.boolean(),
    })
  ),
  requests: z.record(
    z.string(),
    z.object({ message: z.string(), schema: z.record(z.string(), z.unknown()) })
  ),
  attempts: z.record(z.string(), z.number()),
  /** The answers the client gave so far, by request key, kept until every request has one */
  answered: z
    .record(
      z.string(),
      z.union([
        z.object({ action: z.literal('accept'), content: z.record(z.string(), z.unknown()) }),
        z.object({ action: z.enum(['decline', 'cancel']) }),
      ])
    )
    .optional(),
});

type RoundState = z.output<typeof RoundStateSchema>;

const rememberingResumeSchema = resumeSchema.extend({
  remember: z
    .boolean()
    .optional()
    .describe(
      'The user approved for good: calls like these run without asking from now on (each saves its suggestedRule)'
    ),
});

/**
 * MCP tools for `agents`: one per agent that takes a task (and optionally the
 * thread to continue) and answers with the agent's reply, plus a
 * `<agent>_resume` tool for every agent: its tools, its `permissions` and the
 * host's rules and settings files may all make a call ask, which the tools
 * cannot know ahead. Approvals are asked from the person at the client through
 * MCP elicitation; a client that cannot answer gets a paused answer to resume
 * once the user decided. Questions the agent's tools ask (`context.interrupt()`)
 * are asked through elicitation too; when the client cannot answer one, the
 * call fails with an error naming it.
 */
export function agentTools(
  host: AgentHost,
  agents: readonly Agent[],
  toolNames: Record<string, string> = {},
  options: AgentToolsOptions = {}
): Tool[] {
  const allowRemember = options.allowRemember === true;
  return agents.flatMap((agent) => {
    const name = toolNames[agent.name] ?? toToolName(agent.name);
    const resumeName = `${name}_resume`;
    const app =
      options.apps && Object.hasOwn(options.apps, agent.name)
        ? options.apps[agent.name]
        : undefined;

    const ask = defineTool({
      name,
      ...(app && { app }),
      description:
        agent.config.description ??
        `Ask the ${agent.name} agent. ${firstSentence(agent.instructions)}`,
      parameters: askSchema,
      execute: async ({ task, threadId }, context) => {
        const input = context.input;
        if (input) {
          const resumed = await resumeRound(host, agent, input, context, resumeName, allowRemember);
          if (resumed) return resumed;
        }
        const result = await host.run(agent, {
          input: task,
          ...(threadId && { threadId }),
          ...runContext(context, allowRemember),
        });
        return input
          ? askInRound(agent, result, input, resumeName, allowRemember, {})
          : settle(host, agent, result, context, resumeName, allowRemember);
      },
    });

    const resume = defineTool({
      name: resumeName,
      description: `Continue a ${agent.name} answer that waits for the user's approval, with the user's decision.`,
      parameters: allowRemember ? rememberingResumeSchema : resumeSchema,
      execute: async (params: z.output<typeof rememberingResumeSchema>, context) => {
        const input = context.input;
        if (input) {
          const resumed = await resumeRound(host, agent, input, context, resumeName, allowRemember);
          if (resumed) return resumed;
        }
        const result = await host.resume(agent, params.threadId, {
          defaultDecision: params.approved
            ? {
                approved: true,
                ...(allowRemember && params.remember === true && { remember: true }),
              }
            : { approved: false, reason: params.reason },
          ...runContext(context, allowRemember),
        });
        return input
          ? askInRound(agent, result, input, resumeName, allowRemember, {})
          : settle(host, agent, result, context, resumeName, allowRemember);
      },
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
  const { toolNames, allowRemember, apps, ...serverConfig } = config;
  const invokeTool = host.invokeTool?.bind(host);
  const server = new MCPServer({
    name: 'cogitator-agents',
    version: '1.0.0',
    transport: 'stdio',
    sessions: true,
    ...(invokeTool && { toolInvoker: { invokeTool } }),
    ...serverConfig,
  });
  server.registerTools(
    agentTools(host, list, toolNames, {
      ...(allowRemember !== undefined && { allowRemember }),
      ...(apps && { apps }),
    })
  );
  await server.start();
  return server;
}

/**
 * How the run of an agent tool decides approvals: by asking the person at the client in place
 * (elicitation), or, when the call asks by ending its rounds (`context.input`), by pausing, the
 * approvals then asked with the round's questions
 */
function runContext(context: MCPToolContext, allowRemember: boolean) {
  const { elicit, input } = context;
  return {
    signal: context.signal,
    ...(context.userId !== undefined && { userId: context.userId }),
    onApproval: async (request: ToolApprovalRequest): Promise<ToolApprovalDecision | 'pause'> =>
      input ? 'pause' : ((await elicitApproval(elicit, request, { allowRemember })) ?? 'pause'),
  };
}

/**
 * Ends the round of a call whose run paused, asking the approvals and questions it waits on,
 * with what the next round needs to resume it. A run that does not wait on any is answered
 */
function askInRound(
  agent: Agent,
  result: RunResult,
  input: MCPToolInput,
  resumeName: string,
  allowRemember: boolean,
  attempts: Record<string, number>,
  problems: ReadonlyMap<string, string> = new Map()
): AgentToolAnswer | MCPInputPending {
  const approvals = result.status === 'paused' ? (result.pendingApprovals ?? []) : [];
  const questions = pendingQuestions(result);
  if (approvals.length === 0 && questions.length === 0) return answer(result, resumeName);

  const requests: Record<string, MCPElicitRequest> = {};
  const state: RoundState = {
    agent: agent.name,
    threadId: result.threadId,
    approvals: [],
    questions: [],
    requests: {},
    attempts,
  };
  for (const approval of approvals) {
    const offersAlways = allowRemember && approval.suggestedRule !== undefined;
    requests[`approval:${approval.toolCallId}`] = approvalForm(approval, { allowRemember });
    state.approvals.push({ toolCallId: approval.toolCallId, offersAlways });
  }
  for (const question of questions) {
    const asked = questionRequest(question, agent.name, problems.get(question.id));
    requests[`question:${question.id}`] = asked.request;
    state.questions.push(questionState(question, asked.single));
  }
  state.requests = Object.fromEntries(
    Object.entries(requests).map(([key, request]) => [
      key,
      { message: request.message, schema: request.schema },
    ])
  );
  return input.ask(requests, state);
}

/**
 * The round of a call that comes back with the answers to the approvals and questions of its
 * last round: the run resumes with them. Undefined for a first round. A question still without
 * an answer is asked again, one whose answer the run refuses is asked again saying why, up to
 * `MAX_ANSWER_ATTEMPTS` times
 *
 * @throws CogitatorError `RUN_PAUSED` when the state of the call expired or the person declined
 * a question, `INTERRUPT_ANSWER_INVALID` once a question's answers were refused too often
 */
async function resumeRound(
  host: AgentHost,
  agent: Agent,
  input: MCPToolInput,
  context: MCPToolContext,
  resumeName: string,
  allowRemember: boolean
): Promise<AgentToolAnswer | MCPInputPending | undefined> {
  const parsed = RoundStateSchema.safeParse(input.state);
  if (!parsed.success || parsed.data.agent !== agent.name) {
    if (input.stateRejected) {
      throw new CogitatorError({
        message:
          `The answers for agent "${agent.name}" came back after their state expired, or from ` +
          'another server: call the tool again, or answer the run with cogitator.resume().',
        code: ErrorCode.RUN_PAUSED,
      });
    }
    return undefined;
  }
  const state = parsed.data;
  const answered: Record<string, MCPElicitResult> = {};
  for (const [key, reply] of Object.entries({ ...state.answered, ...input.responses })) {
    if (key in state.requests) answered[key] = reply;
  }
  const missing = Object.keys(state.requests).filter((key) => answered[key] === undefined);
  if (missing.length > 0) {
    const requests = Object.fromEntries(
      missing.map((key) => [key, state.requests[key] as MCPElicitRequest])
    );
    return input.ask(requests, { ...state, answered });
  }

  const decisions: Record<string, ToolApprovalDecision> = {};
  for (const { toolCallId, offersAlways } of state.approvals) {
    const reply = answered[`approval:${toolCallId}`];
    if (reply) decisions[toolCallId] = approvalDecision(reply, offersAlways);
  }
  const paused = pendingAt(state);
  const responses: Record<string, unknown> = {};
  for (const { single, ...question } of state.questions) {
    const reply = answered[`question:${question.id}`];
    if (reply) responses[question.id] = answerOfReply(question, agent.name, reply, single);
  }

  let result: RunResult;
  try {
    result = await host.resume(agent, state.threadId, {
      ...(Object.keys(decisions).length > 0 && { decisions }),
      ...(Object.keys(responses).length > 0 && { responses }),
      ...runContext(context, allowRemember),
    });
  } catch (error) {
    const refused = refusedQuestion(error, paused);
    if (!refused || context.signal?.aborted) throw error;
    const { question, problem } = refused;
    const attempts = (state.attempts[question.id] ?? 1) + 1;
    if (attempts > MAX_ANSWER_ATTEMPTS) {
      throw new CogitatorError({
        message:
          `Agent "${agent.name}" asked ${question.reason} ("${question.message}") ` +
          `${MAX_ANSWER_ATTEMPTS} times and refused every answer, the last one because: ${problem}. ` +
          'The run stays paused: answer it with cogitator.resume() and responses.',
        code: ErrorCode.INTERRUPT_ANSWER_INVALID,
        details: { interrupt: { ...question } },
      });
    }
    const asked = questionRequest(question, agent.name, `That answer was refused: ${problem}`);
    const key = `question:${question.id}`;
    const { [key]: _refused, ...kept } = answered;
    return input.ask(
      { [key]: asked.request },
      {
        ...state,
        questions: state.questions.map((entry) =>
          entry.id === question.id ? questionState(question, asked.single) : entry
        ),
        requests: {
          ...state.requests,
          [key]: { message: asked.request.message, schema: asked.request.schema },
        },
        attempts: { ...state.attempts, [question.id]: attempts },
        answered: kept,
      }
    );
  }
  return askInRound(agent, result, input, resumeName, allowRemember, {});
}

/** The questions of the round's state, as the run asked them */
function pendingAt(state: RoundState): RunInterrupt[] {
  return state.questions.map(({ single: _single, ...question }) => question);
}

/** A question as the round's state keeps it */
function questionState(question: RunInterrupt, single: boolean): RoundState['questions'][number] {
  return {
    id: question.id,
    kind: question.kind,
    reason: question.reason,
    message: question.message,
    ...(question.responseSchema && { responseSchema: question.responseSchema }),
    ...(question.details && { details: question.details }),
    single,
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
  resumeName: string,
  allowRemember: boolean
): Promise<AgentToolAnswer> {
  let result = initial;
  let questions = pendingQuestions(result);
  while (questions.length > 0) {
    result = await resumeWithAnswers(host, agent, result, questions, context, allowRemember);
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
  context: MCPToolContext,
  allowRemember: boolean
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
        ...runContext(context, allowRemember),
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
      pendingApprovals: (result.pendingApprovals ?? []).map(({ rule, ...request }) => ({
        ...request,
        ...(rule && { rule: { rule: rule.rule, behavior: rule.behavior, layer: rule.layer } }),
      })),
      next: `Ask the user whether to allow these calls, then call ${resumeName} with this threadId and their decision.`,
    };
  }
  return { status: 'completed', output: result.output, threadId: result.threadId };
}

function defineTool<TParams>(definition: {
  name: string;
  description: string;
  parameters: z.ZodType<TParams>;
  app?: ToolApp;
  execute: (params: TParams, context: MCPToolContext) => Promise<AgentToolAnswer | MCPInputPending>;
}): Tool<TParams, AgentToolAnswer | MCPInputPending> {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    sideEffects: ['external'],
    ...(definition.app && { app: definition.app }),
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
