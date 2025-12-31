/**
 * Swarm tools exports
 */

export { createMessagingTools, type MessagingTools } from './messaging';
export { createBlackboardTools, type BlackboardTools } from './blackboard';
export { createDelegationTools, type DelegationTools } from './delegation';
export { createVotingTools, type VotingTools } from './voting';

import type { Tool } from '@cogitator-ai/types';
import type { SwarmCoordinatorInterface, Blackboard, MessageBus, SwarmEventEmitter } from '@cogitator-ai/types';
import { createMessagingTools } from './messaging';
import { createBlackboardTools } from './blackboard';
import { createDelegationTools } from './delegation';
import { createVotingTools } from './voting';

export interface SwarmToolContext {
  coordinator: SwarmCoordinatorInterface;
  blackboard: Blackboard;
  messageBus: MessageBus;
  events: SwarmEventEmitter;
  agentName: string;
  agentWeight?: number;
}

/**
 * Create all swarm tools for an agent
 */
export function createSwarmTools(context: SwarmToolContext): Tool<unknown, unknown>[] {
  const messagingTools = createMessagingTools(context.messageBus, context.agentName);
  const blackboardTools = createBlackboardTools(context.blackboard, context.agentName);
  const delegationTools = createDelegationTools(
    context.coordinator,
    context.blackboard,
    context.agentName
  );
  const votingTools = createVotingTools(
    context.blackboard,
    context.events,
    context.agentName,
    context.agentWeight
  );

  return [
    messagingTools.sendMessage,
    messagingTools.readMessages,
    messagingTools.broadcastMessage,
    messagingTools.replyToMessage,
    blackboardTools.readBlackboard,
    blackboardTools.writeBlackboard,
    blackboardTools.appendBlackboard,
    blackboardTools.listBlackboardSections,
    blackboardTools.getBlackboardHistory,
    delegationTools.delegateTask,
    delegationTools.checkProgress,
    delegationTools.requestRevision,
    delegationTools.listWorkers,
    votingTools.castVote,
    votingTools.getVotes,
    votingTools.changeVote,
    votingTools.getConsensusStatus,
  ] as Tool<unknown, unknown>[];
}

/**
 * Create tools for a specific strategy
 */
export function createStrategyTools(
  strategy: 'hierarchical' | 'consensus' | 'debate' | 'auction' | 'pipeline' | 'round-robin',
  context: SwarmToolContext
): Tool<unknown, unknown>[] {
  const baseTools = [
    ...Object.values(createMessagingTools(context.messageBus, context.agentName)),
    ...Object.values(createBlackboardTools(context.blackboard, context.agentName)),
  ] as Tool<unknown, unknown>[];

  switch (strategy) {
    case 'hierarchical': {
      const delegationTools = createDelegationTools(
        context.coordinator,
        context.blackboard,
        context.agentName
      );
      return [...baseTools, ...Object.values(delegationTools)] as Tool<unknown, unknown>[];
    }

    case 'consensus':
    case 'debate': {
      const votingTools = createVotingTools(
        context.blackboard,
        context.events,
        context.agentName,
        context.agentWeight
      );
      return [...baseTools, ...Object.values(votingTools)] as Tool<unknown, unknown>[];
    }

    case 'auction':
    case 'pipeline':
    case 'round-robin':
    default:
      return baseTools;
  }
}
