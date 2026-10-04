import { describe, it, expect, vi } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ExplorationStrategy,
  LLMBackend,
} from '@cogitator-ai/types';
import { calculateCost } from '@cogitator-ai/models';
import { z } from 'zod';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { ThoughtTreeExecutor } from '../reasoning/thought-tree';

const USAGE = { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 };

interface TreeScript {
  /** Child thoughts generated from a node; the root's thought is `root`. */
  children: (thought: string) => string[];
  /** Branch confidence by thought; kept below 0.8 so the search does not stop early. */
  confidence: (thought: string) => number;
  /** Thoughts whose agent run fails. */
  failing?: string[];
  /** Agent runs keep calling a tool instead of answering. */
  loopTools?: boolean;
}

function treeBackend(script: TreeScript) {
  const executorRequests: ChatRequest[] = [];
  const runs: string[] = [];
  let runCalls = 0;

  const reply = (content: string, extra: Partial<ChatResponse> = {}): ChatResponse => ({
    id: 'r',
    content,
    finishReason: 'stop',
    usage: USAGE,
    ...extra,
  });

  const chat = async (request: ChatRequest): Promise<ChatResponse> => {
    const system = request.messages.find((m) => m.role === 'system');
    const instructions = typeof system?.content === 'string' ? system.content : '';
    const user = request.messages.find((m) => m.role === 'user');
    const prompt = typeof user?.content === 'string' ? user.content : '';

    if (instructions.includes('strategic reasoning assistant')) {
      executorRequests.push(request);
      const parent = /Previous thought: (\S+)/.exec(prompt)?.[1] ?? 'root';
      return reply(
        JSON.stringify({
          branches: script
            .children(parent)
            .map((thought) => ({ thought, action: { type: 'sub_goal', goal: thought } })),
        })
      );
    }

    if (instructions.includes('evaluation assistant')) {
      executorRequests.push(request);
      const thought = /Thought: (\S+)/.exec(prompt)?.[1] ?? '';
      return reply(
        JSON.stringify({
          confidence: script.confidence(thought),
          progress: 0.5,
          novelty: 0.5,
          reasoning: 'scored',
        })
      );
    }

    if (!system) {
      executorRequests.push(request);
      return reply('synthesized');
    }

    runCalls++;
    const approach = /Approach: (\S+)/.exec(prompt)?.[1] ?? '';
    if (!request.messages.some((m) => m.role === 'assistant')) runs.push(approach);
    if (script.failing?.includes(approach)) throw new Error(`run of ${approach} failed`);
    if (script.loopTools) {
      return reply('', {
        finishReason: 'tool_calls',
        toolCalls: [{ id: `c${runCalls}`, name: 'probe', arguments: {} }],
      });
    }
    return reply(`done ${approach}`);
  };

  const backend: LLMBackend = {
    provider: 'anthropic',
    chat: vi.fn(chat),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield* [];
    }),
  };

  return { backend, executorRequests, runs, runCalls: () => runCalls };
}

const probe = tool({
  name: 'probe',
  description: 'Probe',
  parameters: z.object({}),
  execute: async () => 'probed',
});

function setup(script: TreeScript, model = 'anthropic/claude-opus-5-5') {
  const tree = treeBackend(script);
  const cog = new Cogitator({ llm: { backends: { anthropic: tree.backend }, retry: false } });
  const agent = new Agent({ name: 'solver', model, instructions: 'Solve it.', tools: [probe] });
  return { ...tree, cog, agent };
}

