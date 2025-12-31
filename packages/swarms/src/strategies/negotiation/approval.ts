import { nanoid } from 'nanoid';
import type {
  ApprovalStore,
  ApprovalResponse,
  NegotiationApprovalGate,
  NegotiationApprovalRequest,
  NegotiationApprovalResponse,
  NegotiationState,
  NegotiationOffer,
  NegotiationAgreement,
  ApprovalTrigger,
  SwarmEventEmitter,
} from '@cogitator-ai/types';

export interface ApprovalIntegrationConfig {
  gates: NegotiationApprovalGate[];
  store?: ApprovalStore;
  negotiationId: string;
}

export class ApprovalIntegration {
  private gates: NegotiationApprovalGate[];
  private store?: ApprovalStore;
  private negotiationId: string;
  private pendingApprovals = new Map<
    string,
    { resolve: (r: NegotiationApprovalResponse) => void; timeout?: ReturnType<typeof setTimeout> }
  >();

  constructor(config: ApprovalIntegrationConfig) {
    this.gates = config.gates;
    this.store = config.store;
    this.negotiationId = config.negotiationId;
  }

  shouldTriggerApproval(
    trigger: ApprovalTrigger,
    state: NegotiationState,
    details?: { offer?: NegotiationOffer; agreement?: NegotiationAgreement }
  ): NegotiationApprovalGate | null {
    for (const gate of this.gates) {
      if (gate.trigger !== trigger) continue;

      if (gate.condition) {
        if (!this.evaluateCondition(gate.condition, state, details)) continue;
      }

      return gate;
    }
    return null;
  }

  private evaluateCondition(
    condition: string,
    state: NegotiationState,
    details?: { offer?: NegotiationOffer; agreement?: NegotiationAgreement }
  ): boolean {
    if (condition === 'always') return true;

    if (condition.startsWith('convergence>')) {
      const threshold = parseFloat(condition.replace('convergence>', ''));
      const latest = state.convergenceHistory[state.convergenceHistory.length - 1];
      return latest ? latest.overallConvergence > threshold : false;
    }

    if (condition.startsWith('round>')) {
      const threshold = parseInt(condition.replace('round>', ''), 10);
      return state.round > threshold;
    }

    if (condition.startsWith('parties>')) {
      const threshold = parseInt(condition.replace('parties>', ''), 10);
      const parties = details?.offer
        ? new Set([
            details.offer.from,
            ...(Array.isArray(details.offer.to) ? details.offer.to : [details.offer.to]),
          ])
        : new Set(details?.agreement?.parties ?? []);
      return parties.size > threshold;
    }

    if (condition.startsWith('term:')) {
      const termMatch = condition.match(/term:(\w+)(>|<|>=|<=|==)(\d+)/);
      if (termMatch) {
        const [, termId, op, valueStr] = termMatch;
        const value = parseFloat(valueStr);
        const term = details?.offer?.terms.find((t) => t.termId === termId);
        if (term && typeof term.value === 'number') {
          switch (op) {
            case '>':
              return term.value > value;
            case '<':
              return term.value < value;
            case '>=':
              return term.value >= value;
            case '<=':
              return term.value <= value;
            case '==':
              return term.value === value;
          }
        }
      }
    }

    return true;
  }

