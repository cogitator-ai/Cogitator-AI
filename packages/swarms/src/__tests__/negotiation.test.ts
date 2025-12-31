import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TurnManager } from '../strategies/negotiation/turn-manager';
import { ConvergenceCalculator } from '../strategies/negotiation/convergence';
import { ApprovalIntegration } from '../strategies/negotiation/approval';
import type {
  NegotiationOffer,
  NegotiationState,
  NegotiationAgreement,
  SwarmEventEmitter,
} from '@cogitator-ai/types';

describe('TurnManager', () => {
  describe('round-robin mode', () => {
    it('should cycle through agents in order', () => {
      const manager = new TurnManager({
        agents: ['alice', 'bob', 'charlie'],
        turnOrder: 'round-robin',
      });

      expect(manager.getCurrentAgent()).toBe('alice');
      expect(manager.advance()).toBe('bob');
      expect(manager.getCurrentAgent()).toBe('bob');
      expect(manager.advance()).toBe('charlie');
      expect(manager.advance()).toBe('alice');
    });

    it('should increment round after all agents have had a turn', () => {
      const manager = new TurnManager({
        agents: ['alice', 'bob'],
        turnOrder: 'round-robin',
      });

      expect(manager.getCurrentRound()).toBe(1);
      manager.advance();
      expect(manager.getCurrentRound()).toBe(1);
      manager.advance();
      expect(manager.getCurrentRound()).toBe(2);
    });

    it('should handle empty agents list', () => {
      const manager = new TurnManager({
        agents: [],
        turnOrder: 'round-robin',
      });

      expect(manager.getCurrentAgent()).toBeNull();
      expect(manager.advance()).toBeNull();
    });
  });

  describe('priority mode', () => {
    it('should order agents by weight (descending)', () => {
      const manager = new TurnManager({
        agents: ['alice', 'bob', 'charlie'],
        turnOrder: 'priority',
        weights: { alice: 1, bob: 3, charlie: 2 },
      });

      expect(manager.getCurrentAgent()).toBe('bob');
      expect(manager.advance()).toBe('charlie');
      expect(manager.advance()).toBe('alice');
    });

    it('should use default weight of 1 for unspecified agents', () => {
      const manager = new TurnManager({
        agents: ['alice', 'bob'],
        turnOrder: 'priority',
        weights: { bob: 5 },
      });

      expect(manager.getCurrentAgent()).toBe('bob');
    });
  });

  describe('dynamic reordering', () => {
    it('should reorder agents array based on pending offer count', () => {
      const manager = new TurnManager({
        agents: ['alice', 'bob', 'charlie'],
        turnOrder: 'dynamic',
      });

      manager.advance();

      const pendingOffers: NegotiationOffer[] = [
        createOffer('o1', 'alice', 'charlie'),
        createOffer('o2', 'bob', 'charlie'),
        createOffer('o3', 'alice', 'bob'),
      ];

      manager.reorderDynamic(pendingOffers);

      expect(manager.getCurrentAgent()).toBe('bob');
    });

    it('should not reorder if turn order is not dynamic', () => {
      const manager = new TurnManager({
        agents: ['alice', 'bob', 'charlie'],
        turnOrder: 'round-robin',
      });

      const original = manager.getCurrentAgent();
      manager.reorderDynamic([createOffer('o1', 'alice', 'charlie')]);
      expect(manager.getCurrentAgent()).toBe(original);
    });
  });

  describe('turn timeout', () => {
    it('should detect expired turn', () => {
      const manager = new TurnManager({
        agents: ['alice', 'bob'],
        turnOrder: 'round-robin',
        turnTimeout: 100,
      });

      manager.startTurn();
      expect(manager.isTurnExpired()).toBe(false);

      vi.useFakeTimers();
      vi.advanceTimersByTime(150);
      expect(manager.isTurnExpired()).toBe(true);
      vi.useRealTimers();
    });

    it('should skip current agent and record in history', () => {
      const manager = new TurnManager({
        agents: ['alice', 'bob', 'charlie'],
        turnOrder: 'round-robin',
      });

      manager.skipCurrentAgent();
      const history = manager.getTurnHistory();

      expect(history).toHaveLength(2);
      expect(history[0].action).toBe('turn_skipped');
      expect(history[0].agent).toBe('alice');
    });
  });

  describe('turn history', () => {
    it('should track turn completions', () => {
      const manager = new TurnManager({
        agents: ['alice', 'bob'],
        turnOrder: 'round-robin',
      });

      manager.advance();
      manager.advance();
      manager.advance();

      expect(manager.getAgentTurnCount('alice')).toBe(2);
      expect(manager.getAgentTurnCount('bob')).toBe(1);
    });

    it('should reset properly', () => {
      const manager = new TurnManager({
        agents: ['alice', 'bob'],
        turnOrder: 'round-robin',
      });

      manager.advance();
      manager.advance();
      manager.reset();

      expect(manager.getCurrentAgent()).toBe('alice');
      expect(manager.getCurrentRound()).toBe(1);
      expect(manager.getTurnHistory()).toHaveLength(0);
    });
  });
});

