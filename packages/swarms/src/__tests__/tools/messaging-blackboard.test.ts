import { describe, it, expect } from 'vitest';
import { Agent } from '@cogitator-ai/core';
import type { ToolContext } from '@cogitator-ai/types';
import { createBlackboardTools } from '../../tools/blackboard';
import { createMessagingTools, createHierarchyMessageAuthorizer } from '../../tools/messaging';
import { InMemoryBlackboard } from '../../communication/blackboard';
import { InMemoryMessageBus } from '../../communication/message-bus';
import { HierarchicalStrategy } from '../../strategies/hierarchical';
import { createAssessor, qualifiedModelId } from '../../assessor/assessor';
import { DistributedSwarmCoordinator } from '../../distributed/distributed-coordinator';
import { MockCoordinator } from '../strategies/__mocks__/mock-coordinator';
import { createMockSwarmAgent } from '../strategies/__mocks__/mock-helpers';

const ctx: ToolContext = { agentId: 'a', runId: 'r', signal: new AbortController().signal };

describe('blackboard tools', () => {
  it('reports missing sections instead of throwing', async () => {
    const board = new InMemoryBlackboard({ enabled: true, sections: {} });
    const tools = createBlackboardTools(board, 'agent');

    await expect(tools.readBlackboard.execute({ section: 'nope' }, ctx)).resolves.toEqual({
      found: false,
      section: 'nope',
      data: null,
    });
  });

  it('merges into missing, array and object sections', async () => {
    const board = new InMemoryBlackboard({ enabled: true, sections: { list: [1], obj: { a: 1 } } });
    const tools = createBlackboardTools(board, 'agent');

    await tools.writeBlackboard.execute({ section: 'fresh', data: { x: 1 }, merge: true }, ctx);
    await tools.writeBlackboard.execute({ section: 'list', data: { item: 2 }, merge: true }, ctx);
    await tools.writeBlackboard.execute({ section: 'obj', data: { b: 2 }, merge: true }, ctx);

    expect(board.read('fresh')).toEqual({ x: 1 });
    expect(board.read('list')).toEqual([1, { item: 2 }]);
    expect(board.read('obj')).toEqual({ a: 1, b: 2 });
  });

  it('does not report keys of primitive sections as found', async () => {
    const board = new InMemoryBlackboard({ enabled: true, sections: { count: 3 } });
    const tools = createBlackboardTools(board, 'agent');

    await expect(
      tools.readBlackboard.execute({ section: 'count', key: 'value' }, ctx)
    ).resolves.toMatchObject({ found: false });
  });
});

