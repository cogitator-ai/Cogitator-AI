import { describe, it, expect, vi } from 'vitest';
import type {
  AgentWireRunResult,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  Tool,
  ToolCall,
  ToolContext,
} from '@cogitator-ai/types';
import { ErrorCode } from '@cogitator-ai/types';
import { z } from 'zod';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { fromAgentWireRunResult, toAgentWireRunResult } from '../agent-wire';
import { AgentRunPausedError, findAgentRunPausedError, isPausedRun } from '../run-pause';

const refundImpl = vi.fn(async ({ order }: { order: string }) => ({ refunded: order }));
const refund = tool({
  name: 'refund',
  description: 'Refund an order',
  parameters: z.object({ order: z.string() }),
  requiresApproval: true,
  execute: refundImpl,
});

const refundCall: ToolCall = { id: 'c1', name: 'refund', arguments: { order: 'A-1' } };

function scriptedBackend(): LLMBackend {
  const respond = (request: ChatRequest): ChatResponse => {
    const results = request.messages.filter((m) => m.role === 'tool');
    if (results.length === 0) {
      return {
        id: 'r1',
        content: 'Let me refund that.',
        toolCalls: [refundCall],
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    }
    return {
      id: 'r2',
      content: `Done: ${results.map((m) => String(m.content)).join(' | ')}`,
      finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    };
  };
  return {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => respond(request)),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
}

const agent = new Agent({
  name: 'support',
  model: 'mock/m',
  instructions: 'Handle refunds.',
  tools: [refund],
});

const newCogitator = (config: ConstructorParameters<typeof Cogitator>[0] = {}) =>
  new Cogitator({ ...config, llm: { backends: { mock: scriptedBackend() } } });

describe('a paused run on the wire', () => {
  it('keeps the pause, the waiting calls and the checkpoint', async () => {
    const cog = newCogitator();
    const paused = await cog.run(agent, { input: 'Refund A-1' });

    const wire = JSON.parse(JSON.stringify(toAgentWireRunResult(paused))) as AgentWireRunResult;

    expect(wire.status).toBe('paused');
    expect(wire.pendingApprovals).toEqual([
      expect.objectContaining({ toolCallId: 'c1', toolName: 'refund' }),
    ]);
    expect(wire.checkpoint?.threadId).toBe(paused.threadId);
    expect(isPausedRun(wire)).toBe(true);

    const back = fromAgentWireRunResult(wire, { agentId: agent.id });
    expect(back.status).toBe('paused');
    expect(back.pendingApprovals).toEqual(wire.pendingApprovals);
    expect(back.checkpoint).toEqual(wire.checkpoint);
    await cog.close();
  });

  it('resumes from the wire checkpoint on another runtime', async () => {
    refundImpl.mockClear();
    const sender = newCogitator();
    const paused = await sender.run(agent, { input: 'Refund A-1' });
    const wire = JSON.parse(JSON.stringify(toAgentWireRunResult(paused))) as AgentWireRunResult;

    const receiver = newCogitator();
    const result = await receiver.resume(agent, wire.checkpoint!, {
      decisions: { c1: { approved: true } },
    });

    expect(result.status).toBe('completed');
    expect(refundImpl).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('"refunded":"A-1"');
    await Promise.all([sender.close(), receiver.close()]);
  });

  it('marks a completed run as completed', async () => {
    const cog = newCogitator();
    const result = await cog.run(agent, {
      input: 'Refund A-1',
      onApproval: () => ({ approved: true }),
    });
    const wire = toAgentWireRunResult(result);
    expect(wire.status).toBe('completed');
    expect(isPausedRun(wire)).toBe(false);
    expect(wire.checkpoint).toBeUndefined();
    await cog.close();
  });
});

describe('AgentRunPausedError', () => {
  it('names the agent, where it paused and the calls it waits on', async () => {
    const cog = newCogitator();
    const paused = await cog.run(agent, { input: 'Refund A-1' });

    const error = new AgentRunPausedError(paused, 'support', 'workflow "refunds", node "pay"');

    expect(error).toBeInstanceOf(AgentRunPausedError);
    expect(error.code).toBe(ErrorCode.RUN_PAUSED);
    expect(error.statusCode).toBe(409);
    expect(error.message).toContain('Agent "support" paused in workflow "refunds", node "pay"');
    expect(error.message).toContain('refund');
    expect(error.threadId).toBe(paused.threadId);
    expect(error.checkpoint).toEqual(paused.checkpoint);
    expect(error.pendingApprovals.map((p) => p.toolCallId)).toEqual(['c1']);
    await cog.close();
  });

  it('is found behind the errors that wrap it', () => {
    const paused = new AgentRunPausedError({ threadId: 't1', pendingApprovals: [] }, 'support');
    const wrapped = new Error('node failed', {
      cause: new Error('step failed', { cause: paused }),
    });

    expect(findAgentRunPausedError(wrapped)).toBe(paused);
    expect(findAgentRunPausedError(new Error('other'))).toBeUndefined();
    expect(findAgentRunPausedError('text')).toBeUndefined();
  });
});

describe('Cogitator.invokeTool', () => {
  it('refuses a call that needs approval when nobody decides it', async () => {
    refundImpl.mockClear();
    const cog = newCogitator();

    const result = await cog.invokeTool(refund, { order: 'A-1' }, { toolCallId: 'x1' });

    expect(refundImpl).not.toHaveBeenCalled();
    expect(result.callId).toBe('x1');
    expect(result.error).toContain('needs approval');
    expect(result.pendingApproval).toEqual(
      expect.objectContaining({ toolCallId: 'x1', toolName: 'refund', arguments: { order: 'A-1' } })
    );
    await cog.close();
  });

  it('runs an approved call and refuses a declined one', async () => {
    refundImpl.mockClear();
    const cog = newCogitator();

    const approved = await cog.invokeTool(
      refund,
      { order: 'A-1' },
      { onApproval: () => ({ approved: true }) }
    );
    const declined = await cog.invokeTool(
      refund,
      { order: 'A-2' },
      { onApproval: () => ({ approved: false, reason: 'too much' }) }
    );

    expect(approved.error).toBeUndefined();
    expect(approved.result).toEqual({ refunded: 'A-1' });
    expect(declined.error).toBe('The user declined this tool call: too much');
    expect(refundImpl).toHaveBeenCalledTimes(1);
    await cog.close();
  });

  it('asks guardrails.onToolApproval when the call has no onApproval', async () => {
    refundImpl.mockClear();
    const onToolApproval = vi.fn(async () => true);
    const cog = new Cogitator({
      llm: { defaultModel: 'mock/m', backends: { mock: scriptedBackend() } },
      guardrails: { enabled: false, onToolApproval },
    });

    const result = await cog.invokeTool(refund, { order: 'A-1' });

    expect(onToolApproval).toHaveBeenCalledWith('refund', { order: 'A-1' }, []);
    expect(result.result).toEqual({ refunded: 'A-1' });
    await cog.close();
  });

  it('validates the arguments against the schema before running the tool', async () => {
    const execute = vi.fn(async () => 'ran');
    const strict = tool({
      name: 'strict',
      description: 'Takes a number',
      parameters: z.object({ n: z.number() }),
      execute,
    });
    const cog = newCogitator();

    const result = await cog.invokeTool(strict, { n: 'one' });

    expect(execute).not.toHaveBeenCalled();
    expect(result.error).toContain('Invalid arguments');
    await cog.close();
  });

  it('runs a tool whose parameters are a JSON schema', async () => {
    const execute = vi.fn(async (args: unknown) => ({ got: args }));
    const jsonSchemaTool = {
      name: 'json_tool',
      description: 'Has a JSON schema',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      execute,
      toJSON: () => ({
        name: 'json_tool',
        description: 'Has a JSON schema',
        parameters: { type: 'object' as const, properties: { q: { type: 'string' } } },
      }),
    } as unknown as Tool;
    const cog = newCogitator();

    const result = await cog.invokeTool(jsonSchemaTool, { q: 'hi' });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ got: { q: 'hi' } });
    await cog.close();
  });

  it('keeps the tool timeout', async () => {
    const slow = tool({
      name: 'slow',
      description: 'Never ends in time',
      parameters: z.object({}),
      timeout: 20,
      execute: (_args, context) =>
        new Promise<string>((resolve) => {
          const timer = setTimeout(() => resolve('late'), 5_000);
          context.signal.addEventListener('abort', () => clearTimeout(timer));
        }),
    });
    const cog = newCogitator();

    const result = await cog.invokeTool(slow, {});

    expect(result.error).toBe('Tool "slow" timed out after 20ms');
    await cog.close();
  });

  it('gives the tool its context and the extra fields, without letting them replace the run ids', async () => {
    let seen: (ToolContext & Record<string, unknown>) | undefined;
    const probe = tool({
      name: 'probe',
      description: 'Records its context',
      parameters: z.object({}),
      execute: async (_args, context) => {
        seen = context as ToolContext & Record<string, unknown>;
        return 'ok';
      },
    });
    const elicit = vi.fn();
    const cog = newCogitator();

    await cog.invokeTool(
      probe,
      {},
      {
        runId: 'run-1',
        agentId: 'mcp-server',
        userId: 'u1',
        context: { elicit, runId: 'forged' },
      }
    );

    expect(seen?.runId).toBe('run-1');
    expect(seen?.agentId).toBe('mcp-server');
    expect(seen?.userId).toBe('u1');
    expect(seen?.elicit).toBe(elicit);
    await cog.close();
  });
});
