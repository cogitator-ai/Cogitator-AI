import type { Blackboard, NegotiationOffer, NegotiationState } from '@cogitator-ai/types';

export const NEGOTIATION_SECTION = 'negotiation';
export const NEGOTIATION_RULES_SECTION = 'negotiation-rules';

/** Sender id used for compromise offers proposed by the strategy's mediator */
export const MEDIATOR_ID = 'mediator';

/**
 * Negotiation rules published by the strategy and enforced by the negotiation tools.
 */
export interface NegotiationRules {
  maxOffersPerRound?: number;
  offerTimeout?: number;
  allowCoalitions: boolean;
  minCoalitionSize: number;
}

export function readNegotiationState(blackboard: Blackboard): NegotiationState | null {
  if (!blackboard.has(NEGOTIATION_SECTION)) return null;
  try {
    return blackboard.read<NegotiationState>(NEGOTIATION_SECTION);
  } catch {
    return null;
  }
}

export function readNegotiationRules(blackboard: Blackboard): NegotiationRules | null {
  if (!blackboard.has(NEGOTIATION_RULES_SECTION)) return null;
  try {
    return blackboard.read<NegotiationRules>(NEGOTIATION_RULES_SECTION);
  } catch {
    return null;
  }
}

export function offerRecipients(offer: NegotiationOffer): string[] {
  return Array.isArray(offer.to) ? offer.to : [offer.to];
}

export function offerParties(offer: NegotiationOffer): string[] {
  const recipients = offerRecipients(offer);
  return offer.from === MEDIATOR_ID ? recipients : [offer.from, ...recipients];
}

export function acceptanceAction(offerId: string): string {
  return `accepted:${offerId}`;
}

/**
 * Agents that accepted the offer, recorded in the turn history by `accept_offer`.
 */
export function getOfferAcceptances(state: NegotiationState, offerId: string): string[] {
  const action = acceptanceAction(offerId);
  return Array.from(
    new Set(state.turnHistory.filter((t) => t.action === action).map((t) => t.agent))
  );
}

export function isFullyAccepted(state: NegotiationState, offer: NegotiationOffer): boolean {
  const accepted = new Set(getOfferAcceptances(state, offer.id));
  return offerRecipients(offer).every((recipient) => accepted.has(recipient));
}

export function isOfferExpired(offer: NegotiationOffer, now = Date.now()): boolean {
  return offer.expiresAt !== undefined && now > offer.expiresAt;
}

export function replaceOffer(
  state: NegotiationState,
  offerId: string,
  update: Partial<NegotiationOffer>
): NegotiationState {
  return {
    ...state,
    offers: state.offers.map((o) => (o.id === offerId ? { ...o, ...update } : o)),
  };
}