describe('messaging tools', () => {
  it('refuses messages to self', async () => {
    const bus = new InMemoryMessageBus({ enabled: true, protocol: 'direct' });
    const tools = createMessagingTools(bus, 'alice');

    await expect(
      tools.sendMessage.execute({ to: 'alice', message: 'hi' }, ctx)
    ).resolves.toMatchObject({ sent: false });
    expect(bus.getAllMessages()).toHaveLength(0);
  });

  it('marks messages as read once returned by read_messages', async () => {
    const bus = new InMemoryMessageBus({ enabled: true, protocol: 'direct' });
    const alice = createMessagingTools(bus, 'alice');
    const bob = createMessagingTools(bus, 'bob');

    await alice.sendMessage.execute({ to: 'bob', message: 'one' }, ctx);
    await alice.sendMessage.execute({ to: 'bob', message: 'two' }, ctx);

    const first = await bob.readMessages.execute({ unreadOnly: true, limit: 1 }, ctx);
    const second = await bob.readMessages.execute({ unreadOnly: true }, ctx);
    const third = await bob.readMessages.execute({ unreadOnly: true }, ctx);

    expect(first.messages.map((m) => m.content)).toEqual(['one']);
    expect(second.messages.map((m) => m.content)).toEqual(['two']);
    expect(third.count).toBe(0);
  });

  it('waits for a correlated reply without polling the full timeout', async () => {
    const bus = new InMemoryMessageBus({ enabled: true, protocol: 'direct' });
    const alice = createMessagingTools(bus, 'alice', 's', { replyTimeout: 2000 });
    const bob = createMessagingTools(bus, 'bob');

    bus.subscribe('bob', (message) => {
      setTimeout(() => {
        void bob.replyToMessage.execute({ originalMessageId: message.id, message: 'pong' }, ctx);
      }, 5);
    });

    const started = Date.now();
    const result = await alice.sendMessage.execute(
      { to: 'bob', message: 'ping', waitForReply: true },
      ctx
    );

    expect(result).toMatchObject({ sent: true, reply: 'pong' });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('enforces hierarchical worker isolation', async () => {
    const coordinator = new MockCoordinator();
    coordinator.addAgent(createMockSwarmAgent('boss', { role: 'supervisor' }));
    coordinator.addAgent(createMockSwarmAgent('w1', { role: 'worker' }));
    coordinator.addAgent(createMockSwarmAgent('w2', { role: 'worker' }));
    coordinator.setAgentResponse('boss', 'done');

    await new HierarchicalStrategy(coordinator, { workerCommunication: false }).execute({
      input: 'x',
    });

    const tools = createMessagingTools(coordinator.messageBus, 'w1', 's', {
      authorize: createHierarchyMessageAuthorizer(coordinator, coordinator.blackboard, 'w1'),
    });

    await expect(
      tools.sendMessage.execute({ to: 'w2', message: 'psst' }, ctx)
    ).resolves.toMatchObject({ sent: false });
    await expect(tools.broadcastMessage.execute({ message: 'all' }, ctx)).resolves.toMatchObject({
      broadcasted: false,
    });
    await expect(
      tools.sendMessage.execute({ to: 'boss', message: 'status' }, ctx)
    ).resolves.toMatchObject({ sent: true });
  });
});

describe('assessor model assignment', () => {
  it('qualifies discovered model ids with their provider', () => {
    expect(qualifiedModelId({ id: 'llama3.2:3b', provider: 'ollama' })).toBe('ollama/llama3.2:3b');
    expect(qualifiedModelId({ id: 'openai/gpt-4o', provider: 'openai' })).toBe('openai/gpt-4o');
  });

  it('reassigns pipeline stage agents', () => {
    const writer = new Agent({ name: 'writer', model: 'openai/gpt-4o', instructions: 'write' });
    const assessor = createAssessor({ enabledProviders: [] });

    const updated = assessor.assignModels(
      {
        name: 'p',
        strategy: 'pipeline',
        pipeline: { stages: [{ name: 'draft', agent: writer }] },
      },
      {
        taskAnalysis: {
          needsVision: false,
          needsToolCalling: false,
          needsLongContext: false,
          needsReasoning: 'basic',
          needsSpeed: 'balanced',
          costSensitivity: 'medium',
          complexity: 'simple',
        },
        roleAnalyses: new Map(),
        assignments: [
          {
            agentName: 'writer',
            originalModel: 'openai/gpt-4o',
            assignedModel: 'ollama/qwen2.5:0.5b',
            provider: 'ollama',
            score: 70,
            reasons: [],
            fallbackModels: [],
            locked: false,
          },
        ],
        totalEstimatedCost: 0,
        warnings: [],
        discoveredModels: [],
      }
    );

    expect(updated.pipeline?.stages[0].agent.model).toBe('ollama/qwen2.5:0.5b');
    expect(updated.pipeline?.stages[0].agent.instructions).toBe('write');
  });
});

describe('DistributedSwarmCoordinator', () => {
  it('exposes communication primitives before connecting to Redis', async () => {
    const coordinator = new DistributedSwarmCoordinator({
      config: { name: 'd', strategy: 'round-robin', agents: [] },
      distributed: { enabled: true, redis: { host: '127.0.0.1', port: 1 } },
    });

    const listener = (): void => {};
    const unsubscribe = coordinator.events.on('swarm:start', listener);
    expect(coordinator.blackboard.has('anything')).toBe(false);
    expect(coordinator.messageBus.getAllMessages()).toEqual([]);
    unsubscribe();

    await coordinator.close();
    await expect(coordinator.initialize()).rejects.toThrow('closed');
  });
});
