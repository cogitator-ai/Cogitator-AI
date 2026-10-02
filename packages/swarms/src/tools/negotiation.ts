import { z } from 'zod';
import { nanoid } from 'nanoid';
import { tool } from '@cogitator-ai/core';
import type {
  Blackboard,
  SwarmEventEmitter,
  NegotiationState,
  NegotiationOffer,
  NegotiationTerm,
  OfferStatus,
  Coalition,
  NegotiationPhase,
} from '@cogitator-ai/types';
import {
  MEDIATOR_ID,
  NEGOTIATION_SECTION,
  acceptanceAction,
  getOfferAcceptances,
  isFullyAccepted,
  isOfferExpired,
  offerRecipients,
  readNegotiationRules,
  readNegotiationState,
  replaceOffer,
} from '../shared/negotiation.js';

const NegotiationTermSchema = z.object({
  termId: z.string().describe('Unique identifier for this term'),
  label: z.string().describe('Human-readable label for the term'),
  value: z
    .union([z.string(), z.number(), z.boolean()])
    .describe('The proposed value for this term (string, number or boolean)'),
  negotiable: z.boolean().describe('Whether this term is open for negotiation'),
  priority: z.number().min(1).max(10).describe('Priority 1-10, higher = more important'),
  range: z
    .object({
      min: z.number(),
      max: z.number(),
    })
    .optional()
    .describe('Acceptable range for numeric terms'),
});

function generateId(): string {
  return `offer_${nanoid(12)}`;
}

function getNegotiationState(blackboard: Blackboard): NegotiationState | null {
  return readNegotiationState(blackboard);
}

function writeNegotiationState(
  blackboard: Blackboard,
  state: NegotiationState,
  agent: string
): void {
  blackboard.write(NEGOTIATION_SECTION, { ...state, lastActivityAt: Date.now() }, agent);
}

function offersThisRound(state: NegotiationState, agent: string): number {
  return state.offers.filter((o) => o.from === agent && o.round === state.round).length;
}