describe('ConvergenceCalculator', () => {
  let calculator: ConvergenceCalculator;

  beforeEach(() => {
    calculator = new ConvergenceCalculator({
      stagnationThreshold: 0.05,
      maxRoundsWithoutProgress: 3,
    });
  });

  describe('calculateTermConvergence', () => {
    it('should return 1 for identical numeric values', () => {
      const offers: NegotiationOffer[] = [
        createOfferWithTerms('o1', 'alice', [{ termId: 'price', value: 100 }]),
        createOfferWithTerms('o2', 'bob', [{ termId: 'price', value: 100 }]),
      ];

      expect(calculator.calculateTermConvergence(offers, 'price')).toBe(1);
    });

    it('should return value between 0 and 1 for partially divergent values', () => {
      const offers: NegotiationOffer[] = [
        createOfferWithTerms('o1', 'alice', [{ termId: 'price', value: 90 }]),
        createOfferWithTerms('o2', 'bob', [{ termId: 'price', value: 100 }]),
        createOfferWithTerms('o3', 'charlie', [{ termId: 'price', value: 95 }]),
      ];

      const convergence = calculator.calculateTermConvergence(offers, 'price');
      expect(convergence).toBeGreaterThan(0);
      expect(convergence).toBeLessThan(1);
    });

    it('should handle non-numeric terms', () => {
      const offers: NegotiationOffer[] = [
        createOfferWithTerms('o1', 'alice', [{ termId: 'method', value: 'wire' }]),
        createOfferWithTerms('o2', 'bob', [{ termId: 'method', value: 'wire' }]),
      ];

      expect(calculator.calculateTermConvergence(offers, 'method')).toBe(1);
    });

    it('should return 1/n for n different categorical values', () => {
      const offers: NegotiationOffer[] = [
        createOfferWithTerms('o1', 'alice', [{ termId: 'method', value: 'wire' }]),
        createOfferWithTerms('o2', 'bob', [{ termId: 'method', value: 'check' }]),
        createOfferWithTerms('o3', 'charlie', [{ termId: 'method', value: 'cash' }]),
      ];

      expect(calculator.calculateTermConvergence(offers, 'method')).toBeCloseTo(1 / 3, 5);
    });
  });

  describe('calculateOverallConvergence', () => {
    it('should aggregate term convergences', () => {
      const offers: NegotiationOffer[] = [
        createOfferWithTerms('o1', 'alice', [
          { termId: 'price', value: 100 },
          { termId: 'qty', value: 10 },
        ]),
        createOfferWithTerms('o2', 'bob', [
          { termId: 'price', value: 100 },
          { termId: 'qty', value: 10 },
        ]),
      ];

      const metrics = calculator.calculateOverallConvergence(offers, 1);

      expect(metrics.overallConvergence).toBe(1);
      expect(metrics.termConvergence['price']).toBe(1);
      expect(metrics.termConvergence['qty']).toBe(1);
    });

    it('should track convergence trend', () => {
      calculator.calculateOverallConvergence(
        [createOfferWithTerms('o1', 'alice', [{ termId: 'price', value: 50 }])],
        1
      );
      calculator.calculateOverallConvergence(
        [createOfferWithTerms('o2', 'alice', [{ termId: 'price', value: 60 }])],
        2
      );

      const metrics = calculator.calculateOverallConvergence(
        [createOfferWithTerms('o3', 'alice', [{ termId: 'price', value: 100 }])],
        3
      );

      expect(['improving', 'stable', 'declining']).toContain(metrics.convergenceTrend);
    });
  });

  describe('isStagnant', () => {
    it('should detect stagnation after configured rounds without progress', () => {
      for (let i = 0; i < 5; i++) {
        const round = i + 1;
        calculator.calculateOverallConvergence(
          [
            createOfferWithTerms(`o${i}a`, 'alice', [{ termId: 'price', value: 50 }], round),
            createOfferWithTerms(`o${i}b`, 'bob', [{ termId: 'price', value: 50 }], round),
          ],
          round
        );
      }

      expect(calculator.isStagnant()).toBe(true);
    });

    it('should not report stagnation with progress', () => {
      calculator.calculateOverallConvergence(
        [
          createOfferWithTerms('o1', 'alice', [{ termId: 'price', value: 30 }]),
          createOfferWithTerms('o2', 'bob', [{ termId: 'price', value: 100 }]),
        ],
        1
      );

      calculator.calculateOverallConvergence(
        [
          createOfferWithTerms('o3', 'alice', [{ termId: 'price', value: 60 }]),
          createOfferWithTerms('o4', 'bob', [{ termId: 'price', value: 70 }]),
        ],
        2
      );

      expect(calculator.isStagnant()).toBe(false);
    });
  });

  describe('suggestCompromise', () => {
    it('should suggest weighted average for numeric terms', () => {
      const offers: NegotiationOffer[] = [
        createOfferWithTerms('o1', 'alice', [
          { termId: 'price', value: 80, priority: 1, negotiable: true },
        ]),
        createOfferWithTerms('o2', 'bob', [
          { termId: 'price', value: 120, priority: 1, negotiable: true },
        ]),
      ];

      const suggestion = calculator.suggestCompromise(offers);

      expect(suggestion).not.toBeNull();
      expect(suggestion!.type).toBe('split_difference');
      expect(suggestion!.suggestedTerms).toHaveLength(1);
      expect(suggestion!.suggestedTerms[0].value).toBe(100);
    });

    it('should return null for fewer than 2 pending offers', () => {
      const offers: NegotiationOffer[] = [
        createOfferWithTerms('o1', 'alice', [{ termId: 'price', value: 100 }]),
      ];

      expect(calculator.suggestCompromise(offers)).toBeNull();
    });

    it('should respect priority weights in compromise', () => {
      const offers: NegotiationOffer[] = [
        createOfferWithTerms('o1', 'alice', [
          { termId: 'price', value: 100, priority: 3, negotiable: true },
        ]),
        createOfferWithTerms('o2', 'bob', [
          { termId: 'price', value: 200, priority: 1, negotiable: true },
        ]),
      ];

      const suggestion = calculator.suggestCompromise(offers);

      expect(suggestion!.suggestedTerms[0].value).toBe(125);
    });
  });
});

