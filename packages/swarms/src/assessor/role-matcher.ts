import type {
  TaskRequirements,
  RoleRequirements,
  SwarmAgent,
  SwarmConfig,
} from '@cogitator-ai/types';
import { collectSwarmAgentEntries } from '../agents';

export class RoleMatcher {
  analyzeRole(agent: SwarmAgent, taskReqs: TaskRequirements): RoleRequirements {
    const role = agent.metadata.role;
    const expertise = agent.metadata.expertise ?? [];

    const roleReqs: RoleRequirements = {
      ...taskReqs,
      role,
      agentName: agent.agent.name,
      customHints: [],
    };

    switch (role) {
      case 'supervisor':
        roleReqs.needsReasoning = 'advanced';
        roleReqs.needsSpeed = 'balanced';
        roleReqs.costSensitivity = this.adjustCostSensitivity(taskReqs.costSensitivity, -1);
        roleReqs.customHints?.push('Needs strong planning and coordination abilities');
        break;

      case 'worker':
        this.applyExpertiseRequirements(roleReqs, expertise);

        roleReqs.costSensitivity = this.adjustCostSensitivity(taskReqs.costSensitivity, 1);
        break;

      case 'critic':
      case 'advocate':
        roleReqs.needsReasoning = this.upgradeReasoning(taskReqs.needsReasoning);
        roleReqs.customHints?.push('Needs analytical and evaluative capabilities');
        break;

      case 'moderator':
        roleReqs.needsReasoning = 'moderate';
        roleReqs.needsSpeed = 'balanced';
        roleReqs.customHints?.push('Needs balanced synthesis capabilities');
        break;

      case 'router':
        roleReqs.needsReasoning = 'moderate';
        roleReqs.needsSpeed = 'fast';
        roleReqs.customHints?.push('Needs quick classification and routing');
        break;
    }

    return roleReqs;
  }

  private applyExpertiseRequirements(reqs: RoleRequirements, expertise: string[]): void {
    for (const skill of expertise) {
      const lower = skill.toLowerCase();

      if (lower.includes('code') || lower.includes('program') || lower.includes('develop')) {
        reqs.needsToolCalling = true;
        reqs.domains = [...(reqs.domains ?? []), 'code'];
        reqs.customHints?.push('Requires coding capability');
      }

      if (lower.includes('research') || lower.includes('analys')) {
        reqs.needsReasoning = this.upgradeReasoning(reqs.needsReasoning);
        reqs.domains = [...(reqs.domains ?? []), 'analysis'];
      }

      if (lower.includes('writ') || lower.includes('content') || lower.includes('creative')) {
        reqs.domains = [...(reqs.domains ?? []), 'creative'];
      }

      if (lower.includes('math') || lower.includes('calcul') || lower.includes('statist')) {
        reqs.domains = [...(reqs.domains ?? []), 'math'];
      }

      if (lower.includes('image') || lower.includes('visual') || lower.includes('design')) {
        reqs.needsVision = true;
      }
    }

    if (reqs.domains) {
      reqs.domains = [...new Set(reqs.domains)];
    }
  }

  private upgradeReasoning(
    current: TaskRequirements['needsReasoning']
  ): TaskRequirements['needsReasoning'] {
    if (current === 'basic') return 'moderate';
    if (current === 'moderate') return 'advanced';
    return 'advanced';
  }

  private adjustCostSensitivity(
    current: TaskRequirements['costSensitivity'],
    direction: -1 | 0 | 1
  ): TaskRequirements['costSensitivity'] {
    const levels: TaskRequirements['costSensitivity'][] = ['low', 'medium', 'high'];
    const currentIndex = levels.indexOf(current);
    const newIndex = Math.max(0, Math.min(2, currentIndex + direction));
    return levels[newIndex];
  }

  /**
   * All agents of a swarm config with their swarm metadata. Agents without an explicit role
   * are assessed as workers.
   */
  extractAgentsFromConfig(config: SwarmConfig): SwarmAgent[] {
    return collectSwarmAgentEntries(config).map(({ agent, metadata }) => ({
      agent,
      metadata: { ...metadata, role: metadata.role ?? 'worker' },
      state: 'idle',
      messageCount: 0,
      tokenCount: 0,
    }));
  }
}
