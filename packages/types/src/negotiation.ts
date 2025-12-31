import type { ApprovalRequest, ApprovalResponse } from './workflow';

export type NegotiationPhase =
  | 'initialization'
  | 'proposal'
  | 'counter'
  | 'refinement'
  | 'agreement'
  | 'deadlock'
  | 'escalation';

export type OfferStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'countered'
  | 'withdrawn'
  | 'expired';

export type NegotiationTurnOrder = 'round-robin' | 'priority' | 'dynamic';

export type NegotiationDeadlockAction =
  | 'escalate'
  | 'supervisor-decides'
  | 'majority-rules'
  | 'arbitrate'
  | 'fail';

export type ApprovalTrigger =
  | 'agreement-reached'
  | 'high-value-term'
  | 'coalition-formed'
  | 'deadlock';

export type ApprovalTimeoutAction = 'approve' | 'reject' | 'escalate';

export interface NegotiationTerm {
  termId: string;
  label: string;
  value: unknown;
  negotiable: boolean;
  priority: number;
  range?: { min: number; max: number };
}

export interface NegotiationOffer {
  id: string;
  from: string;
  to: string | string[];
  terms: NegotiationTerm[];
  reasoning: string;
  inResponseTo?: string;
  timestamp: number;
  status: OfferStatus;
  expiresAt?: number;
  round: number;
  phase: NegotiationPhase;
  coalition?: string[];
}

export interface NegotiationAgreement {
  id: string;
  parties: string[];
  terms: NegotiationTerm[];
  reachedVia: 'consensus' | 'compromise' | 'majority' | 'supervisor' | 'approval' | 'arbitration';
  timestamp: number;
  sourceOffers: string[];
  requiresApproval: boolean;
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  approvalResponse?: {
    approvedBy: string;
    approvedAt: number;
    comment?: string;
  };
}

export interface Coalition {
  id: string;
  name: string;
  members: string[];
  sharedInterests: string[];
  createdAt: number;
  createdBy: string;
  combinedWeight: number;
  status: 'forming' | 'active' | 'dissolved';
}

export interface NegotiationApprovalGate {
  trigger: ApprovalTrigger;
  condition?: string;
  assignee?: string;
  timeout?: number;
  timeoutAction?: ApprovalTimeoutAction;
}

export interface NegotiationConfig {
  maxRounds: number;
  maxOffersPerRound?: number;
  offerTimeout?: number;
  turnTimeout?: number;
  onDeadlock: NegotiationDeadlockAction;
  allowCoalitions?: boolean;
  minCoalitionSize?: number;
  approvalGates?: NegotiationApprovalGate[];
  turnOrder?: NegotiationTurnOrder;
  quorum?: number;
  weights?: Record<string, number>;
  stagnationThreshold?: number;
  maxRoundsWithoutProgress?: number;
}

export interface AgentInterest {
  declared: NegotiationTerm[];
  redlines: string[];
}

export interface TurnRecord {
  agent: string;
  round: number;
  action: string;
  timestamp: number;
}

export interface NegotiationState {
  negotiationId: string;
  phase: NegotiationPhase;
  round: number;
  maxRounds: number;
  offers: NegotiationOffer[];
  coalitions: Coalition[];
  interests: Record<string, AgentInterest>;
  currentTurn: string | null;
  turnHistory: TurnRecord[];
  agreement?: NegotiationAgreement;
  pendingApprovals: string[];
  convergenceHistory: ConvergenceMetrics[];
  startedAt: number;
  lastActivityAt: number;
}

export interface ConvergenceMetrics {
  round: number;
  overallConvergence: number;
  termConvergence: Record<string, number>;
  positionDrift: number;
  acceptanceRate: number;
  roundsWithoutProgress: number;
  convergenceTrend: 'improving' | 'stable' | 'declining';
  estimatedRoundsToConvergence?: number;
  timestamp: number;
}

export interface MediationSuggestion {
  type: 'term_compromise' | 'package_deal' | 'split_difference' | 'trade_off';
  description: string;
  suggestedTerms: NegotiationTerm[];
  rationale: string;
  expectedImpact: Array<{
    agent: string;
    gain: number;
    sacrifice: number;
  }>;
}

export interface ArbitrationResult {
  method:
    | 'weighted_average'
    | 'majority_position'
    | 'last_best_offer'
    | 'mediator_decision'
    | 'random_selection';
  proposal: NegotiationOffer;
  binding: boolean;
  reasoning: string;
}

export interface NegotiationApprovalRequest extends ApprovalRequest {
  negotiationId: string;
  proposalId?: string;
  proposalSnapshot?: NegotiationOffer;
  agreementSnapshot?: NegotiationAgreement;
  partiesInvolved: string[];
  convergenceAtRequest: number;
  triggeredBy: ApprovalTrigger;
}

export interface NegotiationApprovalResponse extends ApprovalResponse {
  approved: boolean;
  approvedTerms?: string[];
  rejectedTerms?: string[];
  suggestedModifications?: NegotiationTerm[];
  continueNegotiation: boolean;
}

export type NegotiationEventType =
  | 'negotiation:start'
  | 'negotiation:phase-change'
  | 'negotiation:round'
  | 'negotiation:turn'
  | 'negotiation:offer-made'
  | 'negotiation:offer-accepted'
  | 'negotiation:offer-rejected'
  | 'negotiation:offer-countered'
  | 'negotiation:offer-expired'
  | 'negotiation:coalition-proposed'
  | 'negotiation:coalition-formed'
  | 'negotiation:coalition-dissolved'
  | 'negotiation:convergence-update'
  | 'negotiation:stagnation-detected'
  | 'negotiation:mediation-suggested'
  | 'negotiation:approval-required'
  | 'negotiation:approval-received'
  | 'negotiation:agreement-reached'
  | 'negotiation:deadlock'
  | 'negotiation:escalation'
  | 'negotiation:arbitration'
  | 'negotiation:terminated';

export interface NegotiationResult {
  negotiationId: string;
  outcome: 'agreement' | 'deadlock' | 'escalated' | 'arbitrated' | 'terminated';
  agreement?: NegotiationAgreement;
  offers: NegotiationOffer[];
  coalitions: Coalition[];
  finalPositions: Record<string, NegotiationOffer | undefined>;
  convergenceHistory: ConvergenceMetrics[];
  rounds: number;
  duration: number;
}

export const DEFAULT_NEGOTIATION_CONFIG: NegotiationConfig = {
  maxRounds: 10,
  maxOffersPerRound: 3,
  offerTimeout: 60000,
  turnTimeout: 30000,
  onDeadlock: 'escalate',
  allowCoalitions: true,
  minCoalitionSize: 2,
  turnOrder: 'round-robin',
  quorum: 0.5,
  stagnationThreshold: 0.05,
  maxRoundsWithoutProgress: 3,
};
