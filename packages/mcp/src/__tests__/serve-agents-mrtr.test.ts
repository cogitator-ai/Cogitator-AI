import { afterEach, describe, expect, it, vi } from 'vitest';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import type {
  Agent,
  AgentConfig,
  ResumeOptions,
  RunCheckpoint,
  RunInterrupt,
  RunOptions,
  RunResult,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from '@cogitator-ai/types';
import { serveAgents, type AgentHost } from '../server/serve-agents';
import type { MCPServer } from '../server/mcp-server';
import { MCPClient } from '../client/mcp-client';
import type { MCPElicitRequest, MCPElicitResult, MCPElicitUrlRequest } from '../types';
import { ELICITATION, rawRequest } from './support/raw-mcp';

function fakeAgent(name: string, config: Partial<AgentConfig> = {}): Agent {
  const full: AgentConfig = { name, instructions: `You are ${name}.`, ...config };
  return {
    id: `agent_${name}`,
    name,
    config: full,
    model: 'mock/m',
    instructions: full.instructions,
    tools: [],
    clone: () => fakeAgent(name, config),
    serialize: () => {
      throw new Error('unused');
    },
  };
}

function result(partial: Partial<RunResult>): RunResult {
  return {
    output: '',
    runId: 'run_1',
    agentId: 'a',
    threadId: 't1',
    status: 'completed',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0, duration: 1 },
    toolCalls: [],
    messages: [],
    trace: { traceId: 'tr', spans: [] },
    ...partial,
  };
}

const pending: ToolApprovalRequest = {
  toolCallId: 'c1',
  toolName: 'refund',
  arguments: { amount: 500 },
  description: 'Refund money',
  suggestedRule: 'refund(amount:500)',
};

const question: RunInterrupt = {
  id: 'q1#0',
  kind: 'input',
  reason: 'confirm_plan',
  message: 'Go ahead with the move?',
  responseSchema: {
    type: 'object',
    properties: { ok: { type: 'boolean', title: 'OK' } },
    required: ['ok'],
  },
  toolCallId: 'q1',
  toolName: 'confirm_plan',
};

const checkpoint = { version: 1, runId: 'run_1', threadId: 't1' } as RunCheckpoint;

let server: MCPServer | undefined;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await server?.stop();
  server = undefined;
});

async function serveHttp(host: AgentHost, allowRemember = false): Promise<string> {
  server = await serveAgents(host, [fakeAgent('support')], {
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
    allowRemember,
  });
  return `http://127.0.0.1:${server.getPort()}/mcp`;
}

async function modernClient(
  url: string,
  answer: (request: MCPElicitRequest | MCPElicitUrlRequest) => MCPElicitResult
) {
  const asked: string[] = [];
  const client = await MCPClient.connect({
    transport: 'http',
    url,
    elicitation: async (request) => {
      asked.push(request.message);
      return answer(request);
    },
  });
  cleanups.push(() => client.close());
  expect(client.era).toBe('modern');
  return { client, asked };
}

