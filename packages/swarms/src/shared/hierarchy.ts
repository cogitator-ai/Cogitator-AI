import type { Blackboard, HierarchicalConfig } from '@cogitator-ai/types';

export const HIERARCHY_SECTION = 'hierarchy';

/**
 * Delegation policy published on the blackboard by the hierarchical strategy and enforced
 * by delegation and messaging tools.
 */
export interface HierarchyPolicy {
  supervisor: string;
  maxDelegationDepth: number;
  workerCommunication: boolean;
  routeThrough: NonNullable<HierarchicalConfig['routeThrough']>;
  visibility: NonNullable<HierarchicalConfig['visibility']>;
  /** Delegation depth of every agent that received a task (supervisor = 0) */
  depths: Record<string, number>;
}

export function readHierarchyPolicy(blackboard: Blackboard): HierarchyPolicy | null {
  if (!blackboard.has(HIERARCHY_SECTION)) return null;
  try {
    return blackboard.read<HierarchyPolicy>(HIERARCHY_SECTION);
  } catch {
    return null;
  }
}

const SUMMARY_LENGTH = 500;

/**
 * Shape a worker output according to the configured supervisor visibility.
 */
export function applyVisibility(
  output: string,
  visibility: HierarchyPolicy['visibility']
): string | undefined {
  switch (visibility) {
    case 'none':
      return undefined;
    case 'summary':
      return output.length > SUMMARY_LENGTH ? `${output.slice(0, SUMMARY_LENGTH)}…` : output;
    case 'full':
    default:
      return output;
  }
}
