import type {
  TaskRequirements,
  RoleRequirements,
  SwarmAgent,
  SwarmAgentMetadata,
} from '@cogitator-ai/types';

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

    // Adjust requirements based on role
    switch (role) {
      case 'supervisor':
        roleReqs.needsReasoning = 'advanced';
        roleReqs.needsSpeed = 'balanced';
        roleReqs.costSensitivity = this.adjustCostSensitivity(taskReqs.costSensitivity, -1);
        roleReqs.customHints?.push('Needs strong planning and coordination abilities');
        break;

      case 'worker':
        // Workers inherit task requirements but may have specialized needs
        this.applyExpertiseRequirements(roleReqs, expertise);
        // Workers can use cheaper models if cost-sensitive
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

    // Deduplicate domains
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

  extractAgentsFromConfig(config: {
    supervisor?: { name: string };
    workers?: Array<{ name: string }>;
    agents?: Array<{ name: string }>;
    moderator?: { name: string };
    router?: { name: string };
    stages?: Array<{ agent: { name: string } }>;
  }): SwarmAgent[] {
    const agents: SwarmAgent[] = [];

    if (config.supervisor) {
      agents.push(this.createSwarmAgent(config.supervisor, 'supervisor'));
    }

    if (config.workers) {
      for (const worker of config.workers) {
        agents.push(this.createSwarmAgent(worker, 'worker'));
      }
    }

    if (config.agents) {
      for (const agent of config.agents) {
        agents.push(this.createSwarmAgent(agent, 'worker'));
      }
    }

    if (config.moderator) {
      agents.push(this.createSwarmAgent(config.moderator, 'moderator'));
    }

    if (config.router) {
      agents.push(this.createSwarmAgent(config.router, 'router'));
    }

    if (config.stages) {
      for (const stage of config.stages) {
        agents.push(this.createSwarmAgent(stage.agent, 'worker'));
      }
    }

    return agents;
  }

  private createSwarmAgent(
    agent: { name: string; model?: string; metadata?: SwarmAgentMetadata },
    defaultRole: SwarmAgentMetadata['role']
  ): SwarmAgent {
    return {
      agent: agent as SwarmAgent['agent'],
      metadata: {
        role: (agent as { metadata?: SwarmAgentMetadata }).metadata?.role ?? defaultRole,
        expertise: (agent as { metadata?: SwarmAgentMetadata }).metadata?.expertise,
        locked: (agent as { metadata?: SwarmAgentMetadata }).metadata?.locked,
        ...(agent as { metadata?: SwarmAgentMetadata }).metadata,
      },
      state: 'idle',
      messageCount: 0,
      tokenCount: 0,
    };
  }
}
