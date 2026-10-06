import { describe, it, expect, vi } from 'vitest';
import { AgentRunPausedError } from '@cogitator-ai/core';
import type { Cogitator } from '@cogitator-ai/core';
import type { RunResult, SwarmConfig, ToolApprovalRequest } from '@cogitator-ai/types';
import { SwarmCoordinator } from '../coordinator';
import { Swarm } from '../swarm';
import { createMockAgent, createMockRunResult } from './strategies/__mocks__/mock-helpers';

const pending: ToolApprovalRequest[] = [
  {
    toolCallId: 'c1',
    toolName: 'refund',
    arguments: { order: 'A-1' },
    description: 'Refund an order',
  },
];

function pausedRun(): RunResult {
  return createMockRunResult('Let me refund that.', {
    threadId: 'thread-1',
    status: 'paused',
    pendingApprovals: pending,
  });
}

function pausingCogitator() {
  const run = vi.fn(async () => pausedRun());
  return { cogitator: { run } as unknown as Cogitator, run };
}

function config(overrides: Partial<SwarmConfig>): SwarmConfig {
  return {
    name: 'refunds',
    strategy: 'round-robin',
    agents: [createMockAgent('clerk')],
    ...overrides,
  };
}

describe('swarm turns that pause for approval', () => {
  it('fail with AgentRunPausedError instead of answering with the pre-tool text', async () => {
    const { cogitator } = pausingCogitator();
    const coord = new SwarmCoordinator(cogitator, config({}));

    const error = await coord.runAgent('clerk', 'Refund A-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentRunPausedError);
    expect((error as AgentRunPausedError).message).toContain(
      'Agent "clerk" paused in swarm "refunds"'
    );
    expect((error as AgentRunPausedError).pendingApprovals).toEqual(pending);
    expect((error as AgentRunPausedError).threadId).toBe('thread-1');
    expect(coord.getAgent('clerk')!.state).toBe('failed');
  });

  it('are not retried, skipped or failed over: another attempt only pauses again', async () => {
    for (const errorHandling of [
      { onAgentFailure: 'retry', retry: { maxRetries: 3, backoff: 'constant', initialDelay: 1 } },
      { onAgentFailure: 'skip' },
      { onAgentFailure: 'failover', failover: { clerk: 'backup' } },
    ] as const) {
      const { cogitator, run } = pausingCogitator();
      const coord = new SwarmCoordinator(
        cogitator,
        config({
          agents: [createMockAgent('clerk'), createMockAgent('backup')],
          errorHandling: { ...errorHandling },
        })
      );

      await expect(coord.runAgent('clerk', 'Refund A-1')).rejects.toBeInstanceOf(
        AgentRunPausedError
      );
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it('do not trip the circuit breaker, but count toward the resource usage', async () => {
    const { cogitator } = pausingCogitator();
    const coord = new SwarmCoordinator(
      cogitator,
      config({
        errorHandling: {
          onAgentFailure: 'abort',
          circuitBreaker: { enabled: true, threshold: 1, resetTimeout: 60_000 },
        },
      })
    );

    await expect(coord.runAgent('clerk', 'Refund A-1')).rejects.toBeInstanceOf(AgentRunPausedError);
    await expect(coord.runAgent('clerk', 'Refund A-1')).rejects.toBeInstanceOf(AgentRunPausedError);
    expect(coord.getResourceUsage().totalTokens).toBe(300);
  });

  it('fail the swarm run', async () => {
    const { cogitator } = pausingCogitator();
    const swarm = new Swarm(cogitator, config({}));

    await expect(swarm.run({ input: 'Refund A-1' })).rejects.toBeInstanceOf(AgentRunPausedError);
  });
});
