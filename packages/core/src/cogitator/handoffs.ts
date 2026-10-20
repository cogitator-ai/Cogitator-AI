import type { Agent as IAgent, Handoff, Tool } from '@cogitator-ai/types';
import { z } from 'zod';
import { tool } from '../tool';
import { normalizeToolName, normalizeToolNames } from '../tool-name';

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
  const handoffs = (agent.config.handoffs ?? []).map(toHandoff);
  const names = defaultToolNames(handoffs);
  handoffs.forEach(({ agent: target, toolName, description }, index) => {
    const name = toolName ?? names[index]!;
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
  });
  return { tools, targets };
}

/**
 * `transfer_to_<name>` for each handoff, made provider-safe. Agents whose names come out the
 * same (`Billing EU` and `Billing/EU`, or names in other scripts) get a hash of their own name,
 * so the model can still reach each of them.
 */
function defaultToolNames(handoffs: readonly Handoff[]): string[] {
  const names = handoffs.map(({ agent }) =>
    normalizeToolName(`transfer_to_${toToolName(agent.name)}`)
  );
  const count = new Map<string, number>();
  for (const name of names) count.set(name, (count.get(name) ?? 0) + 1);
  const clashing = handoffs
    .map((handoff, index) => ({ index, raw: `transfer_to_${handoff.agent.name}` }))
    .filter(({ index }) => (count.get(names[index]!) ?? 0) > 1);
  const distinct = normalizeToolNames(clashing.map(({ raw }) => raw));
  clashing.forEach(({ index }, i) => (names[index] = distinct[i]!));
  return names;
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
  return trimUnderscores(name.replace(/[^a-zA-Z0-9_-]+/g, '_')) || 'agent';
}

function trimUnderscores(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '_') start++;
  while (end > start && value[end - 1] === '_') end--;
  return value.slice(start, end);
}
