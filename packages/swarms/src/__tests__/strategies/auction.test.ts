import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuctionStrategy } from '../../strategies/auction';
import { MockCoordinator } from './__mocks__/mock-coordinator';
import { createMockSwarmAgent } from './__mocks__/mock-helpers';

describe('AuctionStrategy', () => {
  let coordinator: MockCoordinator;

  beforeEach(() => {
    coordinator = new MockCoordinator();
  });

  describe('initialization', () => {
    it('should throw when no agents exist', async () => {
      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      await expect(strategy.execute({ input: 'test task' })).rejects.toThrow(
        'Auction strategy requires at least 1 agent'
      );
    });

    it('should use default minBid of 0', async () => {
      coordinator.addAgent(createMockSwarmAgent('bidder-1'));
      coordinator.setAgentResponse('bidder-1', 'SCORE: 0.01\nCAPABILITIES: testing');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      const result = await strategy.execute({ input: 'test' });
      expect(result.auctionWinner).toBe('bidder-1');
    });
  });

  describe('bid collection', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('agent-a', { expertise: ['coding'] }));
      coordinator.addAgent(createMockSwarmAgent('agent-b', { expertise: ['testing'] }));
    });

    it('should collect bids from all agents via runAgentsParallel', async () => {
      coordinator.setAgentResponse('agent-a', 'SCORE: 0.8\nCAPABILITIES: coding');
      coordinator.setAgentResponse('agent-b', 'SCORE: 0.6\nCAPABILITIES: testing');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      await strategy.execute({ input: 'build a feature' });

      const calls = coordinator.getCalls();
      const bidCalls = calls.filter((c) => c.input.includes('auction'));
      expect(bidCalls).toHaveLength(2);
    });

    it('should pass biddingContext to agents', async () => {
      coordinator.setAgentResponse('agent-a', 'SCORE: 0.8');
      coordinator.setAgentResponse('agent-b', 'SCORE: 0.6');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      await strategy.execute({ input: 'task' });

      const callA = coordinator.getCallsFor('agent-a')[0];
      expect(callA?.context?.biddingContext).toMatchObject({
        isBidPhase: true,
        expertise: ['coding'],
      });
    });

    it('should support custom bidFunction', async () => {
      const customBidFn = vi.fn().mockReturnValueOnce(0.9).mockReturnValueOnce(0.3);

      coordinator.setAgentResponse('agent-a', 'Winner output');
      coordinator.setAgentResponse('agent-b', 'Loser output');

      const strategy = new AuctionStrategy(coordinator, {
        selection: 'highest-bid',
        bidding: 'custom',
        bidFunction: customBidFn,
      });

      const result = await strategy.execute({ input: 'custom bid task' });

      expect(customBidFn).toHaveBeenCalledTimes(2);
      expect(result.auctionWinner).toBe('agent-a');
    });

    it('should handle bidFunction errors gracefully', async () => {
      const failingBidFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Bid failed'))
        .mockReturnValueOnce(0.5);

      coordinator.setAgentResponse('agent-a', 'output');
      coordinator.setAgentResponse('agent-b', 'output');

      const strategy = new AuctionStrategy(coordinator, {
        selection: 'highest-bid',
        bidding: 'custom',
        bidFunction: failingBidFn,
      });

      const result = await strategy.execute({ input: 'task' });

      expect(result.bids?.get('agent-a')).toBe(0);
      expect(result.bids?.get('agent-b')).toBe(0.5);
    });
  });

  describe('bid parsing', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('parser-test'));
    });

    it('should parse SCORE from response', async () => {
      coordinator.setAgentResponse('parser-test', 'SCORE: 0.75\nCAPABILITIES: parsing');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      const result = await strategy.execute({ input: 'test' });
      expect(result.bids?.get('parser-test')).toBe(0.75);
    });

    it('should clamp score to 0-1 range', async () => {
      coordinator.addAgent(createMockSwarmAgent('high-bidder'));
      coordinator.setAgentResponse('parser-test', 'SCORE: 1.5');
      coordinator.setAgentResponse('high-bidder', 'SCORE: -0.5');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      const result = await strategy.execute({ input: 'test' });

      expect(result.bids?.get('parser-test')).toBeLessThanOrEqual(1);
      expect(result.bids?.get('high-bidder')).toBeGreaterThanOrEqual(0);
    });

    it('should default to 0.5 for invalid score', async () => {
      coordinator.setAgentResponse('parser-test', 'SCORE: invalid\nCAPABILITIES: testing');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      const result = await strategy.execute({ input: 'test' });
      expect(result.bids?.get('parser-test')).toBe(0.5);
    });

    it('should default to 0.5 when no SCORE found', async () => {
      coordinator.setAgentResponse('parser-test', 'I can do this task well');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      const result = await strategy.execute({ input: 'test' });
      expect(result.bids?.get('parser-test')).toBe(0.5);
    });

    it('should parse CAPABILITIES from response', async () => {
      coordinator.setAgentResponse(
        'parser-test',
        'SCORE: 0.8\nCAPABILITIES: coding, testing, debugging'
      );

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      await strategy.execute({ input: 'test' });

      const call = coordinator.getLastCallFor('parser-test');
      expect(call?.context?.auctionContext).toBeDefined();
    });
  });

  describe('winner selection', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('low-bidder'));
      coordinator.addAgent(createMockSwarmAgent('mid-bidder'));
      coordinator.addAgent(createMockSwarmAgent('high-bidder'));
    });

    it('should select highest bidder by default', async () => {
      coordinator.setAgentResponse('low-bidder', 'SCORE: 0.3');
      coordinator.setAgentResponse('mid-bidder', 'SCORE: 0.5');
      coordinator.setAgentResponse('high-bidder', 'SCORE: 0.9');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      const result = await strategy.execute({ input: 'task' });
      expect(result.auctionWinner).toBe('high-bidder');
    });

    it('should select via weighted-random when configured', async () => {
      coordinator.setAgentResponse('low-bidder', 'SCORE: 0.0');
      coordinator.setAgentResponse('mid-bidder', 'SCORE: 0.0');
      coordinator.setAgentResponse('high-bidder', 'SCORE: 1.0');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'weighted-random',
      });

      const result = await strategy.execute({ input: 'task' });
      expect(result.auctionWinner).toBe('high-bidder');
    });

    it('should handle all-zero weights in weighted-random', async () => {
      coordinator.setAgentResponse('low-bidder', 'SCORE: 0.0');
      coordinator.setAgentResponse('mid-bidder', 'SCORE: 0.0');
      coordinator.setAgentResponse('high-bidder', 'SCORE: 0.0');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'weighted-random',
      });

      const result = await strategy.execute({ input: 'task' });
      expect(['low-bidder', 'mid-bidder', 'high-bidder']).toContain(result.auctionWinner);
    });
  });

  describe('minBid filtering', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('below-threshold'));
      coordinator.addAgent(createMockSwarmAgent('above-threshold'));
    });

    it('should filter out bids below minBid', async () => {
      coordinator.setAgentResponse('below-threshold', 'SCORE: 0.2');
      coordinator.setAgentResponse('above-threshold', 'SCORE: 0.6');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
        minBid: 0.5,
      });

      const result = await strategy.execute({ input: 'task' });

      expect(result.auctionWinner).toBe('above-threshold');
      expect(result.bids?.has('below-threshold')).toBe(false);
    });

    it('should throw when all bids are below minBid', async () => {
      coordinator.setAgentResponse('below-threshold', 'SCORE: 0.1');
      coordinator.setAgentResponse('above-threshold', 'SCORE: 0.2');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
        minBid: 0.5,
      });

      await expect(strategy.execute({ input: 'task' })).rejects.toThrow(
        'No valid bids received (all below minimum threshold)'
      );
    });

    it('should include bids equal to minBid', async () => {
      coordinator.setAgentResponse('below-threshold', 'SCORE: 0.49');
      coordinator.setAgentResponse('above-threshold', 'SCORE: 0.5');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
        minBid: 0.5,
      });

      const result = await strategy.execute({ input: 'task' });
      expect(result.auctionWinner).toBe('above-threshold');
    });
  });

  describe('winner execution', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('winner-agent'));
      coordinator.addAgent(createMockSwarmAgent('loser-agent'));
    });

    it('should execute task with winning agent', async () => {
      coordinator.setAgentResponse('winner-agent', (input) => {
        if (input.includes('auction')) return 'SCORE: 0.9';
        return 'Winner executed the task';
      });
      coordinator.setAgentResponse('loser-agent', 'SCORE: 0.1');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      const result = await strategy.execute({ input: 'do something' });

      expect(result.output).toBe('Winner executed the task');
    });

    it('should pass auctionContext to winner', async () => {
      coordinator.setAgentResponse('winner-agent', (input) => {
        if (input.includes('auction')) return 'SCORE: 0.8';
        return 'executed';
      });
      coordinator.setAgentResponse('loser-agent', 'SCORE: 0.2');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      await strategy.execute({ input: 'task' });

      const executionCall = coordinator
        .getCallsFor('winner-agent')
        .find((c) => !c.input.includes('auction'));

      expect(executionCall?.context?.auctionContext).toMatchObject({
        wonBid: true,
        bidScore: 0.8,
        totalParticipants: 2,
        competingBids: 1,
      });
    });

    it('should include auctionInstructions in winner context', async () => {
      coordinator.setAgentResponse('winner-agent', (input) => {
        if (input.includes('auction')) return 'SCORE: 0.75';
        return 'done';
      });
      coordinator.setAgentResponse('loser-agent', 'SCORE: 0.25');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      await strategy.execute({ input: 'task' });

      const executionCall = coordinator
        .getCallsFor('winner-agent')
        .find((c) => !c.input.includes('auction'));

      expect(executionCall?.context?.auctionInstructions).toContain('0.75');
      expect(executionCall?.context?.auctionInstructions).toContain('You won the bid');
    });
  });

  describe('blackboard state', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('bidder'));
      coordinator.setAgentResponse('bidder', 'SCORE: 0.7');
    });

    it('should initialize auction state on blackboard', async () => {
      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      await strategy.execute({ input: 'test task' });

      const state = coordinator.blackboard.read<Record<string, unknown>>('auction');
      expect(state).toBeDefined();
      expect(state?.status).toBe('completed');
    });

    it('should update blackboard with winner info', async () => {
      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      await strategy.execute({ input: 'test' });

      const state = coordinator.blackboard.read<Record<string, unknown>>('auction');
      expect(state?.winner).toBe('bidder');
      expect(state?.winningBid).toBe(0.7);
    });
  });

  describe('events', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('event-bidder'));
      coordinator.setAgentResponse('event-bidder', 'SCORE: 0.6');
    });

    it('should emit auction:start event', async () => {
      const startHandler = vi.fn();
      coordinator.events.on('auction:start', startHandler);

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      await strategy.execute({ input: 'test task for auction' });

      expect(startHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            task: expect.stringContaining('test task'),
            participants: ['event-bidder'],
          }),
        })
      );
    });

    it('should emit auction:bid for each agent', async () => {
      coordinator.addAgent(createMockSwarmAgent('second-bidder'));
      coordinator.setAgentResponse('second-bidder', 'SCORE: 0.4');

      const bidHandler = vi.fn();
      coordinator.events.on('auction:bid', bidHandler);

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      await strategy.execute({ input: 'task' });

      expect(bidHandler).toHaveBeenCalledTimes(2);
    });

    it('should emit auction:winner event', async () => {
      const winnerHandler = vi.fn();
      coordinator.events.on('auction:winner', winnerHandler);

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      await strategy.execute({ input: 'task' });

      expect(winnerHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            winner: 'event-bidder',
            score: 0.6,
            totalBids: 1,
          }),
        })
      );
    });

    it('should emit auction:complete event', async () => {
      const completeHandler = vi.fn();
      coordinator.events.on('auction:complete', completeHandler);

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      await strategy.execute({ input: 'task' });

      expect(completeHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            winner: 'event-bidder',
            success: true,
          }),
        })
      );
    });
  });

  describe('result structure', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('result-agent'));
      coordinator.setAgentResponse('result-agent', (input) => {
        if (input.includes('auction')) return 'SCORE: 0.85';
        return 'Final output';
      });
    });

    it('should return bids map', async () => {
      coordinator.addAgent(createMockSwarmAgent('other-agent'));
      coordinator.setAgentResponse('other-agent', 'SCORE: 0.45');

      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      const result = await strategy.execute({ input: 'task' });

      expect(result.bids).toBeInstanceOf(Map);
      expect(result.bids?.get('result-agent')).toBe(0.85);
      expect(result.bids?.get('other-agent')).toBe(0.45);
    });

    it('should return auctionWinner', async () => {
      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      const result = await strategy.execute({ input: 'task' });
      expect(result.auctionWinner).toBe('result-agent');
    });

    it('should return winner output as final output', async () => {
      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      const result = await strategy.execute({ input: 'task' });
      expect(result.output).toBe('Final output');
    });

    it('should include winner result in agentResults', async () => {
      const strategy = new AuctionStrategy(coordinator, {
        bidding: 'capability-match',
        selection: 'highest-bid',
      });

      const result = await strategy.execute({ input: 'task' });

      expect(result.agentResults.has('result-agent')).toBe(true);
      expect(result.agentResults.get('result-agent')?.output).toBe('Final output');
    });

    it('should pass through structured output if present', async () => {
      coordinator.setAgentResponse('result-agent', {
        output: 'output',
        structured: { data: 'value' },
        runId: 'run1',
        agentId: 'agent1',
        threadId: 'thread1',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, duration: 0 },
        toolCalls: [],
        messages: [],
        trace: { traceId: 'trace1', spans: [] },
      });

      const strategy = new AuctionStrategy(coordinator, {
        selection: 'highest-bid',
        bidding: 'custom',
        bidFunction: () => 1.0,
      });

      const result = await strategy.execute({ input: 'task' });
      expect(result.structured).toEqual({ data: 'value' });
    });
  });
});
