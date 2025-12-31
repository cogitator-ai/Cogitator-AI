import type { NegotiationTurnOrder, NegotiationOffer, TurnRecord } from '@cogitator-ai/types';

export interface TurnManagerConfig {
  agents: string[];
  turnOrder: NegotiationTurnOrder;
  weights?: Record<string, number>;
  turnTimeout?: number;
}

export class TurnManager {
  private agents: string[];
  private turnOrder: NegotiationTurnOrder;
  private weights: Record<string, number>;
  private turnTimeout: number;
  private currentIndex = 0;
  private round = 1;
  private turnHistory: TurnRecord[] = [];
  private turnStartTime?: number;

  constructor(config: TurnManagerConfig) {
    this.agents = [...config.agents];
    this.turnOrder = config.turnOrder;
    this.weights = config.weights ?? {};
    this.turnTimeout = config.turnTimeout ?? 30000;

    if (this.turnOrder === 'priority') {
      this.agents.sort((a, b) => (this.weights[b] ?? 1) - (this.weights[a] ?? 1));
    }
  }

  getCurrentAgent(): string | null {
    if (this.agents.length === 0) return null;
    return this.agents[this.currentIndex];
  }

  getCurrentRound(): number {
    return this.round;
  }

  advance(): string | null {
    if (this.agents.length === 0) return null;

    const currentAgent = this.getCurrentAgent();
    if (currentAgent) {
      this.turnHistory.push({
        agent: currentAgent,
        round: this.round,
        action: 'turn_complete',
        timestamp: Date.now(),
      });
    }

    this.currentIndex++;

    if (this.currentIndex >= this.agents.length) {
      this.currentIndex = 0;
      this.round++;
    }

    this.turnStartTime = Date.now();
    return this.getCurrentAgent();
  }

  reorderDynamic(pendingOffers: NegotiationOffer[]): void {
    if (this.turnOrder !== 'dynamic') return;

    const agentPendingCounts = new Map<string, number>();
    for (const agent of this.agents) {
      agentPendingCounts.set(agent, 0);
    }

    for (const offer of pendingOffers) {
      const recipients = Array.isArray(offer.to) ? offer.to : [offer.to];
      for (const recipient of recipients) {
        if (agentPendingCounts.has(recipient)) {
          agentPendingCounts.set(recipient, (agentPendingCounts.get(recipient) ?? 0) + 1);
        }
      }
    }

    const currentAgent = this.getCurrentAgent();

    this.agents.sort((a, b) => {
      const aCount = agentPendingCounts.get(a) ?? 0;
      const bCount = agentPendingCounts.get(b) ?? 0;
      return bCount - aCount;
    });

    if (currentAgent) {
      this.currentIndex = this.agents.indexOf(currentAgent);
      if (this.currentIndex === -1) this.currentIndex = 0;
    }
  }

  isTurnExpired(): boolean {
    if (!this.turnStartTime) return false;
    return Date.now() - this.turnStartTime > this.turnTimeout;
  }

  skipCurrentAgent(): string | null {
    const skipped = this.getCurrentAgent();
    if (skipped) {
      this.turnHistory.push({
        agent: skipped,
        round: this.round,
        action: 'turn_skipped',
        timestamp: Date.now(),
      });
    }
    return this.advance();
  }

  getTurnHistory(): TurnRecord[] {
    return [...this.turnHistory];
  }

  getAgentTurnCount(agentName: string): number {
    return this.turnHistory.filter((t) => t.agent === agentName && t.action === 'turn_complete')
      .length;
  }

  reset(): void {
    this.currentIndex = 0;
    this.round = 1;
    this.turnHistory = [];
    this.turnStartTime = undefined;
  }

  setRound(round: number): void {
    this.round = round;
  }

  startTurn(): void {
    this.turnStartTime = Date.now();
  }

  getRemainingTurnTime(): number {
    if (!this.turnStartTime) return this.turnTimeout;
    const elapsed = Date.now() - this.turnStartTime;
    return Math.max(0, this.turnTimeout - elapsed);
  }
}