describe('ThoughtTreeExecutor', () => {
  it('sends the routed model name, not the provider/model id, to the backend', async () => {
    const { cog, agent, executorRequests } = setup({
      children: (thought) => (thought === 'root' ? ['A', 'B'] : []),
      confidence: () => 0.6,
    });
    const executor = new ThoughtTreeExecutor(cog, { maxDepth: 1 });

    await executor.explore(agent, 'goal');

    expect(executorRequests.length).toBeGreaterThan(0);
    expect(new Set(executorRequests.map((r) => r.model))).toEqual(new Set(['claude-opus-5-5']));
    await cog.close();
  });

  it('backtracks to the best alternative left out of the beam when a branch fails', async () => {
    const { cog, agent, runs } = setup({
      children: (thought) => (thought === 'root' ? ['A', 'B', 'C'] : []),
      confidence: (thought) => ({ A: 0.7, B: 0.6, C: 0.5 })[thought] ?? 0.5,
      failing: ['A'],
    });
    const backtracks: Array<[string, string | null]> = [];
    const executor = new ThoughtTreeExecutor(cog, {
      maxDepth: 1,
      beamWidth: 1,
      onBacktrack: (from, to) => backtracks.push([from.branch.thought, to?.branch.thought ?? null]),
    });

    const result = await executor.explore(agent, 'goal');

    expect(runs).toEqual(['A', 'B']);
    expect(backtracks).toEqual([['A', 'B']]);
    expect(result.success).toBe(true);
    expect(result.output).toBe('done B');
    expect(result.stats.backtrackCount).toBe(1);
    await cog.close();
  });

  it.each<[ExplorationStrategy, string[]]>([
    ['beam', ['A', 'B', 'B1', 'A1', 'B11', 'A11']],
    ['best-first', ['A', 'B', 'B1', 'B11', 'A1', 'A11']],
    ['dfs', ['A', 'A1', 'A11', 'B', 'B1', 'B11']],
  ])('runs branches in %s order', async (explorationStrategy, order) => {
    const { cog, agent, runs } = setup({
      children: (thought) => (thought === 'root' ? ['A', 'B'] : [`${thought}1`]),
      confidence: (thought) =>
        ({ A: 0.6, B: 0.5, A1: 0.3, B1: 0.7, A11: 0.3, B11: 0.7 })[thought] ?? 0.5,
    });
    const executor = new ThoughtTreeExecutor(cog, { maxDepth: 3, explorationStrategy });

    await executor.explore(agent, 'goal');

    expect(runs).toEqual(order);
    await cog.close();
  });

  it('stops exploring at the configured timeout unless explore() sets its own', async () => {
    const script: TreeScript = {
      children: (thought) => (thought === 'root' ? ['A', 'B'] : []),
      confidence: () => 0.6,
    };
    const slowRoot = () => {
      const until = Date.now() + 10;
      while (Date.now() < until);
    };

    const configured = setup(script);
    const timedOut = await new ThoughtTreeExecutor(configured.cog, {
      maxDepth: 1,
      timeout: 5,
      onBranchGenerated: slowRoot,
    }).explore(configured.agent, 'goal');

    expect(configured.runs).toEqual([]);
    expect(timedOut.stats.exploredNodes).toBe(0);
    await configured.cog.close();

    const overridden = setup(script);
    await new ThoughtTreeExecutor(overridden.cog, {
      maxDepth: 1,
      timeout: 5,
      onBranchGenerated: slowRoot,
    }).explore(overridden.agent, 'goal', { timeout: 60_000 });

    expect(overridden.runs).toEqual(['A', 'B']);
    await overridden.cog.close();
  });

  it('caps the tool turns of each branch run at maxIterationsPerBranch, then lets it answer', async () => {
    const { cog, agent, runCalls } = setup({
      children: (thought) => (thought === 'root' ? ['A'] : []),
      confidence: () => 0.6,
      loopTools: true,
    });
    const executor = new ThoughtTreeExecutor(cog, { maxDepth: 1, maxIterationsPerBranch: 2 });

    await executor.explore(agent, 'goal');

    expect(runCalls()).toBe(3);
    await cog.close();
  });

  it("keeps the agent's own maxIterations when it is lower", async () => {
    const { cog, runCalls } = setup({
      children: (thought) => (thought === 'root' ? ['A'] : []),
      confidence: () => 0.6,
      loopTools: true,
    });
    const agent = new Agent({
      name: 'solver',
      model: 'anthropic/claude-opus-5-5',
      instructions: 'Solve it.',
      tools: [probe],
      maxIterations: 1,
    });
    const executor = new ThoughtTreeExecutor(cog, { maxDepth: 1, maxIterationsPerBranch: 3 });

    await executor.explore(agent, 'goal');

    expect(runCalls()).toBe(2);
    await cog.close();
  });

  it('counts the tokens and cost of its own model calls with those of the runs', async () => {
    const { cog, agent, executorRequests, runCalls } = setup({
      children: (thought) => (thought === 'root' ? ['A', 'B'] : []),
      confidence: (thought) => ({ A: 0.7, B: 0.6 })[thought] ?? 0.5,
    });
    const executor = new ThoughtTreeExecutor(cog, { maxDepth: 1 });

    const result = await executor.explore(agent, 'goal');

    const calls = executorRequests.length + runCalls();
    const expected = {
      inputTokens: calls * USAGE.inputTokens,
      outputTokens: calls * USAGE.outputTokens,
    };
    expect(result.stats.llmCalls).toBe(executorRequests.length);
    expect(result.usage).toMatchObject({
      ...expected,
      totalTokens: expected.inputTokens + expected.outputTokens,
    });
    expect(result.stats.tokenUsage).toEqual({
      input: expected.inputTokens,
      output: expected.outputTokens,
    });
    expect(result.usage.cost).toBeGreaterThan(0);
    expect(result.usage.cost).toBeCloseTo(calculateCost('claude-opus-5-5', expected) ?? NaN, 10);
    await cog.close();
  });
});