export function createNegotiationTools(
  blackboard: Blackboard,
  events: SwarmEventEmitter,
  currentAgent: string,
  agentWeight = 1
) {
  const checkTurn = (state: NegotiationState): string | null =>
    state.currentTurn !== null && state.currentTurn !== currentAgent
      ? `Not your turn. Current turn: ${state.currentTurn}`
      : null;

  const checkOfferQuota = (state: NegotiationState): string | null => {
    const max = readNegotiationRules(blackboard)?.maxOffersPerRound;
    if (max !== undefined && offersThisRound(state, currentAgent) >= max) {
      return `Offer limit reached: at most ${max} offers per round`;
    }
    return null;
  };

  const defaultExpiry = (): number | undefined => {
    const timeout = readNegotiationRules(blackboard)?.offerTimeout;
    return timeout !== undefined && timeout > 0 ? Date.now() + timeout : undefined;
  };

  const findRespondableOffer = (
    state: NegotiationState,
    offerId: string
  ): { offer: NegotiationOffer } | { error: string } => {
    const offer = state.offers.find((o) => o.id === offerId);
    if (!offer) return { error: `Offer not found: ${offerId}` };
    if (offer.status !== 'pending') {
      return { error: `Offer is not pending (status: ${offer.status})` };
    }
    if (isOfferExpired(offer)) return { error: 'Offer has expired' };
    if (!offerRecipients(offer).includes(currentAgent)) {
      return { error: 'This offer was not made to you' };
    }
    return { offer };
  };

  const makeOffer = tool({
    name: 'make_offer',
    description:
      'Make a structured offer with specific terms. Use this to propose new terms or initial offers.',
    parameters: z.object({
      to: z
        .union([z.string(), z.array(z.string())])
        .describe('Recipient agent(s) - single name or array for multi-party offers'),
      terms: z.array(NegotiationTermSchema).min(1).describe('Array of negotiation terms'),
      reasoning: z.string().describe('Explanation of why you are proposing these terms'),
      expiresInMs: z
        .number()
        .optional()
        .describe('Optional expiration time in milliseconds from now'),
    }),
    execute: async ({ to, terms, reasoning, expiresInMs }) => {
      const state = getNegotiationState(blackboard);
      if (!state) {
        return { success: false, error: 'No active negotiation session' };
      }

      const refusal = checkTurn(state) ?? checkOfferQuota(state);
      if (refusal) {
        return { success: false, error: refusal };
      }

      const recipients = Array.isArray(to) ? to : [to];
      if (recipients.length === 0 || recipients.includes(currentAgent)) {
        return { success: false, error: 'Offers must be addressed to other agents' };
      }

      const offer: NegotiationOffer = {
        id: generateId(),
        from: currentAgent,
        to,
        terms: terms as NegotiationTerm[],
        reasoning,
        timestamp: Date.now(),
        status: 'pending' as OfferStatus,
        expiresAt: expiresInMs ? Date.now() + expiresInMs : defaultExpiry(),
        round: state.round,
        phase: state.phase,
      };

      writeNegotiationState(
        blackboard,
        { ...state, offers: [...state.offers, offer] },
        currentAgent
      );

      events.emit('negotiation:offer-made', { offer, from: currentAgent }, currentAgent);

      return {
        success: true,
        offerId: offer.id,
        to,
        termsCount: terms.length,
        round: state.round,
      };
    },
  });

  const counterOffer = tool({
    name: 'counter_offer',
    description:
      'Make a counter-offer in response to a received offer. Modify specific terms while optionally accepting others.',
    parameters: z.object({
      inResponseTo: z.string().describe('ID of the offer you are responding to'),
      modifiedTerms: z
        .array(NegotiationTermSchema)
        .describe('Terms with your proposed modifications'),
      acceptedTermIds: z
        .array(z.string())
        .optional()
        .describe('IDs of terms you accept as-is from the original offer'),
      reasoning: z.string().describe('Explanation of your counter-proposal'),
    }),
    execute: async ({ inResponseTo, modifiedTerms, acceptedTermIds, reasoning }) => {
      const state = getNegotiationState(blackboard);
      if (!state) {
        return { success: false, error: 'No active negotiation session' };
      }

      const refusal = checkTurn(state) ?? checkOfferQuota(state);
      if (refusal) {
        return { success: false, error: refusal };
      }

      const lookup = findRespondableOffer(state, inResponseTo);
      if ('error' in lookup) {
        return { success: false, error: lookup.error };
      }
      const originalOffer = lookup.offer;

      const modifiedIds = new Set(modifiedTerms.map((t) => t.termId));
      const acceptedTerms = acceptedTermIds
        ? originalOffer.terms.filter(
            (t) => acceptedTermIds.includes(t.termId) && !modifiedIds.has(t.termId)
          )
        : [];

      const counterRecipients =
        originalOffer.from === MEDIATOR_ID
          ? offerRecipients(originalOffer).filter((r) => r !== currentAgent)
          : [originalOffer.from];

      const counterOfferDoc: NegotiationOffer = {
        id: generateId(),
        from: currentAgent,
        to: counterRecipients.length === 1 ? counterRecipients[0] : counterRecipients,
        terms: [...acceptedTerms, ...(modifiedTerms as NegotiationTerm[])],
        reasoning,
        inResponseTo,
        timestamp: Date.now(),
        status: 'pending',
        expiresAt: defaultExpiry(),
        round: state.round,
        phase: 'counter' as NegotiationPhase,
      };

      const updated = replaceOffer(state, inResponseTo, { status: 'countered' });
      writeNegotiationState(
        blackboard,
        { ...updated, offers: [...updated.offers, counterOfferDoc] },
        currentAgent
      );

      events.emit(
        'negotiation:offer-countered',
        {
          originalOfferId: inResponseTo,
          counterOffer: counterOfferDoc,
          from: currentAgent,
        },
        currentAgent
      );

      return {
        success: true,
        counterOfferId: counterOfferDoc.id,
        originalOfferId: inResponseTo,
        acceptedTerms: acceptedTerms.length,
        modifiedTerms: modifiedTerms.length,
        round: state.round,
      };
    },
  });

  const acceptOffer = tool({
    name: 'accept_offer',
    description: 'Accept an offer in full. This may lead to agreement if all parties accept.',
    parameters: z.object({
      offerId: z.string().describe('ID of the offer to accept'),
      comment: z.string().optional().describe('Optional comment on acceptance'),
    }),
    execute: async ({ offerId, comment }) => {
      const state = getNegotiationState(blackboard);
      if (!state) {
        return { success: false, error: 'No active negotiation session' };
      }

      const refusal = checkTurn(state);
      if (refusal) {
        return { success: false, error: refusal };
      }

      const lookup = findRespondableOffer(state, offerId);
      if ('error' in lookup) {
        return { success: false, error: lookup.error };
      }
      const offer = lookup.offer;

      if (getOfferAcceptances(state, offerId).includes(currentAgent)) {
        return { success: false, error: 'You have already accepted this offer' };
      }

      const withAcceptance: NegotiationState = {
        ...state,
        turnHistory: [
          ...state.turnHistory,
          {
            agent: currentAgent,
            round: state.round,
            action: acceptanceAction(offerId),
            timestamp: Date.now(),
          },
        ],
      };
      const fullyAccepted = isFullyAccepted(withAcceptance, offer);
      const updated = fullyAccepted
        ? replaceOffer(withAcceptance, offerId, { status: 'accepted' })
        : withAcceptance;

      writeNegotiationState(blackboard, updated, currentAgent);

      events.emit(
        'negotiation:offer-accepted',
        {
          offerId,
          acceptedBy: currentAgent,
          offer,
          comment,
          fullyAccepted,
        },
        currentAgent
      );

      const pendingRecipients = offerRecipients(offer).filter(
        (r) => !getOfferAcceptances(updated, offerId).includes(r)
      );

      return {
        success: true,
        offerId,
        acceptedTerms: offer.terms.map((t) => t.termId),
        from: offer.from,
        round: state.round,
        fullyAccepted,
        awaitingAcceptanceFrom: pendingRecipients,
      };
    },
  });

  const rejectOffer = tool({
    name: 'reject_offer',
    description: 'Reject an offer. Optionally indicate willingness to continue negotiating.',
    parameters: z.object({
      offerId: z.string().describe('ID of the offer to reject'),
      reason: z.string().describe('Reason for rejection'),
      openToCounter: z.boolean().describe('Whether you are open to receiving a counter-offer'),
      problematicTermIds: z
        .array(z.string())
        .optional()
        .describe('IDs of specific terms that are problematic'),
    }),
    execute: async ({ offerId, reason, openToCounter, problematicTermIds }) => {
      const state = getNegotiationState(blackboard);
      if (!state) {
        return { success: false, error: 'No active negotiation session' };
      }

      const refusal = checkTurn(state);
      if (refusal) {
        return { success: false, error: refusal };
      }

      const lookup = findRespondableOffer(state, offerId);
      if ('error' in lookup) {
        return { success: false, error: lookup.error };
      }

      writeNegotiationState(
        blackboard,
        replaceOffer(state, offerId, { status: 'rejected' }),
        currentAgent
      );

      events.emit(
        'negotiation:offer-rejected',
        {
          offerId,
          rejectedBy: currentAgent,
          reason,
          openToCounter,
          problematicTermIds,
        },
        currentAgent
      );

      return {
        success: true,
        offerId,
        rejectedTerms: problematicTermIds ?? [],
        openToCounter,
        round: state.round,
      };
    },
  });

  const getNegotiationStatus = tool({
    name: 'get_negotiation_status',
    description:
      'Get the current status of the negotiation including phase, round, and pending offers.',
    parameters: z.object({}),
    execute: async () => {
      const state = getNegotiationState(blackboard);
      if (!state) {
        return { active: false, error: 'No active negotiation session' };
      }

      const pendingOffers = state.offers.filter((o) => o.status === 'pending');
      const offersToMe = pendingOffers.filter((o) => {
        const recipients = Array.isArray(o.to) ? o.to : [o.to];
        return recipients.includes(currentAgent);
      });
      const myOffers = pendingOffers.filter((o) => o.from === currentAgent);

      return {
        active: true,
        negotiationId: state.negotiationId,
        phase: state.phase,
        round: state.round,
        maxRounds: state.maxRounds,
        roundsRemaining: state.maxRounds - state.round,
        isMyTurn: state.currentTurn === currentAgent || state.currentTurn === null,
        currentTurn: state.currentTurn,
        pendingOffersCount: pendingOffers.length,
        offersToMeCount: offersToMe.length,
        myPendingOffersCount: myOffers.length,
        coalitionsCount: state.coalitions.length,
        hasAgreement: !!state.agreement,
        pendingApprovalsCount: state.pendingApprovals.length,
      };
    },
  });

  const getCurrentOffers = tool({
    name: 'get_current_offers',
    description: 'Get all offers that require your response or are currently pending.',
    parameters: z.object({
      includeAll: z
        .boolean()
        .optional()
        .describe('Include all pending offers, not just those directed to you'),
      includeHistory: z
        .boolean()
        .optional()
        .describe('Include resolved offers (accepted/rejected/countered)'),
    }),
    execute: async ({ includeAll = false, includeHistory = false }) => {
      const state = getNegotiationState(blackboard);
      if (!state) {
        return { success: false, error: 'No active negotiation session', offers: [] };
      }

      let offers = state.offers;

      if (!includeHistory) {
        offers = offers.filter((o) => o.status === 'pending');
      }

      if (!includeAll) {
        offers = offers.filter((o) => {
          const recipients = Array.isArray(o.to) ? o.to : [o.to];
          return recipients.includes(currentAgent) || o.from === currentAgent;
        });
      }

      return {
        success: true,
        round: state.round,
        phase: state.phase,
        offers: offers.map((o) => ({
          id: o.id,
          from: o.from,
          to: o.to,
          status: o.status,
          round: o.round,
          phase: o.phase,
          reasoning: o.reasoning,
          inResponseTo: o.inResponseTo,
          terms: o.terms,
          expiresAt: o.expiresAt,
          isExpired: o.expiresAt ? Date.now() > o.expiresAt : false,
          requiresMyResponse:
            o.status === 'pending' && (Array.isArray(o.to) ? o.to : [o.to]).includes(currentAgent),
        })),
      };
    },
  });

  const proposeCoalition = tool({
    name: 'propose_coalition',
    description: 'Propose forming a coalition with other agents to negotiate as a unified group.',
    parameters: z.object({
      name: z.string().describe('Name for the coalition'),
      invitees: z.array(z.string()).min(1).describe('Agent names to invite to the coalition'),
      sharedInterests: z
        .array(z.string())
        .describe('List of shared interests that unite the coalition'),
      reasoning: z.string().describe('Why this coalition makes sense'),
    }),
    execute: async ({ name, invitees, sharedInterests, reasoning }) => {
      const state = getNegotiationState(blackboard);
      if (!state) {
        return { success: false, error: 'No active negotiation session' };
      }

      if (readNegotiationRules(blackboard)?.allowCoalitions === false) {
        return { success: false, error: 'Coalitions are not allowed in this negotiation' };
      }

      const coalition: Coalition = {
        id: generateId(),
        name,
        members: [currentAgent],
        sharedInterests,
        createdAt: Date.now(),
        createdBy: currentAgent,
        combinedWeight: agentWeight,
        status: 'forming',
      };

      writeNegotiationState(
        blackboard,
        { ...state, coalitions: [...state.coalitions, coalition] },
        currentAgent
      );

      events.emit(
        'negotiation:coalition-proposed',
        {
          coalition,
          invitees,
          reasoning,
          proposedBy: currentAgent,
        },
        currentAgent
      );

      return {
        success: true,
        coalitionId: coalition.id,
        name,
        invitees,
        initialMembers: [currentAgent],
      };
    },
  });

  const joinCoalition = tool({
    name: 'join_coalition',
    description: 'Accept an invitation to join a coalition.',
    parameters: z.object({
      coalitionId: z.string().describe('ID of the coalition to join'),
      additionalInterests: z
        .array(z.string())
        .optional()
        .describe('Additional shared interests you bring to the coalition'),
    }),
    execute: async ({ coalitionId, additionalInterests }) => {
      const state = getNegotiationState(blackboard);
      if (!state) {
        return { success: false, error: 'No active negotiation session' };
      }

      const coalition = state.coalitions.find((c) => c.id === coalitionId);
      if (!coalition) {
        return { success: false, error: `Coalition not found: ${coalitionId}` };
      }

      if (coalition.members.includes(currentAgent)) {
        return { success: false, error: 'You are already a member of this coalition' };
      }

      if (coalition.status === 'dissolved') {
        return { success: false, error: 'This coalition has been dissolved' };
      }

      const minSize = readNegotiationRules(blackboard)?.minCoalitionSize ?? 2;
      const members = [...coalition.members, currentAgent];
      const activated = coalition.status === 'forming' && members.length >= minSize;
      const updatedCoalition: Coalition = {
        ...coalition,
        members,
        combinedWeight: coalition.combinedWeight + agentWeight,
        sharedInterests: additionalInterests
          ? [...coalition.sharedInterests, ...additionalInterests]
          : coalition.sharedInterests,
        status: activated ? 'active' : coalition.status,
      };

      writeNegotiationState(
        blackboard,
        {
          ...state,
          coalitions: state.coalitions.map((c) => (c.id === coalitionId ? updatedCoalition : c)),
        },
        currentAgent
      );

      if (activated) {
        events.emit(
          'negotiation:coalition-formed',
          { coalition: updatedCoalition, activatedBy: currentAgent },
          currentAgent
        );
      }

      return {
        success: true,
        coalitionId,
        name: updatedCoalition.name,
        members: updatedCoalition.members,
        combinedWeight: updatedCoalition.combinedWeight,
        status: updatedCoalition.status,
      };
    },
  });

  const declareInterests = tool({
    name: 'declare_interests',
    description:
      'Declare your interests and redlines at the start of negotiation. Helps other agents understand your position.',
    parameters: z.object({
      interests: z.array(NegotiationTermSchema).describe('Your declared interests/priorities'),
      redlines: z.array(z.string()).describe('Terms or conditions you absolutely cannot accept'),
    }),
    execute: async ({ interests, redlines }) => {
      const state = getNegotiationState(blackboard);
      if (!state) {
        return { success: false, error: 'No active negotiation session' };
      }

      writeNegotiationState(
        blackboard,
        {
          ...state,
          interests: {
            ...state.interests,
            [currentAgent]: { declared: interests as NegotiationTerm[], redlines },
          },
        },
        currentAgent
      );

      events.emit(
        'negotiation:interests-declared',
        {
          agent: currentAgent,
          interestsCount: interests.length,
          redlinesCount: redlines.length,
        },
        currentAgent
      );

      return {
        success: true,
        declaredInterests: interests.length,
        redlines: redlines.length,
        phase: state.phase,
      };
    },
  });

  return {
    makeOffer,
    counterOffer,
    acceptOffer,
    rejectOffer,
    getNegotiationStatus,
    getCurrentOffers,
    proposeCoalition,
    joinCoalition,
    declareInterests,
  };
}

export type NegotiationTools = ReturnType<typeof createNegotiationTools>;