describe('ApprovalIntegration', () => {
  let integration: ApprovalIntegration;
  let mockEvents: SwarmEventEmitter;

  beforeEach(() => {
    mockEvents = {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      removeAllListeners: vi.fn(),
      listeners: vi.fn(),
    } as unknown as SwarmEventEmitter;

    integration = new ApprovalIntegration({
      gates: [
        { trigger: 'agreement-reached' },
        { trigger: 'high-value-term', condition: 'term:price>1000' },
        { trigger: 'deadlock', timeout: 100, timeoutAction: 'approve' },
      ],
      negotiationId: 'neg_123',
    });
  });

  describe('shouldTriggerApproval', () => {
    it('should match trigger without condition', () => {
      const state = createState();
      const gate = integration.shouldTriggerApproval('agreement-reached', state);

      expect(gate).not.toBeNull();
      expect(gate!.trigger).toBe('agreement-reached');
    });

    it('should evaluate term condition', () => {
      const state = createState();
      const offer: NegotiationOffer = createOfferWithTerms('o1', 'alice', [
        { termId: 'price', value: 1500 },
      ]);

      const gate = integration.shouldTriggerApproval('high-value-term', state, { offer });

      expect(gate).not.toBeNull();
    });

    it('should not trigger when condition fails', () => {
      const state = createState();
      const offer: NegotiationOffer = createOfferWithTerms('o1', 'alice', [
        { termId: 'price', value: 500 },
      ]);

      const gate = integration.shouldTriggerApproval('high-value-term', state, { offer });

      expect(gate).toBeNull();
    });

    it('should return null for unmatched trigger', () => {
      const state = createState();
      const gate = integration.shouldTriggerApproval('coalition-formed', state);

      expect(gate).toBeNull();
    });
  });

  describe('requestApproval', () => {
    it('should emit approval-required event', () => {
      const state = createState();
      const gate = {
        trigger: 'agreement-reached' as const,
        timeout: 50,
        timeoutAction: 'approve' as const,
      };

      integration.requestApproval(gate, state, mockEvents);

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'negotiation:approval-required',
        expect.objectContaining({ gate }),
        'system'
      );
    });

    it('should handle timeout with approve action', async () => {
      vi.useFakeTimers();

      const state = createState();
      const gate = {
        trigger: 'deadlock' as const,
        timeout: 100,
        timeoutAction: 'approve' as const,
      };

      const promise = integration.requestApproval(gate, state, mockEvents);

      vi.advanceTimersByTime(150);

      const response = await promise;
      expect(response.approved).toBe(true);
      expect(response.decision).toBe('approved');

      vi.useRealTimers();
    });

    it('should handle timeout with reject action', async () => {
      vi.useFakeTimers();

      const rejectIntegration = new ApprovalIntegration({
        gates: [{ trigger: 'deadlock', timeout: 100, timeoutAction: 'reject' }],
        negotiationId: 'neg_456',
      });

      const state = createState();
      const gate = { trigger: 'deadlock' as const, timeout: 100, timeoutAction: 'reject' as const };

      const promise = rejectIntegration.requestApproval(gate, state, mockEvents);

      vi.advanceTimersByTime(150);

      const response = await promise;
      expect(response.approved).toBe(false);
      expect(response.decision).toBe('rejected');

      vi.useRealTimers();
    });

    it('should handle timeout with escalate action', async () => {
      vi.useFakeTimers();

      const escalateIntegration = new ApprovalIntegration({
        gates: [{ trigger: 'deadlock', timeout: 100, timeoutAction: 'escalate' }],
        negotiationId: 'neg_789',
      });

      const state = createState();
      const gate = {
        trigger: 'deadlock' as const,
        timeout: 100,
        timeoutAction: 'escalate' as const,
      };

      const promise = escalateIntegration.requestApproval(gate, state, mockEvents);

      vi.advanceTimersByTime(150);

      await promise;

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'negotiation:escalation',
        expect.objectContaining({ reason: 'approval_timeout' }),
        'system'
      );

      vi.useRealTimers();
    });
  });

  describe('pending approvals management', () => {
    it('should track pending count', async () => {
      vi.useFakeTimers();

      const state = createState();
      const gate = { trigger: 'deadlock' as const, timeout: 1000 };

      integration.requestApproval(gate, state, mockEvents);

      expect(integration.getPendingCount()).toBe(1);

      vi.advanceTimersByTime(1100);
      await Promise.resolve();

      expect(integration.getPendingCount()).toBe(0);

      vi.useRealTimers();
    });

    it('should cancel all pending approvals', () => {
      const state = createState();
      const gate = { trigger: 'deadlock' as const, timeout: 10000 };

      integration.requestApproval(gate, state, mockEvents);
      integration.requestApproval(gate, state, mockEvents);

      expect(integration.getPendingCount()).toBe(2);

      integration.cancelAll();

      expect(integration.getPendingCount()).toBe(0);
    });
  });
});

function createOffer(id: string, from: string, to: string | string[]): NegotiationOffer {
  return {
    id,
    from,
    to,
    terms: [],
    reasoning: 'Test offer',
    timestamp: Date.now(),
    status: 'pending',
    round: 1,
    phase: 'proposal',
  };
}

function createOfferWithTerms(
  id: string,
  from: string,
  terms: Array<{ termId: string; value: unknown; priority?: number; negotiable?: boolean }>,
  round = 1
): NegotiationOffer {
  return {
    id,
    from,
    to: 'other',
    terms: terms.map((t) => ({
      termId: t.termId,
      label: t.termId,
      value: t.value,
      negotiable: t.negotiable ?? false,
      priority: t.priority ?? 1,
    })),
    reasoning: 'Test offer',
    timestamp: Date.now(),
    status: 'pending',
    round,
    phase: 'proposal',
  };
}

function createState(): NegotiationState {
  return {
    negotiationId: 'neg_test',
    phase: 'proposal',
    round: 1,
    maxRounds: 10,
    offers: [],
    coalitions: [],
    interests: {},
    currentTurn: 'alice',
    turnHistory: [],
    pendingApprovals: [],
    convergenceHistory: [],
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}
