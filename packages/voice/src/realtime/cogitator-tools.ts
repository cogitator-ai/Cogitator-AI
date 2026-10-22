import type { Tool, ToolInvoker } from '@cogitator-ai/types';
import type { RealtimeTool, RealtimeToolContext, RealtimeToolsOptions } from '../types.js';

export type { RealtimeToolsOptions };

/**
 * Cogitator tools in the shape a realtime session takes, each call run through
 * `invoker.invokeTool` (a `Cogitator`): arguments validated against the tool's schema, approval
 * asked for calls that need it, the guardrails applied, sandboxed tools run in the sandbox and
 * `tool.timeout` kept, the way an agent run executes them. A call fails with the error the
 * invoker reports, which the model reads, and is cancelled when the session closes.
 *
 * @example
 * ```ts
 * const voice = new VoiceAgent({
 *   mode: 'realtime',
 *   agent: createCogitatorRunner(cogitator, agent),
 *   realtimeProvider: 'openai',
 *   realtimeApiKey: process.env.OPENAI_API_KEY!,
 *   tools: createRealtimeTools(cogitator, agent.tools, {
 *     onApproval: async (request) => ({ approved: await askOperator(request) }),
 *   }),
 * });
 * ```
 */
export function createRealtimeTools(
  invoker: ToolInvoker,
  tools: readonly Tool[],
  options: RealtimeToolsOptions = {}
): RealtimeTool[] {
  const threadIdOf =
    options.threadId ??
    ((context: RealtimeToolContext) =>
      context.sessionId === undefined ? undefined : `voice:${context.sessionId}`);

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.toJSON().parameters,
    ...(tool.maxResultLength !== undefined && { maxResultLength: tool.maxResultLength }),
    execute: async (args, context) => {
      const threadId = threadIdOf(context);
      const result = await invoker.invokeTool(tool, args, {
        toolCallId: context.callId,
        agentId: options.agentId ?? 'voice',
        signal: context.signal,
        ...(threadId !== undefined && { threadId }),
        ...(options.userId !== undefined && { userId: options.userId }),
        ...(options.onApproval && { onApproval: options.onApproval }),
      });
      if (result.error !== undefined) throw new Error(result.error);
      return result.result;
    },
  }));
}
