import { nanoid } from 'nanoid';
import type {
  SwarmRunOptions,
  StrategyResult,
  NegotiationConfig,
  NegotiationState,
  NegotiationOffer,
  NegotiationAgreement,
  NegotiationResult,
  RunResult,
  ArbitrationResult,
  MediationSuggestion,
  SwarmAgent,
} from '@cogitator-ai/types';
import { DEFAULT_NEGOTIATION_CONFIG } from '@cogitator-ai/types';
import { BaseStrategy } from './base';
import type { SwarmCoordinator } from '../coordinator';
import { TurnManager } from './negotiation/turn-manager';
import { ConvergenceCalculator } from './negotiation/convergence';
import { ApprovalIntegration } from './negotiation/approval';

export class NegotiationStrategy extends BaseStrategy {
  private config: NegotiationConfig;
  private state!: NegotiationState;
  private turnManager!: TurnManager;
  private convergenceCalculator!: ConvergenceCalculator;
  private approvalIntegration?: ApprovalIntegration;

  constructor(coordinator: SwarmCoordinator, config: Partial<NegotiationConfig> = {}) {
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

    const agentNames = negotiatingAgents.map((a) => a.agent.name);

    this.initializeState(negotiationId, agentNames);
    this.initializeHelpers(agentNames, negotiationId);

    this.coordinator.events.emit(
      'negotiation:start',
      {
        negotiationId,
        agents: agentNames,
        config: this.config,
      },
      'system'
    );

    await this.runInitializationPhase(options, negotiatingAgents, agentResults);

    for (let round = 1; round <= this.config.maxRounds; round++) {
      this.state.round = round;
      this.turnManager.setRound(round);

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
      this.state.convergenceHistory.push(metrics);

      this.coordinator.events.emit('negotiation:convergence-update', { metrics, round }, 'system');

      if (this.convergenceCalculator.isStagnant()) {
        this.coordinator.events.emit(
          'negotiation:stagnation-detected',
          { round, metrics },
          'system'
        );

        const mediationSuggestion = this.convergenceCalculator.suggestCompromise(this.state.offers);

        if (mediationSuggestion) {
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
        }
      }

      if (this.isDeadlocked()) {
        return this.handleDeadlock(options, agents, agentResults);
      }
    }

    return this.handleDeadlock(options, agents, agentResults);
  }

  private initializeState(negotiationId: string, _agentNames: string[]): void {
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

    this.coordinator.blackboard.write('negotiation', this.state, 'system');
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

    if (this.config.approvalGates && this.config.approvalGates.length > 0) {
      this.approvalIntegration = new ApprovalIntegration({
        gates: this.config.approvalGates,
        negotiationId,
      });
    }
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
      const result = await this.coordinator.runAgent(
        agent.agent.name,
        initPrompt,
        this.buildAgentContext(agent, options)
      );
      results.set(`${agent.agent.name}_init`, result);

      this.state.turnHistory.push({
        agent: agent.agent.name,
        round: 0,
        action: 'declared_interests',
        timestamp: Date.now(),
      });
    }

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
      this.state.currentTurn = agent.agent.name;
      this.turnManager.startTurn();
      this.updateBlackboard();

      this.coordinator.events.emit(
        'negotiation:turn',
        { agent: agent.agent.name, round: this.state.round, phase: 'proposal' },
        agent.agent.name
      );

      const result = await this.coordinator.runAgent(
        agent.agent.name,
        proposalPrompt,
        this.buildAgentContext(agent, options)
      );
      results.set(`${agent.agent.name}_proposal_r${this.state.round}`, result);

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
      const offersToAgent = pendingOffers.filter((o) => {
        const recipients = Array.isArray(o.to) ? o.to : [o.to];
        return recipients.includes(agent.agent.name);
      });

      if (offersToAgent.length === 0) continue;

      this.state.currentTurn = agent.agent.name;
      this.turnManager.startTurn();
      this.updateBlackboard();