  async requestApproval(
    gate: NegotiationApprovalGate,
    state: NegotiationState,
    events: SwarmEventEmitter,
    details?: { offer?: NegotiationOffer; agreement?: NegotiationAgreement }
  ): Promise<NegotiationApprovalResponse> {
    const requestId = `approval_${nanoid(12)}`;

    const request: NegotiationApprovalRequest = {
      id: requestId,
      workflowId: this.negotiationId,
      runId: `run_${nanoid(8)}`,
      nodeId: `negotiation_${gate.trigger}`,
      type: 'approve-reject',
      title: `Negotiation Approval: ${gate.trigger}`,
      description: this.buildDescription(gate.trigger, state, details),
      createdAt: Date.now(),
      assignee: gate.assignee,
      metadata: {
        trigger: gate.trigger,
        round: state.round,
        phase: state.phase,
      },
      negotiationId: this.negotiationId,
      proposalId: details?.offer?.id,
      proposalSnapshot: details?.offer,
      agreementSnapshot: details?.agreement,
      partiesInvolved: this.getPartiesInvolved(state, details),
      convergenceAtRequest:
        state.convergenceHistory[state.convergenceHistory.length - 1]?.overallConvergence ?? 0,
      triggeredBy: gate.trigger,
    };

    if (this.store) {
      await this.store.createRequest(request);
    }

    events.emit('negotiation:approval-required', { request, gate }, 'system');

    return new Promise((resolve) => {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      if (gate.timeout) {
        timeoutHandle = setTimeout(() => {
          this.pendingApprovals.delete(requestId);

          const isApproved = gate.timeoutAction === 'approve';
          const timeoutResponse: NegotiationApprovalResponse = {
            requestId,
            decision: isApproved ? 'approved' : 'rejected',
            approved: isApproved,
            respondedBy: 'system',
            respondedAt: Date.now(),
            continueNegotiation: gate.timeoutAction !== 'reject',
          };

          if (gate.timeoutAction === 'escalate') {
            events.emit(
              'negotiation:escalation',
              {
                reason: 'approval_timeout',
                request,
              },
              'system'
            );
          }

          resolve(timeoutResponse);
        }, gate.timeout);
      }

      this.pendingApprovals.set(requestId, { resolve, timeout: timeoutHandle });

      if (this.store) {
        this.store.onResponse(requestId, (response: ApprovalResponse) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          this.pendingApprovals.delete(requestId);

          const isApproved = response.decision === 'approved' || response.decision === true;
          const negotiationResponse: NegotiationApprovalResponse = {
            ...response,
            approved: isApproved,
            continueNegotiation:
              !isApproved ||
              (response as NegotiationApprovalResponse).continueNegotiation !== false,
            approvedTerms: (response as NegotiationApprovalResponse).approvedTerms,
            rejectedTerms: (response as NegotiationApprovalResponse).rejectedTerms,
            suggestedModifications: (response as NegotiationApprovalResponse)
              .suggestedModifications,
          };

          events.emit(
            'negotiation:approval-received',
            {
              requestId,
              response: negotiationResponse,
            },
            response.respondedBy
          );

          resolve(negotiationResponse);
        });
      }
    });
  }

  submitResponse(requestId: string, response: NegotiationApprovalResponse): void {
    const pending = this.pendingApprovals.get(requestId);
    if (pending) {
      if (pending.timeout) clearTimeout(pending.timeout);
      this.pendingApprovals.delete(requestId);
      pending.resolve(response);
    }

    if (this.store) {
      void this.store.submitResponse(response);
    }
  }

  private buildDescription(
    trigger: ApprovalTrigger,
    state: NegotiationState,
    details?: { offer?: NegotiationOffer; agreement?: NegotiationAgreement }
  ): string {
    switch (trigger) {
      case 'agreement-reached':
        return (
          `An agreement has been reached in round ${state.round}. ` +
          `Parties: ${details?.agreement?.parties.join(', ')}. ` +
          `Terms: ${details?.agreement?.terms.map((t) => `${t.label}: ${t.value}`).join(', ')}`
        );

      case 'high-value-term':
        return (
          `High-value term detected in offer from ${details?.offer?.from}. ` +
          `Review the proposed terms for approval.`
        );

      case 'coalition-formed':
        return `A coalition has been formed. Review the coalition terms and membership.`;

      case 'deadlock':
        return (
          `Negotiation has reached a deadlock after ${state.round} rounds. ` +
          `Please decide how to proceed.`
        );

      default:
        return `Approval required for negotiation ${this.negotiationId}.`;
    }
  }

  private getPartiesInvolved(
    state: NegotiationState,
    details?: { offer?: NegotiationOffer; agreement?: NegotiationAgreement }
  ): string[] {
    if (details?.agreement) return details.agreement.parties;
    if (details?.offer) {
      const to = Array.isArray(details.offer.to) ? details.offer.to : [details.offer.to];
      return [details.offer.from, ...to];
    }
    return Object.keys(state.interests);
  }

  getPendingCount(): number {
    return this.pendingApprovals.size;
  }

  cancelAll(): void {
    for (const [, pending] of this.pendingApprovals) {
      if (pending.timeout) clearTimeout(pending.timeout);
    }
    this.pendingApprovals.clear();
  }
}
