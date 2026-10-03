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

interface PendingApproval {
  /** Settle with an answer: announces it with `negotiation:approval-received` */
  answer: (response: NegotiationApprovalResponse) => void;
  /** Settle silently with the given response */
  resolve: (response: NegotiationApprovalResponse) => void;
  reject: (error: Error) => void;
}

export class ApprovalIntegration {
  private gates: NegotiationApprovalGate[];
  private store?: ApprovalStore;
  private negotiationId: string;
  private pendingApprovals = new Map<string, PendingApproval>();

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
      const termMatch = /^term:([\w-]+)(>=|<=|==|>|<)(-?\d+(?:\.\d+)?)$/.exec(condition);
      if (!termMatch) return false;

      const [, termId, op, valueStr] = termMatch;
      const threshold = parseFloat(valueStr);
      const terms = details?.offer?.terms ?? details?.agreement?.terms ?? [];
      const term = terms.find((t) => t.termId === termId);
      if (!term || typeof term.value !== 'number') return false;

      switch (op) {
        case '>':
          return term.value > threshold;
        case '<':
          return term.value < threshold;
        case '>=':
          return term.value >= threshold;
        case '<=':
          return term.value <= threshold;
        case '==':
          return term.value === threshold;
        default:
          return false;
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

    return new Promise((resolve, reject) => {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      let settled = false;

      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        unsubscribe?.();
        this.pendingApprovals.delete(requestId);
        return true;
      };

      const pending: PendingApproval = {
        answer: (response) => {
          if (!settle()) return;
          events.emit(
            'negotiation:approval-received',
            { requestId, response },
            response.respondedBy
          );
          resolve(response);
        },
        resolve: (response) => {
          if (settle()) resolve(response);
        },
        reject: (error) => {
          if (settle()) reject(error);
        },
      };
      this.pendingApprovals.set(requestId, pending);

      if (gate.timeout) {
        timeoutHandle = setTimeout(() => {
          const isApproved = gate.timeoutAction === 'approve';

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

          pending.resolve({
            requestId,
            decision: isApproved ? 'approved' : 'rejected',
            approved: isApproved,
            respondedBy: 'system',
            respondedAt: Date.now(),
            continueNegotiation: gate.timeoutAction !== 'reject',
          });
        }, gate.timeout);
      }

      if (this.store) {
        unsubscribe = this.store.onResponse(requestId, (response: ApprovalResponse) => {
          const isApproved = response.decision === 'approved' || response.decision === true;
          const answer = response as Partial<NegotiationApprovalResponse>;
          pending.answer({
            ...response,
            approved: isApproved,
            continueNegotiation: !isApproved || answer.continueNegotiation !== false,
            approvedTerms: answer.approvedTerms,
            rejectedTerms: answer.rejectedTerms,
            suggestedModifications: answer.suggestedModifications,
          });
        });
      }
    });
  }

  /**
   * Answer a pending request; with a store the answer is also recorded there.
   */
  submitResponse(requestId: string, response: NegotiationApprovalResponse): void {
    this.pendingApprovals.get(requestId)?.answer(response);

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

  /**
   * Settle every pending request as rejected, ending the negotiation.
   */
  cancelAll(): void {
    for (const [requestId, pending] of [...this.pendingApprovals]) {
      pending.resolve({
        requestId,
        decision: 'rejected',
        approved: false,
        respondedBy: 'system',
        respondedAt: Date.now(),
        continueNegotiation: false,
      });
    }
  }

  /**
   * Fail every pending request with `error`, so whatever awaits it stops.
   */
  abortAll(error: Error): void {
    for (const pending of [...this.pendingApprovals.values()]) {
      pending.reject(error);
    }
  }
}
