import { nanoid } from 'nanoid';
import type {
  SwarmRunOptions,
  StrategyResult,
  NegotiationConfig,
  NegotiationState,
  NegotiationOffer,
  NegotiationAgreement,
  NegotiationApprovalResponse,
  NegotiationResult,
  NegotiationTerm,
  RunResult,
  ArbitrationResult,
  MediationSuggestion,
  SwarmAgent,
  SwarmCoordinatorInterface,
} from '@cogitator-ai/types';
import { DEFAULT_NEGOTIATION_CONFIG } from '@cogitator-ai/types';
import { BaseStrategy } from './base.js';
import { TurnManager } from './negotiation/turn-manager.js';
import { ConvergenceCalculator } from './negotiation/convergence.js';
import { ApprovalIntegration } from './negotiation/approval.js';
import {
  MEDIATOR_ID,
  NEGOTIATION_RULES_SECTION,
  NEGOTIATION_SECTION,
  isFullyAccepted,
  isOfferExpired,
  offerParties,
  readNegotiationState,
  type NegotiationRules,
} from '../shared/negotiation.js';

type TurnPhase = 'init' | 'proposal' | 'counter' | 'refinement';

export class NegotiationStrategy extends BaseStrategy {
  private config: NegotiationConfig;
  private state!: NegotiationState;
  private agentNames: string[] = [];
  private turnManager!: TurnManager;
  private convergenceCalculator!: ConvergenceCalculator;
  private approvalIntegration?: ApprovalIntegration;
  private reviewedOfferIds = new Set<string>();
  private reviewedCoalitionIds = new Set<string>();
  private lastMediationRound?: number;

  constructor(coordinator: SwarmCoordinatorInterface, config: Partial<NegotiationConfig> = {}) {
    super(coordinator);
    this.config = { ...DEFAULT_NEGOTIATION_CONFIG, ...config };
  }

  async execute(options: SwarmRunOptions): Promise<StrategyResult> {
    const agentResults = new Map<string, RunResult>();
    const negotiationId = `negotiation_${nanoid(12)}`;

    const agents = this.coordinator.getAgents();
    const negotiatingAgents = agents.filter(
      (a) => a.metadata.role !== 'supervisor' && a.metadata.role !== 'moderator'
    );

    if (negotiatingAgents.length < 2) {
      throw new Error('Negotiation strategy requires at least 2 agents');
    }

    this.agentNames = negotiatingAgents.map((a) => a.agent.name);
    this.reviewedOfferIds.clear();
    this.reviewedCoalitionIds.clear();
    this.lastMediationRound = undefined;

    this.initializeState(negotiationId);
    this.initializeHelpers(this.agentNames, negotiationId);

    this.coordinator.events.emit(
      'negotiation:start',
      {
        negotiationId,
        agents: this.agentNames,
        config: this.config,
      },
      'system'
    );

    try {
      await this.runInitializationPhase(options, negotiatingAgents, agentResults);

      for (let round = 1; round <= this.config.maxRounds; round++) {
        this.state.round = round;
        this.turnManager.setRound(round);
        this.updateBlackboard();

        this.coordinator.events.emit(
          'negotiation:round',
          { round, maxRounds: this.config.maxRounds },
          'system'
        );

        await this.runProposalPhase(options, negotiatingAgents, agentResults);

        if (await this.checkForAgreement()) {
          return this.finalizeResult(agentResults, 'agreement');
        }

        await this.runCounterPhase(options, negotiatingAgents, agentResults);

        if (await this.checkForAgreement()) {
          return this.finalizeResult(agentResults, 'agreement');
        }

        const metrics = this.convergenceCalculator.calculateOverallConvergence(
          this.state.offers,
          round
        );
        this.state.convergenceHistory = [...this.state.convergenceHistory, metrics];
        this.updateBlackboard();

        this.coordinator.events.emit(
          'negotiation:convergence-update',
          { metrics, round },
          'system'
        );

        if (this.convergenceCalculator.isStagnant() && this.lastMediationRound === undefined) {
          this.coordinator.events.emit(
            'negotiation:stagnation-detected',
            { round, metrics },
            'system'
          );

          const mediationSuggestion = this.convergenceCalculator.suggestCompromise(
            this.state.offers.filter((o) => o.from !== MEDIATOR_ID)
          );

          if (mediationSuggestion) {
            this.lastMediationRound = round;
            this.coordinator.events.emit(
              'negotiation:mediation-suggested',
              { suggestion: mediationSuggestion },
              'system'
            );
            await this.runRefinementPhase(
              options,
              negotiatingAgents,
              agentResults,
              mediationSuggestion
            );

            if (await this.checkForAgreement()) {
              return this.finalizeResult(agentResults, 'agreement');
            }
          }
        }

        if (this.isDeadlocked(round)) {
          return this.handleDeadlock(options, agentResults);
        }
      }

      return this.handleDeadlock(options, agentResults);
    } finally {
      this.approvalIntegration?.cancelAll();
    }
  }

