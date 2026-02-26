import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SwarmCoordinator } from '../coordinator';
import { createMockAgent, createMockRunResult } from './strategies/__mocks__/mock-helpers';
import type { Agent, RunResult, SwarmConfig } from '@cogitator-ai/types';

function makeMockCogitator(handler?: (agent: Agent, options: unknown) => RunResult) {
  const defaultResult = createMockRunResult('default output');
  return {
    run: vi.fn().mockImplementation((agent: Agent, _options: unknown) => {
      if (handler) return Promise.resolve(handler(agent, _options));
      return Promise.resolve(defaultResult);
    }),
  } as unknown as import('@cogitator-ai/core').Cogitator;
}

function baseConfig(overrides?: Partial<SwarmConfig>): SwarmConfig {
  return {
    name: 'test-swarm',
    strategy: 'hierarchical',
    ...overrides,
  };
}

describe('SwarmCoordinator', () => {
  describe('agent initialization', () => {
    it('should register supervisor with role and priority', () => {
      const supervisor = createMockAgent('boss');
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig({ supervisor }));

      const agent = coord.getAgent('boss');
      expect(agent).toBeDefined();
      expect(agent!.metadata.role).toBe('supervisor');
      expect(agent!.metadata.priority).toBe(100);
      expect(agent!.state).toBe('idle');
    });

    it('should register workers with role and priority', () => {
      const w1 = createMockAgent('w1');
      const w2 = createMockAgent('w2');
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig({ workers: [w1, w2] }));

      expect(coord.getAgents()).toHaveLength(2);
      for (const sa of coord.getAgents()) {
        expect(sa.metadata.role).toBe('worker');
        expect(sa.metadata.priority).toBe(50);
      }
    });

    it('should register generic agents with empty metadata', () => {
      const a1 = createMockAgent('a1');
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig({ agents: [a1] }));

      const agent = coord.getAgent('a1');
      expect(agent).toBeDefined();
      expect(agent!.metadata.role).toBeUndefined();
    });

    it('should register moderator with role and priority 90', () => {
      const mod = createMockAgent('mod');
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig({ moderator: mod }));

      const agent = coord.getAgent('mod');
      expect(agent!.metadata.role).toBe('moderator');
      expect(agent!.metadata.priority).toBe(90);
    });

    it('should register router with role and priority 95', () => {
      const router = createMockAgent('router');
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig({ router }));

      const agent = coord.getAgent('router');
      expect(agent!.metadata.role).toBe('router');
      expect(agent!.metadata.priority).toBe(95);
    });

    it('should register top-level stages with custom metadata', () => {
      const a = createMockAgent('stage-agent');
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(
        cog,
        baseConfig({ stages: [{ name: 'preprocess', agent: a, gate: true }] })
      );

      const agent = coord.getAgent('stage-agent');
      expect(agent!.metadata.custom).toEqual({ stageName: 'preprocess', isGate: true });
    });

    it('should register pipeline.stages with custom metadata', () => {
      const a = createMockAgent('pipe-agent');
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(
        cog,
        baseConfig({
          pipeline: {
            stages: [{ name: 'step1', agent: a, gate: false }],
          },
        })
      );

      const agent = coord.getAgent('pipe-agent');
      expect(agent!.metadata.custom).toEqual({ stageName: 'step1', isGate: false });
    });

    it('should register all agent types simultaneously', () => {
      const sup = createMockAgent('sup');
      const w = createMockAgent('worker');
      const a = createMockAgent('generic');
      const mod = createMockAgent('mod');
      const rt = createMockAgent('router');
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(
        cog,
        baseConfig({
          supervisor: sup,
          workers: [w],
          agents: [a],
          moderator: mod,
          router: rt,
        })
      );

      expect(coord.getAgents()).toHaveLength(5);
    });
  });

  describe('runAgent', () => {
    let cog: ReturnType<typeof makeMockCogitator>;
    let coord: SwarmCoordinator;

    beforeEach(() => {
      const agent = createMockAgent('test-agent');
      cog = makeMockCogitator();
      coord = new SwarmCoordinator(cog, baseConfig({ agents: [agent] }));
    });

    it('should call cogitator.run with the right agent and input', async () => {
      await coord.runAgent('test-agent', 'hello');

      expect(cog.run).toHaveBeenCalledTimes(1);
      const [calledAgent, calledOptions] = (cog.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(calledAgent.name).toBe('test-agent');
      expect(calledOptions.input).toBe('hello');
    });

    it('should throw for unknown agent name', async () => {
      await expect(coord.runAgent('nonexistent', 'hi')).rejects.toThrow(
        "Agent 'nonexistent' not found in swarm"
      );
    });

    it('should set agent state to running then completed', async () => {
      const states: string[] = [];
      (cog.run as ReturnType<typeof vi.fn>).mockImplementation(() => {
        states.push(coord.getAgent('test-agent')!.state);
        return Promise.resolve(createMockRunResult('ok'));
      });

      await coord.runAgent('test-agent', 'x');
      states.push(coord.getAgent('test-agent')!.state);

      expect(states).toEqual(['running', 'completed']);
    });

    it('should set agent state to failed on error', async () => {
      (cog.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

      await expect(coord.runAgent('test-agent', 'x')).rejects.toThrow('boom');
      expect(coord.getAgent('test-agent')!.state).toBe('failed');
    });

    it('should accumulate tokenCount on the swarm agent', async () => {
      const result = createMockRunResult('out', {
        usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80, cost: 0.01, duration: 50 },
      });
      (cog.run as ReturnType<typeof vi.fn>).mockResolvedValue(result);

      await coord.runAgent('test-agent', 'a');
      await coord.runAgent('test-agent', 'b');

      expect(coord.getAgent('test-agent')!.tokenCount).toBe(160);
    });

    it('should emit agent:start and agent:complete events', async () => {
      const startHandler = vi.fn();
      const completeHandler = vi.fn();
      coord.events.on('agent:start', startHandler);
      coord.events.on('agent:complete', completeHandler);

      await coord.runAgent('test-agent', 'test input');

      expect(startHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agent:start',
          data: expect.objectContaining({ agentName: 'test-agent', input: 'test input' }),
        })
      );
      expect(completeHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agent:complete',
          data: expect.objectContaining({ agentName: 'test-agent' }),
        })
      );
    });

    it('should emit agent:error on failure', async () => {
      (cog.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('bad'));
      const errorHandler = vi.fn();
      coord.events.on('agent:error', errorHandler);

      await expect(coord.runAgent('test-agent', 'x')).rejects.toThrow();

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agent:error',
          data: expect.objectContaining({ agentName: 'test-agent' }),
        })
      );
    });

    it('should pass swarmContext in context', async () => {
      await coord.runAgent('test-agent', 'hi', { extra: 42 });

      const [, calledOptions] = (cog.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(calledOptions.context.swarmContext).toBeDefined();
      expect(calledOptions.context.swarmContext.swarmName).toBe('test-swarm');
      expect(calledOptions.context.extra).toBe(42);
    });

    it('should respect saveHistory setting', async () => {
      coord.setSaveHistory(false);
      await coord.runAgent('test-agent', 'x');

      const [, calledOptions] = (cog.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(calledOptions.saveHistory).toBe(false);
    });
  });

  describe('runAgent — error handling config', () => {
    it('should return skip result when onAgentFailure is skip', async () => {
      const agent = createMockAgent('failing');
      const cog = makeMockCogitator();
      (cog.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));

      const coord = new SwarmCoordinator(
        cog,
        baseConfig({
          agents: [agent],
          errorHandling: { onAgentFailure: 'skip' },
        })
      );

      const result = await coord.runAgent('failing', 'x');
      expect(result.output).toBe('');
      expect(result.runId).toContain('skipped');
    });

    it('should throw when onAgentFailure is abort', async () => {
      const agent = createMockAgent('failing');
      const cog = makeMockCogitator();
      (cog.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));

      const coord = new SwarmCoordinator(
        cog,
        baseConfig({
          agents: [agent],
          errorHandling: { onAgentFailure: 'abort' },
        })
      );

      await expect(coord.runAgent('failing', 'x')).rejects.toThrow('fail');
    });

    it('should failover to backup agent', async () => {
      const primary = createMockAgent('primary');
      const backup = createMockAgent('backup');
      let callCount = 0;
      const cog = makeMockCogitator((agent) => {
        callCount++;
        if (agent.name === 'primary') throw new Error('primary down');
        return createMockRunResult('backup handled it');
      });

      const coord = new SwarmCoordinator(
        cog,
        baseConfig({
          agents: [primary, backup],
          errorHandling: {
            onAgentFailure: 'failover',
            failover: { primary: 'backup' },
          },
        })
      );

      const result = await coord.runAgent('primary', 'task');
      expect(result.output).toBe('backup handled it');
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('runAgentsParallel — error handling', () => {
    it('should skip failed agents when onAgentFailure is skip', async () => {
      const a1 = createMockAgent('good');
      const a2 = createMockAgent('bad');
      const cog = makeMockCogitator((agent) => {
        if (agent.name === 'bad') throw new Error('agent failed');
        return createMockRunResult('success');
      });

      const coord = new SwarmCoordinator(
        cog,
        baseConfig({
          agents: [a1, a2],
          errorHandling: { onAgentFailure: 'skip' },
        })
      );

      const results = await coord.runAgentsParallel([
        { name: 'good', input: 'x' },
        { name: 'bad', input: 'y' },
      ]);

      expect(results.has('good')).toBe(true);
      expect(results.has('bad')).toBe(true);
      expect(results.get('bad')!.output).toBe('');
    });

    it('should throw on failure when onAgentFailure is abort', async () => {
      const a1 = createMockAgent('ok');
      const a2 = createMockAgent('broken');
      const cog = makeMockCogitator((agent) => {
        if (agent.name === 'broken') throw new Error('broken agent');
        return createMockRunResult('fine');
      });

      const coord = new SwarmCoordinator(
        cog,
        baseConfig({
          agents: [a1, a2],
          errorHandling: { onAgentFailure: 'abort' },
        })
      );

      await expect(
        coord.runAgentsParallel([
          { name: 'ok', input: 'x' },
          { name: 'broken', input: 'y' },
        ])
      ).rejects.toThrow('broken agent');
    });

    it('should throw on failure when onAgentFailure is undefined (no errorHandling)', async () => {
      const a1 = createMockAgent('fine');
      const a2 = createMockAgent('dead');
      const cog = makeMockCogitator((agent) => {
        if (agent.name === 'dead') throw new Error('dead agent');
        return createMockRunResult('ok');
      });

      const coord = new SwarmCoordinator(cog, baseConfig({ agents: [a1, a2] }));

      await expect(
        coord.runAgentsParallel([
          { name: 'fine', input: 'x' },
          { name: 'dead', input: 'y' },
        ])
      ).rejects.toThrow('dead agent');
    });

    it('should throw on failure when onAgentFailure is retry (non-skip/non-abort)', async () => {
      const a1 = createMockAgent('ok');
      const a2 = createMockAgent('failing');
      const cog = makeMockCogitator((agent) => {
        if (agent.name === 'failing') throw new Error('retry exhausted');
        return createMockRunResult('ok');
      });

      const coord = new SwarmCoordinator(
        cog,
        baseConfig({
          agents: [a1, a2],
          errorHandling: {
            onAgentFailure: 'retry',
            retry: { maxRetries: 1, backoff: 'constant', initialDelay: 1 },
          },
        })
      );

      await expect(
        coord.runAgentsParallel([
          { name: 'ok', input: 'x' },
          { name: 'failing', input: 'y' },
        ])
      ).rejects.toThrow();
    });

    it('should respect maxConcurrency', async () => {
      const agents = Array.from({ length: 6 }, (_, i) => createMockAgent(`a${i}`));
      let maxConcurrent = 0;
      let running = 0;

      const cog = makeMockCogitator(() => {
        running++;
        if (running > maxConcurrent) maxConcurrent = running;
        running--;
        return createMockRunResult('done');
      });

      const coord = new SwarmCoordinator(cog, baseConfig({ agents }));

      await coord.runAgentsParallel(
        agents.map((a) => ({ name: a.name, input: 'x' })),
        2
      );

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('should return all results on full success', async () => {
      const a1 = createMockAgent('alpha');
      const a2 = createMockAgent('beta');
      const cog = makeMockCogitator((agent) => createMockRunResult(`result-${agent.name}`));

      const coord = new SwarmCoordinator(cog, baseConfig({ agents: [a1, a2] }));

      const results = await coord.runAgentsParallel([
        { name: 'alpha', input: 'x' },
        { name: 'beta', input: 'y' },
      ]);

      expect(results.get('alpha')!.output).toBe('result-alpha');
      expect(results.get('beta')!.output).toBe('result-beta');
    });
  });

  describe('pause / resume / abort', () => {
    it('should reflect paused state', () => {
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig({ agents: [createMockAgent('a')] }));

      expect(coord.isPaused()).toBe(false);
      coord.pause();
      expect(coord.isPaused()).toBe(true);
      coord.resume();
      expect(coord.isPaused()).toBe(false);
    });

    it('should reflect aborted state', () => {
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig({ agents: [createMockAgent('a')] }));

      expect(coord.isAborted()).toBe(false);
      coord.abort();
      expect(coord.isAborted()).toBe(true);
    });

    it('should throw aborted error when runAgent is called after abort', async () => {
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig({ agents: [createMockAgent('a')] }));

      coord.abort();
      await expect(coord.runAgent('a', 'x')).rejects.toThrow('Swarm execution aborted');
    });

    it('should break out of pause loop when aborted', async () => {
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig({ agents: [createMockAgent('a')] }));

      coord.pause();

      const runPromise = coord.runAgent('a', 'x');

      setTimeout(() => coord.abort(), 150);

      await expect(runPromise).rejects.toThrow('Swarm execution aborted');
    });

    it('should resume execution after unpause', async () => {
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig({ agents: [createMockAgent('a')] }));

      coord.pause();

      const runPromise = coord.runAgent('a', 'x');

      setTimeout(() => coord.resume(), 150);

      const result = await runPromise;
      expect(result).toBeDefined();
      expect(result.output).toBe('default output');
    });
  });

  describe('reset', () => {
    it('should clear aborted and paused flags', () => {
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig({ agents: [createMockAgent('a')] }));

      coord.pause();
      coord.abort();
      coord.reset();

      expect(coord.isPaused()).toBe(false);
      expect(coord.isAborted()).toBe(false);
    });

    it('should reset all agent states to idle', async () => {
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig({ agents: [createMockAgent('a')] }));

      await coord.runAgent('a', 'x');
      expect(coord.getAgent('a')!.state).toBe('completed');
      expect(coord.getAgent('a')!.tokenCount).toBeGreaterThan(0);

      coord.reset();

      const agent = coord.getAgent('a')!;
      expect(agent.state).toBe('idle');
      expect(agent.lastResult).toBeUndefined();
      expect(agent.messageCount).toBe(0);
      expect(agent.tokenCount).toBe(0);
    });

    it('should allow running agents again after reset from aborted state', async () => {
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig({ agents: [createMockAgent('a')] }));

      coord.abort();
      await expect(coord.runAgent('a', 'x')).rejects.toThrow('Swarm execution aborted');

      coord.reset();
      const result = await coord.runAgent('a', 'retry');
      expect(result.output).toBe('default output');
    });

    it('should clear message bus and blackboard', async () => {
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig({ agents: [createMockAgent('a')] }));

      await coord.messageBus.send({
        swarmId: 'x',
        from: 'a',
        to: 'b',
        type: 'notification',
        content: 'hi',
      });
      coord.blackboard.write('section', { data: 1 }, 'a');

      expect(coord.messageBus.getAllMessages()).toHaveLength(1);
      expect(coord.blackboard.has('section')).toBe(true);

      coord.reset();

      expect(coord.messageBus.getAllMessages()).toHaveLength(0);
      expect(coord.blackboard.has('section')).toBe(false);
    });
  });

  describe('circuit breaker', () => {
    it('should block execution when circuit is open', async () => {
      const agent = createMockAgent('cb-agent');
      const cog = makeMockCogitator();
      (cog.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));

      const coord = new SwarmCoordinator(
        cog,
        baseConfig({
          agents: [agent],
          errorHandling: {
            onAgentFailure: 'abort',
            circuitBreaker: { enabled: true, threshold: 2, resetTimeout: 60000 },
          },
        })
      );

      await expect(coord.runAgent('cb-agent', 'a')).rejects.toThrow('fail');
      await expect(coord.runAgent('cb-agent', 'b')).rejects.toThrow('fail');

      await expect(coord.runAgent('cb-agent', 'c')).rejects.toThrow('Circuit breaker is open');
    });
  });

  describe('resource budget', () => {
    it('should throw when budget is exceeded', async () => {
      const agent = createMockAgent('expensive');
      const bigResult = createMockRunResult('big', {
        usage: {
          inputTokens: 5000,
          outputTokens: 5000,
          totalTokens: 10000,
          cost: 1,
          duration: 100,
        },
      });
      const cog = makeMockCogitator();
      (cog.run as ReturnType<typeof vi.fn>).mockResolvedValue(bigResult);

      const coord = new SwarmCoordinator(
        cog,
        baseConfig({
          agents: [agent],
          resources: { tokenBudget: 5000 },
        })
      );

      await coord.runAgent('expensive', 'a');
      await expect(coord.runAgent('expensive', 'b')).rejects.toThrow('budget exceeded');
    });
  });

  describe('getters', () => {
    it('getSwarmId should return a swarm_ prefixed id', () => {
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig());
      expect(coord.getSwarmId()).toMatch(/^swarm_/);
    });

    it('getAgentsByRole should filter correctly', () => {
      const sup = createMockAgent('sup');
      const w1 = createMockAgent('w1');
      const w2 = createMockAgent('w2');
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig({ supervisor: sup, workers: [w1, w2] }));

      expect(coord.getAgentsByRole('supervisor')).toHaveLength(1);
      expect(coord.getAgentsByRole('worker')).toHaveLength(2);
      expect(coord.getAgentsByRole('moderator')).toHaveLength(0);
    });

    it('getResourceUsage should return tracker data', () => {
      const cog = makeMockCogitator();
      const coord = new SwarmCoordinator(cog, baseConfig());
      const usage = coord.getResourceUsage();
      expect(usage).toBeDefined();
      expect(usage.totalTokens).toBe(0);
    });
  });
});
