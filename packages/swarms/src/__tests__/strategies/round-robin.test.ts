import { describe, it, expect, beforeEach } from 'vitest';
import { RoundRobinStrategy } from '../../strategies/round-robin';
import { MockCoordinator } from './__mocks__/mock-coordinator';
import { createMockSwarmAgent } from './__mocks__/mock-helpers';

describe('RoundRobinStrategy', () => {
  let coordinator: MockCoordinator;

  beforeEach(() => {
    coordinator = new MockCoordinator();
  });

  describe('initialization', () => {
    it('should throw when no agents exist', async () => {
      const strategy = new RoundRobinStrategy(coordinator as any);

      await expect(strategy.execute({ input: 'test' })).rejects.toThrow(
        'Round-robin strategy requires at least 1 agent'
      );
    });

    it('should default to sequential rotation', () => {
      const strategy = new RoundRobinStrategy(coordinator as any);
      const state = strategy.getState();
      expect(state.currentIndex).toBe(0);
    });

    it('should apply provided config', () => {
      const strategy = new RoundRobinStrategy(coordinator as any, {
        sticky: true,
        rotation: 'random',
      });
      expect(strategy.getState().currentIndex).toBe(0);
    });
  });

  describe('sequential rotation', () => {
    beforeEach(() => {
      const agent1 = createMockSwarmAgent('agent-1');
      const agent2 = createMockSwarmAgent('agent-2');
      const agent3 = createMockSwarmAgent('agent-3');

      coordinator.addAgent(agent1);
      coordinator.addAgent(agent2);
      coordinator.addAgent(agent3);

      coordinator.setAgentResponse('agent-1', 'Response from agent-1');
      coordinator.setAgentResponse('agent-2', 'Response from agent-2');
      coordinator.setAgentResponse('agent-3', 'Response from agent-3');
    });

    it('should select first agent on first call', async () => {
      const strategy = new RoundRobinStrategy(coordinator as any, { rotation: 'sequential' });

      const result = await strategy.execute({ input: 'test' });

      expect(result.output).toBe('Response from agent-1');
      expect(coordinator.getLastCall()?.agent).toBe('agent-1');
    });

    it('should advance to next agent on subsequent calls', async () => {
      const strategy = new RoundRobinStrategy(coordinator as any, { rotation: 'sequential' });

      await strategy.execute({ input: 'test 1' });
      await strategy.execute({ input: 'test 2' });
      const result = await strategy.execute({ input: 'test 3' });

      expect(coordinator.getCalls().map((c) => c.agent)).toEqual(['agent-1', 'agent-2', 'agent-3']);
      expect(result.output).toBe('Response from agent-3');
    });

    it('should wrap around after all agents', async () => {
      const strategy = new RoundRobinStrategy(coordinator as any, { rotation: 'sequential' });

      await strategy.execute({ input: 'test 1' });
      await strategy.execute({ input: 'test 2' });
      await strategy.execute({ input: 'test 3' });
      const result = await strategy.execute({ input: 'test 4' });

      expect(coordinator.getCalls()[3].agent).toBe('agent-1');
      expect(result.output).toBe('Response from agent-1');
    });

    it('should maintain index across multiple executions', async () => {
      const strategy = new RoundRobinStrategy(coordinator as any, { rotation: 'sequential' });

      await strategy.execute({ input: 'test' });
      expect(strategy.getState().currentIndex).toBe(1);

      await strategy.execute({ input: 'test' });
      expect(strategy.getState().currentIndex).toBe(2);
    });
  });

  describe('random rotation', () => {
    beforeEach(() => {
      const agent1 = createMockSwarmAgent('agent-1');
      const agent2 = createMockSwarmAgent('agent-2');

      coordinator.addAgent(agent1);
      coordinator.addAgent(agent2);

      coordinator.setAgentResponse('agent-1', 'Response from agent-1');
      coordinator.setAgentResponse('agent-2', 'Response from agent-2');
    });

    it('should select agent and update currentIndex', async () => {
      const strategy = new RoundRobinStrategy(coordinator as any, { rotation: 'random' });

      await strategy.execute({ input: 'test' });

      const state = strategy.getState();
      expect([0, 1]).toContain(state.currentIndex);
    });
  });

  describe('sticky sessions', () => {
    beforeEach(() => {
      const agent1 = createMockSwarmAgent('agent-1');
      const agent2 = createMockSwarmAgent('agent-2');

      coordinator.addAgent(agent1);
      coordinator.addAgent(agent2);

      coordinator.setAgentResponse('agent-1', 'Response from agent-1');
      coordinator.setAgentResponse('agent-2', 'Response from agent-2');
    });

    it('should return same agent for same stickyKey', async () => {
      const strategy = new RoundRobinStrategy(coordinator as any, {
        sticky: true,
        rotation: 'sequential',
        stickyKey: (input) => (input as string).split(':')[0],
      });

      await strategy.execute({ input: 'user1:message1' });
      await strategy.execute({ input: 'user1:message2' });
      await strategy.execute({ input: 'user1:message3' });

      const calls = coordinator.getCalls();
      expect(calls.every((c) => c.agent === 'agent-1')).toBe(true);
    });

    it('should assign new keys to current agent (index does not advance with sticky)', async () => {
      const strategy = new RoundRobinStrategy(coordinator as any, {
        sticky: true,
        rotation: 'sequential',
        stickyKey: (input) => (input as string).split(':')[0],
      });

      await strategy.execute({ input: 'user1:message' });
      await strategy.execute({ input: 'user2:message' });

      const calls = coordinator.getCalls();
      expect(calls[0].agent).toBe('agent-1');
      expect(calls[1].agent).toBe('agent-1');
    });

    it('should track sticky assignments in state', async () => {
      const strategy = new RoundRobinStrategy(coordinator as any, {
        sticky: true,
        stickyKey: (input) => (input as string).split(':')[0],
      });

      await strategy.execute({ input: 'user1:msg' });
      await strategy.execute({ input: 'user2:msg' });

      const state = strategy.getState();
      expect(state.stickyAssignments.user1).toBe('agent-1');
      expect(state.stickyAssignments.user2).toBe('agent-1');
    });
  });

  describe('state management', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('agent-1'));
      coordinator.addAgent(createMockSwarmAgent('agent-2'));
      coordinator.setAgentResponse('agent-1', 'Response 1');
      coordinator.setAgentResponse('agent-2', 'Response 2');
    });

    it('getState() should return currentIndex and stickyAssignments', () => {
      const strategy = new RoundRobinStrategy(coordinator as any);

      const state = strategy.getState();

      expect(state).toHaveProperty('currentIndex');
      expect(state).toHaveProperty('stickyAssignments');
      expect(typeof state.currentIndex).toBe('number');
      expect(typeof state.stickyAssignments).toBe('object');
    });

    it('reset() should clear index and assignments', async () => {
      const strategy = new RoundRobinStrategy(coordinator as any, {
        sticky: true,
        stickyKey: (input) => input as string,
      });

      await strategy.execute({ input: 'user1' });
      await strategy.execute({ input: 'user2' });

      strategy.reset();

      const state = strategy.getState();
      expect(state.currentIndex).toBe(0);
      expect(state.stickyAssignments).toEqual({});
    });
  });

  describe('events and blackboard', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('agent-1'));
      coordinator.setAgentResponse('agent-1', 'Response');
    });

    it('should emit round-robin:assigned event', async () => {
      const strategy = new RoundRobinStrategy(coordinator as any);
      const events: unknown[] = [];

      coordinator.events.on('round-robin:assigned', (e) => events.push(e));

      await strategy.execute({ input: 'test' });

      expect(events.length).toBe(1);
      expect((events[0] as any).data).toMatchObject({
        agent: 'agent-1',
        index: 0,
      });
    });

    it('should write round-robin state to blackboard', async () => {
      const strategy = new RoundRobinStrategy(coordinator as any);

      await strategy.execute({ input: 'test' });

      const state = coordinator.blackboard.read('round-robin');
      expect(state).toMatchObject({
        currentAgent: 'agent-1',
        currentIndex: 0,
        totalAgents: 1,
      });
    });
  });

  describe('context building', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('agent-1'));
      coordinator.setAgentResponse('agent-1', 'Response');
    });

    it('should include roundRobinContext in agent context', async () => {
      const strategy = new RoundRobinStrategy(coordinator as any);

      await strategy.execute({ input: 'test' });

      const call = coordinator.getLastCall();
      expect(call?.context).toHaveProperty('roundRobinContext');
      expect(call?.context?.roundRobinContext).toMatchObject({
        selectedAgent: 'agent-1',
        totalAgents: 1,
        rotation: 'sequential',
      });
    });
  });

  describe('result structure', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('agent-1'));
      coordinator.setAgentResponse('agent-1', 'Test output');
    });

    it('should return correct StrategyResult', async () => {
      const strategy = new RoundRobinStrategy(coordinator as any);

      const result = await strategy.execute({ input: 'test' });

      expect(result).toHaveProperty('output', 'Test output');
      expect(result).toHaveProperty('agentResults');
      expect(result.agentResults.size).toBe(1);
      expect(result.agentResults.has('agent-1')).toBe(true);
    });
  });
});
