import { describe, it, expect, vi } from 'vitest';
import { deliverSwarmJobResult } from '../../distributed/job-result';
import type {
  SwarmAgentJobPayload,
  SwarmAgentJobResult,
} from '../../distributed/distributed-coordinator';

const payload = (overrides: Partial<SwarmAgentJobPayload> = {}): SwarmAgentJobPayload => ({
  type: 'swarm-agent',
  jobId: 'j1',
  swarmId: 's1',
  agentName: 'writer',
  agentConfig: { name: 'writer', instructions: 'x', model: 'm', tools: [] },
  input: 'go',
  stateKeys: { blackboard: 'b', messages: 'm', results: 'swarm:{s1}:results', result: 'r:j1' },
  ...overrides,
});

const result: SwarmAgentJobResult = {
  jobId: 'j1',
  swarmId: 's1',
  agentName: 'writer',
  output: 'done',
  toolCalls: [],
  tokenUsage: { prompt: 1, completion: 1, total: 2 },
};

describe('deliverSwarmJobResult', () => {
  it('keeps the result for the whole positive ms the job names, then publishes it', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    const publish = vi.fn().mockResolvedValue(1);

    await deliverSwarmJobResult({ set, publish }, payload({ resultTtl: 1500.5 }), result);
    await deliverSwarmJobResult({ set, publish }, payload({ resultTtl: 0 }), result);

    expect(set.mock.calls.map((call) => call[3])).toEqual([1501, 3_600_000]);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith('swarm:{s1}:results', JSON.stringify(result));
  });

  it('still publishes a result it cannot keep, telling why', async () => {
    const publish = vi.fn().mockResolvedValue(1);
    const onStoreError = vi.fn();

    await deliverSwarmJobResult(
      { set: vi.fn().mockRejectedValue(new Error('OOM')), publish },
      payload(),
      result,
      onStoreError
    );

    expect(publish).toHaveBeenCalledTimes(1);
    expect(onStoreError).toHaveBeenCalledWith(expect.objectContaining({ message: 'OOM' }));
  });

  it('only publishes for a client that cannot set keys or a job without a result key', async () => {
    const publish = vi.fn().mockResolvedValue(1);

    await deliverSwarmJobResult({ publish }, payload(), result);

    expect(publish).toHaveBeenCalledTimes(1);
  });
});
