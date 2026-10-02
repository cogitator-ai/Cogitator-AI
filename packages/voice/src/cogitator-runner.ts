import type { VoiceAgentRunner, VoiceRunContext } from './types.js';

export interface CogitatorLike<TAgent> {
  run(
    agent: TAgent,
    options: { input: string; threadId?: string; signal?: AbortSignal }
  ): Promise<{ readonly output: string }>;
}

export interface CogitatorRunnerOptions {
  /**
   * Thread id used for agent memory. Defaults to `voice:<sessionId>` so each voice
   * session keeps its own conversation history.
   */
  threadId?: (context: VoiceRunContext) => string;
}

/**
 * Adapt a Cogitator runtime + agent to the `VoiceAgentRunner` interface used by
 * `VoicePipeline` and `VoiceAgent`.
 *
 * @example
 * ```ts
 * const voice = new VoiceAgent({
 *   mode: 'pipeline',
 *   agent: createCogitatorRunner(cogitator, agent),
 *   stt, tts,
 * });
 * ```
 */
export function createCogitatorRunner<TAgent extends { readonly instructions?: string }>(
  cogitator: CogitatorLike<TAgent>,
  agent: TAgent,
  options: CogitatorRunnerOptions = {}
): VoiceAgentRunner {
  const resolveThreadId = options.threadId ?? ((ctx: VoiceRunContext) => `voice:${ctx.sessionId}`);
  return {
    instructions: agent.instructions,
    async run(input, context) {
      const result = await cogitator.run(agent, {
        input,
        ...(context && { threadId: resolveThreadId(context) }),
        ...(context?.signal && { signal: context.signal }),
      });
      return { content: result.output };
    },
  };
}