describe('serveAgents on protocol 2026-07-28', () => {
  it('pauses the run on an approval, asks it with the round, and resumes with the decision', async () => {
    const decisions: Array<ToolApprovalDecision | 'pause'> = [];
    const run = vi.fn(async (_agent: Agent, options: RunOptions) => {
      const decision = (await options.onApproval?.(pending)) ?? 'pause';
      decisions.push(decision);
      return result({ status: 'paused', pendingApprovals: [pending], checkpoint });
    });
    const resume = vi.fn(
      async (_agent: Agent, _target: RunCheckpoint | string, options?: ResumeOptions) =>
        result({ output: `resumed ${JSON.stringify(options?.decisions)}` })
    );
    const url = await serveHttp({ run, resume }, true);
    const { client, asked } = await modernClient(url, () => ({
      action: 'accept',
      content: { approve: true, always: true },
    }));

    const reply = (await client.callTool('support', { task: 'refund order 42' })) as {
      output: string;
    };

    expect(decisions).toEqual(['pause']);
    expect(asked[0]).toContain('refund');
    expect(run).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(
      expect.anything(),
      't1',
      expect.objectContaining({ decisions: { c1: { approved: true, remember: true } } })
    );
    expect(reply.output).toBe('resumed {"c1":{"approved":true,"remember":true}}');
  });

  it("asks its tools' questions with the round and resumes with the answers", async () => {
    const run = vi.fn(async () =>
      result({ status: 'paused', pendingApprovals: [], interrupts: [question], checkpoint })
    );
    const resume = vi.fn(
      async (_agent: Agent, _target: RunCheckpoint | string, options?: ResumeOptions) =>
        result({ output: `answered ${JSON.stringify(options?.responses)}` })
    );
    const url = await serveHttp({ run, resume });
    const { client, asked } = await modernClient(url, () => ({
      action: 'accept',
      content: { ok: true },
    }));

    const reply = (await client.callTool('support', { task: 'plan the move' })) as {
      output: string;
    };

    expect(asked).toEqual(['Go ahead with the move?']);
    expect(reply.output).toBe('answered {"q1#0":{"ok":true}}');
  });

  it('asks a refused answer again saying why, and gives up after three tries', async () => {
    const run = vi.fn(async () =>
      result({ status: 'paused', pendingApprovals: [], interrupts: [question], checkpoint })
    );
    const resume = vi.fn(async () => {
      throw new CogitatorError({
        message: 'The answer does not match its schema: too short',
        code: ErrorCode.INTERRUPT_ANSWER_INVALID,
        details: { interruptId: question.id },
      });
    });
    const url = await serveHttp({ run, resume });
    const { client, asked } = await modernClient(url, () => ({
      action: 'accept',
      content: { ok: false },
    }));

    const error = await client.callTool('support', { task: 'plan' }).catch((e: unknown) => e);

    expect(String(error)).toContain('refused every answer');
    expect(asked).toHaveLength(3);
    expect(asked[1]).toContain('That answer was refused');
    expect(resume).toHaveBeenCalledTimes(3);
  });

  it('fails with the question when the person declines it', async () => {
    const run = vi.fn(async () =>
      result({ status: 'paused', pendingApprovals: [], interrupts: [question], checkpoint })
    );
    const resume = vi.fn();
    const url = await serveHttp({ run, resume });
    const { client } = await modernClient(url, () => ({ action: 'decline' }));

    const error = await client.callTool('support', { task: 'plan' }).catch((e: unknown) => e);

    expect(String(error)).toContain('the user declined to answer');
    expect(resume).not.toHaveBeenCalled();
  });

  it('refuses answers that come back with a state that does not verify', async () => {
    const run = vi.fn(async (_agent: Agent, options: RunOptions) => {
      await options.onApproval?.(pending);
      return result({ status: 'paused', pendingApprovals: [pending], checkpoint });
    });
    const resume = vi.fn();
    const url = await serveHttp({ run, resume });

    const first = await rawRequest(url, 'tools/call', {
      capabilities: ELICITATION,
      params: { name: 'support', arguments: { task: 'refund' } },
    });
    const forged = await rawRequest(url, 'tools/call', {
      capabilities: ELICITATION,
      params: {
        name: 'support',
        arguments: { task: 'refund' },
        requestState: `${String(first.result?.requestState).slice(0, -3)}abc`,
        inputResponses: { 'approval:c1': { action: 'accept', content: { approve: true } } },
      },
    });

    expect(forged.result?.isError).toBe(true);
    expect(JSON.stringify(forged.result?.content)).toContain('state expired');
    expect(resume).not.toHaveBeenCalled();
  });

  it('answers a paused run to a client without elicitation, to resume with <agent>_resume', async () => {
    const run = vi.fn(async (_agent: Agent, options: RunOptions) => {
      const decision = (await options.onApproval?.(pending)) ?? 'pause';
      return decision === 'pause'
        ? result({ status: 'paused', pendingApprovals: [pending], checkpoint })
        : result({ output: 'done' });
    });
    const url = await serveHttp({ run, resume: vi.fn() });
    const client = await MCPClient.connect({ transport: 'http', url });
    cleanups.push(() => client.close());

    const reply = await client.callTool('support', { task: 'refund' });

    expect(reply).toMatchObject({ status: 'paused', threadId: 't1' });
  });
});

