import type { Agent as IAgent, Handoff, Tool } from '@cogitator-ai/types';
import { z } from 'zod';
import { tool } from '../tool';

const handoffParameters = z.object({
  reason: z.string().optional().describe('Why the conversation goes to this agent'),
});

export interface HandoffTools {
  tools: Tool[];
  /** The agent each handoff tool hands over to, by tool name */
  targets: Map<string, IAgent>;
}

/** The `transfer_to_<name>` tools of an agent's `handoffs`. */
export function handoffTools(agent: IAgent): HandoffTools {
  const tools: Tool[] = [];
  const targets = new Map<string, IAgent>();
  for (const entry of agent.config.handoffs ?? []) {
    const { agent: target, toolName, description } = toHandoff(entry);
    const name = toolName ?? `transfer_to_${toToolName(target.name)}`;
    targets.set(name, target);
    tools.push(
      tool({
        name,
        description:
          description ??
          `Hand the conversation over to ${target.name}${
            target.config.description ? `: ${target.config.description}` : '.'
          }`,
        parameters: handoffParameters,
        execute: async ({ reason }) => ({
          transferred: true,
          to: target.name,
          ...(reason && { reason }),
        }),
      })
    );
  }
  return { tools, targets };
}

/**
 * The agent called `name` among `entry` and the agents it can reach through
 * handoffs, for resuming a run that paused after a handoff.
 */
export function findHandoffAgent(entry: IAgent, name: string): IAgent | undefined {
  const seen = new Set<IAgent>();
  const queue: IAgent[] = [entry];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (current.name === name) return current;
    for (const next of current.config.handoffs ?? []) queue.push(toHandoff(next).agent);
  }
  return undefined;
}

function toHandoff(entry: IAgent | Handoff): Handoff {
  return 'agent' in entry ? entry : { agent: entry };
}

function toToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'agent';
}
