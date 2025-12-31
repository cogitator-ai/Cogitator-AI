import { z } from 'zod';
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

const NegotiationTermSchema = z.object({
  termId: z.string().describe('Unique identifier for this term'),
  label: z.string().describe('Human-readable label for the term'),
  value: z.unknown().describe('The proposed value for this term'),
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
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function getNegotiationState(blackboard: Blackboard): NegotiationState | null {
  return blackboard.read<NegotiationState>('negotiation');
}

function writeNegotiationState(
  blackboard: Blackboard,
  state: NegotiationState,
  agent: string
): void {
  blackboard.write('negotiation', state, agent);
}

export function createNegotiationTools(
  blackboard: Blackboard,
  events: SwarmEventEmitter,
  currentAgent: string,
  agentWeight = 1
) {
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

      if (state.currentTurn !== null && state.currentTurn !== currentAgent) {
        return {
          success: false,
          error: `Not your turn. Current turn: ${state.currentTurn}`,
        };
      }

      const offer: NegotiationOffer = {
        id: generateId(),
        from: currentAgent,
        to,
        terms: terms as NegotiationTerm[],
        reasoning,
        timestamp: Date.now(),
        status: 'pending' as OfferStatus,
        expiresAt: expiresInMs ? Date.now() + expiresInMs : undefined,
        round: state.round,
        phase: state.phase,
      };

      state.offers.push(offer);
      state.lastActivityAt = Date.now();
      writeNegotiationState(blackboard, state, currentAgent);

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

      const originalOffer = state.offers.find((o) => o.id === inResponseTo);
      if (!originalOffer) {
        return { success: false, error: `Original offer not found: ${inResponseTo}` };
      }

      if (originalOffer.status !== 'pending') {
        return {
          success: false,
          error: `Cannot counter offer with status: ${originalOffer.status}`,
        };
      }

      const recipients = Array.isArray(originalOffer.to) ? originalOffer.to : [originalOffer.to];
      if (!recipients.includes(currentAgent) && originalOffer.from !== currentAgent) {
        return { success: false, error: 'You are not a party to this offer' };
      }

      originalOffer.status = 'countered';

      const acceptedTerms = acceptedTermIds
        ? originalOffer.terms.filter((t) => acceptedTermIds.includes(t.termId))
        : [];

      const allTerms = [...acceptedTerms, ...(modifiedTerms as NegotiationTerm[])];

      const counterOfferDoc: NegotiationOffer = {
        id: generateId(),
        from: currentAgent,
        to: originalOffer.from,
        terms: allTerms,
        reasoning,
        inResponseTo,
        timestamp: Date.now(),
        status: 'pending',
        round: state.round,
        phase: 'counter' as NegotiationPhase,
      };

      state.offers.push(counterOfferDoc);
      state.phase = 'counter';
      state.lastActivityAt = Date.now();
      writeNegotiationState(blackboard, state, currentAgent);

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

      const offer = state.offers.find((o) => o.id === offerId);
      if (!offer) {
        return { success: false, error: `Offer not found: ${offerId}` };
      }

      if (offer.status !== 'pending') {
        return { success: false, error: `Cannot accept offer with status: ${offer.status}` };
      }

      const recipients = Array.isArray(offer.to) ? offer.to : [offer.to];
      if (!recipients.includes(currentAgent)) {
        return { success: false, error: 'This offer was not made to you' };
      }

      offer.status = 'accepted';
      state.lastActivityAt = Date.now();
      writeNegotiationState(blackboard, state, currentAgent);

      events.emit(
        'negotiation:offer-accepted',
        {
          offerId,
          acceptedBy: currentAgent,
          offer,
          comment,
        },
        currentAgent
      );

      return {
        success: true,
        offerId,
        acceptedTerms: offer.terms.map((t) => t.termId),
        from: offer.from,
        round: state.round,
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

      const offer = state.offers.find((o) => o.id === offerId);
      if (!offer) {
        return { success: false, error: `Offer not found: ${offerId}` };
      }

      if (offer.status !== 'pending') {
        return { success: false, error: `Cannot reject offer with status: ${offer.status}` };
      }

      offer.status = 'rejected';
      state.lastActivityAt = Date.now();
      writeNegotiationState(blackboard, state, currentAgent);

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

      state.coalitions.push(coalition);
      state.lastActivityAt = Date.now();
      writeNegotiationState(blackboard, state, currentAgent);

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

      coalition.members.push(currentAgent);
      coalition.combinedWeight += agentWeight;

      if (additionalInterests) {
        coalition.sharedInterests.push(...additionalInterests);
      }

      if (coalition.status === 'forming' && coalition.members.length >= 2) {
        coalition.status = 'active';
        events.emit(
          'negotiation:coalition-formed',
          { coalition, activatedBy: currentAgent },
          currentAgent
        );
      }

      state.lastActivityAt = Date.now();
      writeNegotiationState(blackboard, state, currentAgent);

      return {
        success: true,
        coalitionId,
        name: coalition.name,
        members: coalition.members,
        combinedWeight: coalition.combinedWeight,
        status: coalition.status,
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

      state.interests[currentAgent] = {
        declared: interests as NegotiationTerm[],
        redlines,
      };
      state.lastActivityAt = Date.now();
      writeNegotiationState(blackboard, state, currentAgent);

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
