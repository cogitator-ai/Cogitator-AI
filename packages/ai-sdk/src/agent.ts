import { ToolLoopAgent, type ToolLoopAgentSettings } from 'ai';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import { cogitatorModel } from './provider.js';

/** The AI SDK tools of the agent: none, the Cogitator agent runs its own */
type NoTools = Record<never, never>;

/**
 * Settings of the AI SDK agent around a Cogitator agent: those of `ToolLoopAgent` except what
 * the Cogitator agent decides itself, its model, instructions and tools
 */
export type CogitatorAgentSettings = Omit<
  ToolLoopAgentSettings,
  'model' | 'instructions' | 'tools' | 'activeTools' | 'toolChoice'
>;

/**
 * A Cogitator agent as an AI SDK agent (`agent-v1`), for `createAgentUIStreamResponse` and
 * everything else that takes one. It is a `ToolLoopAgent` on `cogitatorModel()`: the Cogitator
 * agent runs its own tools, memory and approvals inside one model step, and the AI SDK sees its
 * tool calls as provider-executed. Needs ai@7.
 *
 * @example
 * ```ts
 * import { toAISDKAgent } from '@cogitator-ai/ai-sdk/agent';
 *
 * const support = toAISDKAgent(cogitator, supportAgent);
 * const { text } = await support.generate({ prompt: 'Where is order 42?' });
 * ```
 */
export function toAISDKAgent(
  cogitator: Cogitator,
  agent: Agent,
  settings: CogitatorAgentSettings = {}
): ToolLoopAgent<never, NoTools> {
  return new ToolLoopAgent<never, NoTools>({
    id: agent.name,
    ...settings,
    model: cogitatorModel(cogitator, agent, { specificationVersion: 'v4' }),
    tools: {},
  });
}