  /**
   * Answer a pending approval request (see the `negotiation:approval-required` event).
   */
  respondToApproval(requestId: string, response: NegotiationApprovalResponse): void {
    if (!this.approvalIntegration) {
      throw new Error('No approval gates are configured for this negotiation');
    }
    this.approvalIntegration.submitResponse(requestId, response);
  }

  private initializeState(negotiationId: string): void {
    this.state = {
      negotiationId,
      phase: 'initialization',
      round: 0,
      maxRounds: this.config.maxRounds,
      offers: [],
      coalitions: [],
      interests: {},
      currentTurn: null,
      turnHistory: [],
      pendingApprovals: [],
      convergenceHistory: [],
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    const rules: NegotiationRules = {
      maxOffersPerRound: this.config.maxOffersPerRound,
      offerTimeout: this.config.offerTimeout,
      allowCoalitions: this.config.allowCoalitions ?? true,
      minCoalitionSize: this.config.minCoalitionSize ?? 2,
    };

    this.coordinator.blackboard.write(NEGOTIATION_RULES_SECTION, rules, 'system');
    this.updateBlackboard();
  }

  private initializeHelpers(agentNames: string[], negotiationId: string): void {
    this.turnManager = new TurnManager({
      agents: agentNames,
      turnOrder: this.config.turnOrder ?? 'round-robin',
      weights: this.config.weights,
      turnTimeout: this.config.turnTimeout,
    });

    this.convergenceCalculator = new ConvergenceCalculator({
      stagnationThreshold: this.config.stagnationThreshold ?? 0.05,
      maxRoundsWithoutProgress: this.config.maxRoundsWithoutProgress ?? 3,
    });

    this.approvalIntegration =
      this.config.approvalGates && this.config.approvalGates.length > 0
        ? new ApprovalIntegration({ gates: this.config.approvalGates, negotiationId })
        : undefined;
  }

  /**
   * Run one agent turn. A turn that exceeds `turnTimeout` is skipped instead of failing
   * the negotiation; any other error propagates.
   */
  private async runTurn(
    agent: SwarmAgent,
    prompt: string,
    options: SwarmRunOptions,
    phase: TurnPhase,
    results: Map<string, RunResult>,
    resultKey: string
  ): Promise<void> {
    const name = agent.agent.name;
    const turnTimeout = this.config.turnTimeout;
    const startedAt = Date.now();

    this.state.currentTurn = name;
    this.turnManager.startTurn();
    this.updateBlackboard();

    try {
      const result = await this.coordinator.runAgent(
        name,
        prompt,
        this.buildAgentContext(agent, options),
        turnTimeout !== undefined && turnTimeout > 0 ? { timeout: turnTimeout } : undefined
      );
      results.set(resultKey, result);
      this.syncState();
      this.state.turnHistory = [
        ...this.state.turnHistory,
        { agent: name, round: this.state.round, action: `${phase}_turn`, timestamp: Date.now() },
      ];
    } catch (error) {
      const timedOut =
        turnTimeout !== undefined && turnTimeout > 0 && Date.now() - startedAt >= turnTimeout;
      if (!timedOut) throw error;

      this.syncState();
      this.state.turnHistory = [
        ...this.state.turnHistory,
        { agent: name, round: this.state.round, action: 'turn_skipped', timestamp: Date.now() },
      ];
      this.coordinator.events.emit(
        'negotiation:turn',
        { agent: name, round: this.state.round, phase, skipped: true, reason: 'timeout' },
        name
      );
    }

    this.state.lastActivityAt = Date.now();
    this.updateBlackboard();
    await this.reviewNewActivity();
  }

  private async runInitializationPhase(
    options: SwarmRunOptions,
    agents: SwarmAgent[],
    results: Map<string, RunResult>
  ): Promise<void> {
    this.state.phase = 'initialization';
    this.updateBlackboard();

    this.coordinator.events.emit('negotiation:phase-change', { phase: 'initialization' }, 'system');

    const initPrompt = this.buildInitializationPrompt(options.input);

    for (const agent of agents) {
      await this.runTurn(agent, initPrompt, options, 'init', results, `${agent.agent.name}_init`);
      this.state.turnHistory = [
        ...this.state.turnHistory,
        { agent: agent.agent.name, round: 0, action: 'declared_interests', timestamp: Date.now() },
      ];
    }

    this.state.currentTurn = null;
    this.state.lastActivityAt = Date.now();
    this.updateBlackboard();
  }

  private async runProposalPhase(
    options: SwarmRunOptions,
    agents: SwarmAgent[],
    results: Map<string, RunResult>
  ): Promise<void> {
    this.state.phase = 'proposal';
    this.updateBlackboard();

    this.coordinator.events.emit(
      'negotiation:phase-change',
      { phase: 'proposal', round: this.state.round },
      'system'
    );

    const proposalPrompt = this.buildProposalPrompt(options.input);

    for (const agent of agents) {
      this.coordinator.events.emit(
        'negotiation:turn',
        { agent: agent.agent.name, round: this.state.round, phase: 'proposal' },
        agent.agent.name
      );

      await this.runTurn(
        agent,
        proposalPrompt,
        options,
        'proposal',
        results,
        `${agent.agent.name}_proposal_r${this.state.round}`
      );

      this.turnManager.advance();
    }

    this.state.currentTurn = null;
    this.state.lastActivityAt = Date.now();
    this.updateBlackboard();
  }

  private async runCounterPhase(
    options: SwarmRunOptions,
    agents: SwarmAgent[],
    results: Map<string, RunResult>
  ): Promise<void> {
    this.state.phase = 'counter';
    this.updateBlackboard();

    this.coordinator.events.emit(
      'negotiation:phase-change',
      { phase: 'counter', round: this.state.round },
      'system'
    );

    const pendingOffers = this.state.offers.filter((o) => o.status === 'pending');
    if (pendingOffers.length === 0) return;

    if (this.config.turnOrder === 'dynamic') {
      this.turnManager.reorderDynamic(pendingOffers);
    }

    const counterPrompt = this.buildCounterPrompt(options.input);

    for (const agent of agents) {
      const offersToAgent = this.state.offers.filter(
        (o) => o.status === 'pending' && this.isRecipient(o, agent.agent.name)
      );

      if (offersToAgent.length === 0) continue;

      this.coordinator.events.emit(
        'negotiation:turn',
        { agent: agent.agent.name, round: this.state.round, phase: 'counter' },
        agent.agent.name
      );

      await this.runTurn(
        agent,
        counterPrompt,
        options,
        'counter',
        results,
        `${agent.agent.name}_counter_r${this.state.round}`
      );

      this.turnManager.advance();
    }

    this.state.currentTurn = null;
    this.state.lastActivityAt = Date.now();
    this.updateBlackboard();
  }

  private async runRefinementPhase(
    options: SwarmRunOptions,
    agents: SwarmAgent[],
    results: Map<string, RunResult>,
    suggestion: MediationSuggestion
  ): Promise<void> {
    this.state.phase = 'refinement';

    const mediationOffer: NegotiationOffer = {
      id: `mediation_${nanoid(10)}`,
      from: MEDIATOR_ID,
      to: agents.map((a) => a.agent.name),
      terms: suggestion.suggestedTerms,
      reasoning: suggestion.rationale,
      timestamp: Date.now(),
      status: 'pending',
      round: this.state.round,
      phase: 'refinement',
    };
    this.state.offers = [
      ...this.state.offers.map((o) =>
        o.from === MEDIATOR_ID && o.status === 'pending'
          ? { ...o, status: 'withdrawn' as const }
          : o
      ),
      mediationOffer,
    ];
    this.reviewedOfferIds.add(mediationOffer.id);
    this.updateBlackboard();

    this.coordinator.events.emit(
      'negotiation:phase-change',
      { phase: 'refinement', round: this.state.round },
      'system'
    );

    const refinementPrompt = this.buildRefinementPrompt(
      options.input,
      suggestion,
      mediationOffer.id
    );

    for (const agent of agents) {
      await this.runTurn(
        agent,
        refinementPrompt,
        options,
        'refinement',
        results,
        `${agent.agent.name}_refinement_r${this.state.round}`
      );
    }

    this.state.currentTurn = null;
    this.state.lastActivityAt = Date.now();
    this.updateBlackboard();
  }

  /**
   * Pick up changes made by negotiation tools during the last turn and expire stale offers.
   */
  private syncState(): void {
    const latest = readNegotiationState(this.coordinator.blackboard);
    if (latest?.negotiationId === this.state.negotiationId) {
      this.state = {
        ...latest,
        offers: [...latest.offers],
        coalitions: [...latest.coalitions],
        turnHistory: [...latest.turnHistory],
        convergenceHistory: [...latest.convergenceHistory],
        interests: { ...latest.interests },
      };
    }

    const now = Date.now();
    this.state.offers = this.state.offers.map((offer) => {
      if (offer.status !== 'pending' || !isOfferExpired(offer, now)) return offer;
      this.coordinator.events.emit(
        'negotiation:offer-expired',
        { offerId: offer.id, from: offer.from },
        'system'
      );
      return { ...offer, status: 'expired' as const };
    });
  }

  /**
   * Route new offers and newly formed coalitions through the configured approval gates.
   */
  private async reviewNewActivity(): Promise<void> {
    const newOffers = this.state.offers.filter((o) => !this.reviewedOfferIds.has(o.id));
    const newCoalitions = this.state.coalitions.filter(
      (c) => c.status === 'active' && !this.reviewedCoalitionIds.has(c.id)
    );

    for (const offer of newOffers) this.reviewedOfferIds.add(offer.id);
    for (const coalition of newCoalitions) this.reviewedCoalitionIds.add(coalition.id);

    if (!this.approvalIntegration) return;

    for (const offer of newOffers) {
      const gate = this.approvalIntegration.shouldTriggerApproval('high-value-term', this.state, {
        offer,
      });
      if (!gate) continue;

      const response = await this.approvalIntegration.requestApproval(
        gate,
        this.state,
        this.coordinator.events,
        { offer }
      );
      if (!response.approved) {
        this.syncState();
        this.state.offers = this.state.offers.map((o) =>
          o.id === offer.id && o.status === 'pending' ? { ...o, status: 'withdrawn' as const } : o
        );
        this.updateBlackboard();
      }
    }

    for (const coalition of newCoalitions) {
      const gate = this.approvalIntegration.shouldTriggerApproval('coalition-formed', this.state);
      if (!gate) continue;

      const response = await this.approvalIntegration.requestApproval(
        gate,
        this.state,
        this.coordinator.events
      );
      if (!response.approved) {
        this.syncState();
        this.state.coalitions = this.state.coalitions.map((c) =>
          c.id === coalition.id ? { ...c, status: 'dissolved' as const } : c
        );
        this.updateBlackboard();
        this.coordinator.events.emit(
          'negotiation:coalition-dissolved',
          { coalitionId: coalition.id, reason: 'approval_rejected' },
          'system'
        );
      }
    }
  }

  private isRecipient(offer: NegotiationOffer, agentName: string): boolean {
    return (Array.isArray(offer.to) ? offer.to : [offer.to]).includes(agentName);
  }

  private meetsQuorum(offer: NegotiationOffer): boolean {
    const quorum = this.config.quorum;
    if (quorum === undefined || quorum <= 0) return true;

    const required = quorum <= 1 ? Math.ceil(quorum * this.agentNames.length) : Math.ceil(quorum);
    return new Set(offerParties(offer)).size >= required;
  }

  private async checkForAgreement(): Promise<boolean> {
    const candidates = this.state.offers
      .filter((o) => o.status === 'accepted' && isFullyAccepted(this.state, o))
      .filter((o) => this.meetsQuorum(o))
      .sort((a, b) => b.timestamp - a.timestamp);

    for (const offer of candidates) {
      const agreement = this.buildAgreement(offer);

      if (this.approvalIntegration) {
        const gate = this.approvalIntegration.shouldTriggerApproval(
          'agreement-reached',
          this.state,
          { agreement }
        );

        if (gate) {
          this.state.phase = 'agreement';
          this.updateBlackboard();

          const response = await this.approvalIntegration.requestApproval(
            gate,
            this.state,
            this.coordinator.events,
            { agreement }
          );

          if (!response.approved) {
            this.state.offers = this.state.offers.map((o) =>
              o.id === offer.id ? { ...o, status: 'withdrawn' as const } : o
            );
            this.updateBlackboard();
            continue;
          }

          agreement.approvalStatus = 'approved';
          agreement.approvalResponse = {
            approvedBy: response.respondedBy,
            approvedAt: response.respondedAt,
            comment: response.comment,
          };
        }
      }

      this.state.agreement = agreement;
      this.state.phase = 'agreement';
      this.updateBlackboard();
      return true;
    }

    return false;
  }

  private buildAgreement(offer: NegotiationOffer): NegotiationAgreement {
    const relatedOfferIds = [offer.id];
    const visited = new Set(relatedOfferIds);
    let current = offer;
    while (current.inResponseTo && !visited.has(current.inResponseTo)) {
      relatedOfferIds.push(current.inResponseTo);
      visited.add(current.inResponseTo);
      const parent = this.state.offers.find((o) => o.id === current.inResponseTo);
      if (!parent) break;
      current = parent;
    }

    return {
      id: `agreement_${nanoid(12)}`,
      parties: Array.from(new Set(offerParties(offer))),
      terms: offer.terms,
      reachedVia: offer.from === MEDIATOR_ID ? 'compromise' : 'consensus',
      timestamp: Date.now(),
      sourceOffers: relatedOfferIds,
      requiresApproval: !!this.approvalIntegration,
    };
  }

  private isDeadlocked(round: number): boolean {
    const latestMetrics = this.state.convergenceHistory[this.state.convergenceHistory.length - 1];
    if (!latestMetrics) return false;

    const mediationFailed =
      this.lastMediationRound !== undefined && this.lastMediationRound < round;
    if (
      mediationFailed &&
      latestMetrics.roundsWithoutProgress >= (this.config.maxRoundsWithoutProgress ?? 3)
    ) {
      return true;
    }

    return latestMetrics.convergenceTrend === 'declining' && latestMetrics.overallConvergence < 0.2;
  }

  private async handleDeadlock(
    options: SwarmRunOptions,
    results: Map<string, RunResult>
  ): Promise<StrategyResult> {
    this.state.phase = 'deadlock';
    this.updateBlackboard();

    this.coordinator.events.emit(
      'negotiation:deadlock',
      { round: this.state.round, offers: this.state.offers.length },
      'system'
    );

    switch (this.config.onDeadlock) {
      case 'escalate':
        return this.escalate(results);

      case 'supervisor-decides': {
        const supervisors = this.coordinator.getAgentsByRole('supervisor');
        if (supervisors.length > 0) {
          return this.supervisorDecides(options, supervisors[0], results);
        }
        return this.finalizeResult(results, 'deadlock');
      }

      case 'majority-rules':
        return this.majorityRules(results);

      case 'arbitrate':
        return this.arbitrate(results);

      case 'fail':
      default:
        return this.finalizeResult(results, 'deadlock');
    }
  }

  private async escalate(results: Map<string, RunResult>): Promise<StrategyResult> {
    this.state.phase = 'escalation';
    this.updateBlackboard();

    this.coordinator.events.emit(
      'negotiation:escalation',
      { reason: 'deadlock', round: this.state.round },
      'system'
    );

    if (this.approvalIntegration) {
      const gate = this.approvalIntegration.shouldTriggerApproval('deadlock', this.state);

      if (gate) {
        const response = await this.approvalIntegration.requestApproval(
          gate,
          this.state,
          this.coordinator.events
        );

        if (response.approved && response.suggestedModifications) {
          this.coordinator.events.emit(
            'negotiation:escalation',
            {
              reason: 'authority_modifications',
              suggestedModifications: response.suggestedModifications,
              respondedBy: response.respondedBy,
            },
            'system'
          );
        }
      }
    }

    return this.finalizeResult(results, 'escalated');
  }

  private async supervisorDecides(
    options: SwarmRunOptions,
    supervisor: SwarmAgent,
    results: Map<string, RunResult>
  ): Promise<StrategyResult> {
    const decisionPrompt = this.buildSupervisorDecisionPrompt(options.input);

    const result = await this.coordinator.runAgent(supervisor.agent.name, decisionPrompt, {
      ...options.context,
      negotiationState: this.state,
    });
    results.set(`${supervisor.agent.name}_decision`, result);

    return this.finalizeResult(results, 'deadlock');
  }

  private majorityRules(results: Map<string, RunResult>): StrategyResult {
    const latestOffers = new Map<string, NegotiationOffer>();
    for (const offer of [...this.state.offers].sort((a, b) => a.timestamp - b.timestamp)) {
      if (offer.from === MEDIATOR_ID) continue;
      if (offer.status === 'pending' || offer.status === 'accepted') {
        latestOffers.set(offer.from, offer);
      }
    }

    const termVotes = new Map<string, Map<string, number>>();

    for (const offer of latestOffers.values()) {
      for (const term of offer.terms) {
        let valueVotes = termVotes.get(term.termId);
        if (!valueVotes) {
          valueVotes = new Map();
          termVotes.set(term.termId, valueVotes);
        }
        const valueKey = JSON.stringify(term.value);
        valueVotes.set(valueKey, (valueVotes.get(valueKey) ?? 0) + 1);
      }
    }

    const majorityTerms: NegotiationTerm[] = [];
    for (const [termId, votes] of termVotes) {
      let maxVotes = 0;
      let winningValue: NegotiationTerm['value'] = '';
      for (const [valueKey, count] of votes) {
        if (count > maxVotes) {
          maxVotes = count;
          winningValue = JSON.parse(valueKey) as NegotiationTerm['value'];
        }
      }

      const sampleTerm = Array.from(latestOffers.values())
        .flatMap((o) => o.terms)
        .find((t) => t.termId === termId);

      if (sampleTerm) {
        majorityTerms.push({ ...sampleTerm, value: winningValue });
      }
    }

    const agreement: NegotiationAgreement = {
      id: `agreement_${nanoid(12)}`,
      parties: [...this.agentNames],
      terms: majorityTerms,
      reachedVia: 'majority',
      timestamp: Date.now(),
      sourceOffers: Array.from(latestOffers.values()).map((o) => o.id),
      requiresApproval: false,
    };

    this.state.agreement = agreement;
    this.updateBlackboard();

    return this.finalizeResult(results, 'agreement');
  }

  private arbitrate(results: Map<string, RunResult>): StrategyResult {
    this.coordinator.events.emit('negotiation:arbitration', { round: this.state.round }, 'system');

    const openOffers = this.state.offers.filter(
      (o) => o.status === 'pending' || o.status === 'countered'
    );

    if (openOffers.length === 0) {
      return this.finalizeResult(results, 'deadlock');
    }

    const arbitrationResult = this.performArbitration(openOffers);

    const agreement: NegotiationAgreement = {
      id: `agreement_${nanoid(12)}`,
      parties: [...this.agentNames],
      terms: arbitrationResult.proposal.terms,
      reachedVia: 'arbitration',
      timestamp: Date.now(),
      sourceOffers: [arbitrationResult.proposal.id],
      requiresApproval: false,
    };

    this.state.agreement = agreement;
    this.updateBlackboard();

    return this.finalizeResult(results, 'arbitrated');
  }

  private performArbitration(offers: NegotiationOffer[]): ArbitrationResult {
    const allTermIds = new Set<string>();
    for (const offer of offers) {
      for (const term of offer.terms) {
        allTermIds.add(term.termId);
      }
    }

    const arbitratedTerms: NegotiationTerm[] = [];

    for (const termId of allTermIds) {
      const termValues = offers.flatMap((o) => o.terms).filter((t) => t.termId === termId);

      if (termValues.length === 0) continue;

      const numericValues = termValues.filter(
        (t): t is NegotiationTerm & { value: number } => typeof t.value === 'number'
      );
      if (numericValues.length > 0) {
        const totalWeight = numericValues.reduce((s, t) => s + Math.max(t.priority, 0), 0);
        const weightedAvg =
          totalWeight > 0
            ? numericValues.reduce(
                (s, t) => s + (t.value * Math.max(t.priority, 0)) / totalWeight,
                0
              )
            : numericValues.reduce((s, t) => s + t.value, 0) / numericValues.length;

        arbitratedTerms.push({
          ...numericValues[0],
          value: Math.round(weightedAvg * 100) / 100,
          negotiable: false,
        });
      } else {
        arbitratedTerms.push({
          ...termValues[0],
          negotiable: false,
        });
      }
    }

    const arbitratedOffer: NegotiationOffer = {
      id: `arbitration_${nanoid(8)}`,
      from: 'arbitrator',
      to: [...this.agentNames],
      terms: arbitratedTerms,
      reasoning: 'Terms determined by weighted average arbitration',
      timestamp: Date.now(),
      status: 'accepted',
      round: this.state.round,
      phase: 'escalation',
    };

    return {
      method: 'weighted_average',
      proposal: arbitratedOffer,
      binding: true,
      reasoning:
        'Arbitration performed using weighted average of all positions based on term priorities',
    };
  }

  private finalizeResult(
    results: Map<string, RunResult>,
    outcome: NegotiationResult['outcome']
  ): StrategyResult {
    const negotiationResult: NegotiationResult = {
      negotiationId: this.state.negotiationId,
      outcome,
      agreement: this.state.agreement,
      offers: this.state.offers,
      coalitions: this.state.coalitions,
      finalPositions: this.getFinalPositions(),
      convergenceHistory: this.state.convergenceHistory,
      rounds: this.state.round,
      duration: Date.now() - this.state.startedAt,
    };

    this.coordinator.events.emit(
      outcome === 'agreement' ? 'negotiation:agreement-reached' : 'negotiation:terminated',
      outcome === 'agreement'
        ? { agreement: this.state.agreement, result: negotiationResult }
        : { result: negotiationResult },
      'system'
    );

    const output = this.buildFinalOutput(negotiationResult);

    return {
      output,
      agentResults: results,
      negotiationResult,
    };
  }

  private getFinalPositions(): Record<string, NegotiationOffer | undefined> {
    const positions: Record<string, NegotiationOffer | undefined> = {};

    for (const agentName of this.agentNames) {
      positions[agentName] = this.state.offers
        .filter((o) => o.from === agentName)
        .sort((a, b) => b.timestamp - a.timestamp)[0];
    }

    return positions;
  }

  private buildFinalOutput(result: NegotiationResult): string {
    let output = `=== Negotiation ${result.outcome.toUpperCase()} ===\n\n`;
    output += `Negotiation ID: ${result.negotiationId}\n`;
    output += `Outcome: ${result.outcome}\n`;
    output += `Rounds: ${result.rounds}\n`;
    output += `Duration: ${Math.round(result.duration / 1000)}s\n\n`;

    if (result.agreement) {
      output += `=== Agreement ===\n`;
      output += `Parties: ${result.agreement.parties.join(', ')}\n`;
      output += `Reached via: ${result.agreement.reachedVia}\n\n`;
      output += `Terms:\n`;
      for (const term of result.agreement.terms) {
        output += `  - ${term.label}: ${JSON.stringify(term.value)}\n`;
      }
      output += '\n';
    }

    output += `=== Final Positions ===\n`;
    for (const [agent, offer] of Object.entries(result.finalPositions)) {
      if (offer) {
        output += `\n${agent}:\n`;
        for (const term of offer.terms) {
          output += `  - ${term.label}: ${JSON.stringify(term.value)}\n`;
        }
      }
    }

    if (result.convergenceHistory.length > 0) {
      const latest = result.convergenceHistory[result.convergenceHistory.length - 1];
      output += `\n=== Convergence ===\n`;
      output += `Final convergence: ${Math.round(latest.overallConvergence * 100)}%\n`;
      output += `Trend: ${latest.convergenceTrend}\n`;
    }

    return output;
  }

  private updateBlackboard(): void {
    this.coordinator.blackboard.write(NEGOTIATION_SECTION, { ...this.state }, 'system');
  }

  private buildAgentContext(agent: SwarmAgent, options: SwarmRunOptions): Record<string, unknown> {
    return {
      ...options.context,
      negotiationContext: {
        phase: this.state.phase,
        round: this.state.round,
        maxRounds: this.state.maxRounds,
        isMyTurn: this.state.currentTurn === agent.agent.name,
        myInterests: this.state.interests[agent.agent.name],
      },
    };
  }

  private buildInitializationPrompt(topic: string): string {
    return `
You are participating in a multi-party negotiation.

Topic: ${topic}

This is the initialization phase. Your task is to:
1. Understand the negotiation topic
2. Use the 'declare_interests' tool to formally declare your interests and redlines
3. Consider what terms are most important to you and what you're willing to negotiate on

Use the available negotiation tools to declare your position. Be strategic but transparent about your priorities.
`.trim();
  }

  private buildProposalPrompt(topic: string): string {
    return `
You are in the PROPOSAL phase of the negotiation.

Topic: ${topic}
Round: ${this.state.round} of ${this.state.maxRounds}

Your task is to:
1. Review the current negotiation status using 'get_negotiation_status'
2. Check any pending offers using 'get_current_offers'
3. Make a proposal using 'make_offer' tool with structured terms

Consider your declared interests and the interests of other parties. Make a reasonable proposal that advances the negotiation.
`.trim();
  }

  private buildCounterPrompt(topic: string): string {
    return `
You are in the COUNTER phase of the negotiation.

Topic: ${topic}
Round: ${this.state.round} of ${this.state.maxRounds}

Your task is to:
1. Review offers directed to you using 'get_current_offers'
2. For each offer, decide whether to:
   - Accept it using 'accept_offer' (if terms are acceptable)
   - Counter it using 'counter_offer' (if you want to negotiate)
   - Reject it using 'reject_offer' (if terms are unacceptable)

Consider carefully which terms you can accept and which need modification. A counter-offer should move toward agreement while protecting your interests.
`.trim();
  }

  private buildRefinementPrompt(
    topic: string,
    suggestion: MediationSuggestion,
    mediationOfferId: string
  ): string {
    const termsDescription = suggestion.suggestedTerms
      .map((t) => `  - ${t.label}: ${JSON.stringify(t.value)}`)
      .join('\n');

    return `
You are in the REFINEMENT phase of the negotiation.

Topic: ${topic}
Round: ${this.state.round} of ${this.state.maxRounds}

The negotiation has been stagnating. A mediation suggestion has been proposed:

Type: ${suggestion.type}
Description: ${suggestion.description}

Suggested terms:
${termsDescription}

Rationale: ${suggestion.rationale}

The compromise has been submitted as offer "${mediationOfferId}". You may:
1. Accept it using 'accept_offer' with offerId "${mediationOfferId}" if acceptable
2. Make a counter-proposal using 'counter_offer' (inResponseTo "${mediationOfferId}") with minor modifications
3. Reject it using 'reject_offer' and explain why

Agreement is reached when every party accepts the compromise.

The goal is to break the deadlock and move toward agreement.
`.trim();
  }

  private buildSupervisorDecisionPrompt(topic: string): string {
    const offersSummary = this.state.offers
      .filter((o) => o.status === 'pending' || o.status === 'countered')
      .map(
        (o) =>
          `${o.from}: ${o.terms.map((t) => `${t.label}=${JSON.stringify(t.value)}`).join(', ')}`
      )
      .join('\n');

    return `
As the supervisor, the negotiation has reached a deadlock after ${this.state.round} rounds.

Topic: ${topic}

Current positions:
${offersSummary}

Please make a final decision on the terms. Consider the interests of all parties and propose a fair resolution.
`.trim();
  }
}
