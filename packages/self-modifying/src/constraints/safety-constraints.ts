import type {
  SafetyConstraint,
  CapabilityConstraint,
  ResourceConstraint,
  ModificationConstraints,
} from '@cogitator-ai/types';
import { DEFAULT_SAFETY_CONSTRAINTS } from '@cogitator-ai/types';

export { DEFAULT_SAFETY_CONSTRAINTS };

export const DEFAULT_CAPABILITY_CONSTRAINTS: CapabilityConstraint[] = [
  {
    id: 'allowed_tool_categories',
    name: 'Allowed Tool Categories',
    type: 'tool_category',
    description: 'Allowed and forbidden tool categories',
    allowed: ['math', 'text', 'utility', 'data'],
    forbidden: ['system', 'network', 'file'],
    maxComplexity: 100,
  },
];

export const DEFAULT_RESOURCE_CONSTRAINTS: ResourceConstraint[] = [
  {
    id: 'default_resource_limits',
    name: 'Default Resource Limits',
    resource: 'runtime',
    description: 'Default runtime resource limits',
    maxMemory: 128,
    maxTokensPerRun: 100000,
    maxCostPerRun: 1.0,
    maxToolsActive: 20,
  },
];

export function createDefaultConstraints(): ModificationConstraints {
  return {
    safety: [...DEFAULT_SAFETY_CONSTRAINTS],
    capability: [...DEFAULT_CAPABILITY_CONSTRAINTS],
    resource: [...DEFAULT_RESOURCE_CONSTRAINTS],
    custom: [],
  };
}

export function mergeSafetyConstraints(
  base: SafetyConstraint[],
  additions: SafetyConstraint[]
): SafetyConstraint[] {
  const result = new Map<string, SafetyConstraint>();
  for (const c of base) {
    result.set(c.id, c);
  }
  for (const c of additions) {
    result.set(c.id, c);
  }
  return [...result.values()];
}

export function mergeCapabilityConstraints(
  base: CapabilityConstraint[],
  additions: CapabilityConstraint[]
): CapabilityConstraint[] {
  const result = new Map<string, CapabilityConstraint>();
  for (const c of base) {
    result.set(c.id, c);
  }
  for (const c of additions) {
    result.set(c.id, c);
  }
  return [...result.values()];
}

export function mergeResourceConstraints(
  base: ResourceConstraint[],
  additions: ResourceConstraint[]
): ResourceConstraint[] {
  const result = new Map<string, ResourceConstraint>();
  for (const c of base) {
    result.set(c.id, c);
  }
  for (const c of additions) {
    result.set(c.id, c);
  }
  return [...result.values()];
}

export function mergeConstraints(
  base: ModificationConstraints,
  additions: Partial<ModificationConstraints>
): ModificationConstraints {
  return {
    safety: additions.safety ? mergeSafetyConstraints(base.safety, additions.safety) : base.safety,
    capability: additions.capability
      ? mergeCapabilityConstraints(base.capability, additions.capability)
      : base.capability,
    resource: additions.resource
      ? mergeResourceConstraints(base.resource, additions.resource)
      : base.resource,
    custom: [...(base.custom ?? []), ...(additions.custom ?? [])],
  };
}