describe('serveAgents rounds with several requests', () => {
  const second: RunInterrupt = {
    ...question,
    id: 'q2#0',
    reason: 'pick_day',
    message: 'Which day?',
    responseSchema: {
      type: 'object',
      properties: { day: { type: 'string', title: 'Day' } },
      required: ['day'],
    },
    toolCallId: 'q2',
  };

  function twoQuestionsAndApproval(refusals: number) {
    let left = refusals;
    const run = vi.fn(async (_agent: Agent, options: RunOptions) => {
      await options.onApproval?.(pending);
      return result({
        status: 'paused',
        pendingApprovals: [pending],
        interrupts: [question, second],
        checkpoint,
      });
    });
    const resume = vi.fn(
      async (_agent: Agent, _target: RunCheckpoint | string, options?: ResumeOptions) => {
        if (left > 0) {
          left--;
          throw new CogitatorError({
            message: 'The answer does not match its schema: not ok',
            code: ErrorCode.INTERRUPT_ANSWER_INVALID,
            details: { interruptId: question.id },
          });
        }
        return result({
          output: `resumed ${JSON.stringify({ d: options?.decisions, r: options?.responses })}`,
        });
      }
    );
    return { run, resume };
  }

  it('resubmits every accepted answer and decision with the corrected one', async () => {
    const { run, resume } = twoQuestionsAndApproval(1);
    const url = await serveHttp({ run, resume });
    let okAnswers = 0;
    const { client } = await modernClient(url, (request) => {
      if (request.message.includes('Which day'))
        return { action: 'accept', content: { day: 'mon' } };
      if (request.message.includes('Go ahead')) {
        okAnswers++;
        return { action: 'accept', content: { ok: okAnswers > 1 } };
      }
      return { action: 'accept', content: { approve: true } };
    });

    const reply = (await client.callTool('support', { task: 'plan' })) as { output: string };

    expect(resume).toHaveBeenCalledTimes(2);
    const last = resume.mock.calls[1]?.[2];
    expect(last?.decisions).toEqual({ c1: { approved: true } });
    expect(last?.responses).toEqual({ 'q1#0': { ok: true }, 'q2#0': { day: 'mon' } });
    expect(reply.output).toContain('"q2#0":{"day":"mon"}');
  });

  it('keeps the answers of a partial round and asks only for the missing ones', async () => {
    const { run, resume } = twoQuestionsAndApproval(0);
    const url = await serveHttp({ run, resume });
    const send = (extra: Record<string, unknown>) =>
      rawRequest(url, 'tools/call', {
        capabilities: ELICITATION,
        params: { name: 'support', arguments: { task: 'plan' }, ...extra },
      });

    const first = await send({});
    expect(Object.keys(first.result?.inputRequests as object).sort()).toEqual([
      'approval:c1',
      'question:q1#0',
      'question:q2#0',
    ]);
    const partial = await send({
      requestState: first.result?.requestState,
      inputResponses: {
        'approval:c1': { action: 'accept', content: { approve: true } },
        'question:q1#0': { action: 'accept', content: { ok: true } },
      },
    });
    expect(Object.keys(partial.result?.inputRequests as object)).toEqual(['question:q2#0']);
    const done = await send({
      requestState: partial.result?.requestState,
      inputResponses: { 'question:q2#0': { action: 'accept', content: { day: 'tue' } } },
    });

    expect(done.result?.isError).toBeFalsy();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]?.[2]).toMatchObject({
      decisions: { c1: { approved: true } },
      responses: { 'q1#0': { ok: true }, 'q2#0': { day: 'tue' } },
    });
  });
});