      this.coordinator.events.emit(
        'negotiation:turn',
        { agent: agent.agent.name, round: this.state.round, phase: 'counter' },
        agent.agent.name
      );

      const result = await this.coordinator.runAgent(
        agent.agent.name,
        counterPrompt,
        this.buildAgentContext(agent, options)
      );
      results.set(`${agent.agent.name}_counter_r${this.state.round}`, result);

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
    this.updateBlackboard();

    this.coordinator.events.emit(
      'negotiation:phase-change',
      { phase: 'refinement', round: this.state.round },
      'system'
    );

    const refinementPrompt = this.buildRefinementPrompt(options.input, suggestion);

    for (const agent of agents) {
      this.state.currentTurn = agent.agent.name;
      this.updateBlackboard();

      const result = await this.coordinator.runAgent(
        agent.agent.name,
        refinementPrompt,
        this.buildAgentContext(agent, options)
      );
      results.set(`${agent.agent.name}_refinement_r${this.state.round}`, result);
    }

    this.state.currentTurn = null;
    this.state.lastActivityAt = Date.now();
    this.updateBlackboard();
  }

  private async checkForAgreement(): Promise<boolean> {
    const currentState = this.coordinator.blackboard.read<NegotiationState>('negotiation');
    if (!currentState) return false;

    this.state = currentState;

    const acceptedOffers = this.state.offers.filter((o) => o.status === 'accepted');

    if (acceptedOffers.length === 0) return false;

    const latestAccepted = acceptedOffers.sort((a, b) => b.timestamp - a.timestamp)[0];

    const allPartiesAccepted = this.checkAllPartiesAccepted(latestAccepted);
    if (!allPartiesAccepted) return false;

    const agreement = this.buildAgreement(latestAccepted);
    this.state.agreement = agreement;

    if (this.approvalIntegration) {
      const gate = this.approvalIntegration.shouldTriggerApproval('agreement-reached', this.state, {
        agreement,
      });

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
          this.state.agreement = undefined;
          if (response.continueNegotiation) {
            return false;
          }
          return false;
        }

        agreement.approvalStatus = 'approved';
        agreement.approvalResponse = {
          approvedBy: response.respondedBy,
          approvedAt: response.respondedAt,
          comment: response.comment,
        };
      }
    }

    this.coordinator.events.emit('negotiation:agreement-reached', { agreement }, 'system');

    return true;
  }

  private checkAllPartiesAccepted(offer: NegotiationOffer): boolean {
    const recipients = Array.isArray(offer.to) ? offer.to : [offer.to];
    return recipients.every((recipient) => {
      const acceptance = this.state.offers.find(
        (o) => o.from === recipient && o.inResponseTo === offer.id && o.status === 'accepted'
      );
      return !!acceptance || offer.status === 'accepted';
    });
  }

  private buildAgreement(offer: NegotiationOffer): NegotiationAgreement {
    const recipients = Array.isArray(offer.to) ? offer.to : [offer.to];
    const parties = [offer.from, ...recipients];

    const relatedOfferIds = [offer.id];
    let current = offer;
    while (current.inResponseTo) {
      relatedOfferIds.push(current.inResponseTo);
      const parent = this.state.offers.find((o) => o.id === current.inResponseTo);
      if (!parent) break;
      current = parent;
    }

    return {
      id: `agreement_${nanoid(12)}`,
      parties,
      terms: offer.terms,
      reachedVia: 'consensus',
      timestamp: Date.now(),
      sourceOffers: relatedOfferIds,
      requiresApproval: !!this.approvalIntegration,
    };
  }

  private isDeadlocked(): boolean {
    const latestMetrics = this.state.convergenceHistory[this.state.convergenceHistory.length - 1];
    if (!latestMetrics) return false;

    if (latestMetrics.roundsWithoutProgress >= (this.config.maxRoundsWithoutProgress ?? 3)) {
      return true;
    }

    if (latestMetrics.convergenceTrend === 'declining' && latestMetrics.overallConvergence < 0.2) {
      return true;
    }

    return false;
  }

  private async handleDeadlock(
    options: SwarmRunOptions,
    agents: SwarmAgent[],
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
        return this.escalate(options, agents, results);

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

  private async escalate(
    _options: SwarmRunOptions,
    _agents: SwarmAgent[],
    results: Map<string, RunResult>
  ): Promise<StrategyResult> {
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
          const escalationOffer: NegotiationOffer = {
            id: `escalation_${nanoid(8)}`,
            from: 'escalation_authority',
            to: Object.keys(this.state.interests),
            terms: response.suggestedModifications,
            reasoning: 'Terms proposed by escalation authority after deadlock',
            timestamp: Date.now(),
            status: 'pending',
            round: this.state.round + 1,
            phase: 'escalation',
          };

          this.state.offers.push(escalationOffer);
          this.updateBlackboard();
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
    for (const offer of this.state.offers) {
      if (offer.status === 'pending' || offer.status === 'accepted') {
        latestOffers.set(offer.from, offer);
      }
    }

    const termVotes = new Map<string, Map<string, number>>();

    for (const offer of latestOffers.values()) {
      for (const term of offer.terms) {
        if (!termVotes.has(term.termId)) {
          termVotes.set(term.termId, new Map());
        }
        const valueVotes = termVotes.get(term.termId)!;
        const valueKey = JSON.stringify(term.value);
        valueVotes.set(valueKey, (valueVotes.get(valueKey) ?? 0) + 1);
      }
    }

    const majorityTerms = [];
    for (const [termId, votes] of termVotes) {
      let maxVotes = 0;
      let winningValue: unknown;
      for (const [valueKey, count] of votes) {
        if (count > maxVotes) {
          maxVotes = count;
          winningValue = JSON.parse(valueKey);
        }
      }

      const sampleTerm = Array.from(latestOffers.values())
        .flatMap((o) => o.terms)
        .find((t) => t.termId === termId);

      if (sampleTerm) {
        majorityTerms.push({
          ...sampleTerm,
          value: winningValue,
        });
      }
    }

    const agreement: NegotiationAgreement = {
      id: `agreement_${nanoid(12)}`,
      parties: Array.from(latestOffers.keys()),
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

    const pendingOffers = this.state.offers.filter(
      (o) => o.status === 'pending' || o.status === 'countered'
    );

    if (pendingOffers.length === 0) {
      return this.finalizeResult(results, 'deadlock');
    }

    const arbitrationResult = this.performArbitration(pendingOffers);

    const agreement: NegotiationAgreement = {
      id: `agreement_${nanoid(12)}`,
      parties: Object.keys(this.state.interests),
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

    const arbitratedTerms = [];

    for (const termId of allTermIds) {
      const termValues = offers.flatMap((o) => o.terms).filter((t) => t.termId === termId);

      if (termValues.length === 0) continue;

      const numericValues = termValues.filter((t) => typeof t.value === 'number');
      if (numericValues.length > 0) {
        const totalWeight = numericValues.reduce((s, t) => s + t.priority, 0);
        const weightedAvg = numericValues.reduce(
          (s, t) => s + ((t.value as number) * t.priority) / totalWeight,
          0
        );

        arbitratedTerms.push({
          ...termValues[0],
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
      to: Object.keys(this.state.interests),
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
      { result: negotiationResult },
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

    for (const agentName of Object.keys(this.state.interests)) {
      const lastOffer = this.state.offers
        .filter((o) => o.from === agentName)
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      positions[agentName] = lastOffer;
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
    this.coordinator.blackboard.write('negotiation', this.state, 'system');
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

  private buildRefinementPrompt(topic: string, suggestion: MediationSuggestion): string {
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

Please consider this compromise proposal. You may:
1. Accept the suggested terms using 'accept_offer' if acceptable
2. Make a counter-proposal using 'counter_offer' with minor modifications
3. Reject and explain why using 'reject_offer'

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
