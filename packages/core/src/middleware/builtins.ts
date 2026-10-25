import {
  CogitatorError,
  ErrorCode,
  type CompactionEndEvent,
  type CompactionStartEvent,
  type RunMiddlewareContext,
  type ModelStreamSink,
  type PiiConfig,
  type RunMiddleware,
  type ToolContext,
} from '@cogitator-ai/types';
import type { ConstitutionalAI } from '../constitutional/index';
import type { ContextManager } from '../context/index';
import type { PromptInjectionDetector } from '../security/index';
import {
  maskChatRequest,
  PiiMasker,
  restoreChatResponse,
  StreamRestorer,
  type PiiVault,
} from '../security/pii';
import { toolPartsToText, toolResultParts } from '../tool-content';
import { keepThroughCompaction, pinnedNotes } from '../cogitator/harness';
import { countMessagesTokens } from '../context/strategies/token-utils';

/**
 * Keeps personal data from the model per `security.pii`: in `mask` and `redact` mode every model
 * call of the run gets placeholders (`[EMAIL_1]`) instead of the values, and `mask` puts the
 * values back into the answer, its stream and its tool calls, so tools and the caller see them
 * while the provider never does. In `block` mode a run whose input holds any fails with
 * `PII_DETECTED`. The Cogitator adds it from `security.pii`, closest to the model, so it masks
 * whatever other middleware add.
 */
export function piiMiddleware(config: PiiConfig): RunMiddleware {
  const masker = new PiiMasker(config);
  const mode = config.mode ?? 'mask';
  if (mode === 'block') {
    return {
      name: 'cogitator:pii',
      beforeRun({ input }) {
        const types = [...new Set(masker.find(input).map((finding) => finding.type))];
        if (types.length === 0) return;
        throw new CogitatorError({
          message: `The input contains personal data: ${types.join(', ')}`,
          code: ErrorCode.PII_DETECTED,
          details: { types },
        });
      },
    };
  }
  return {
    name: 'cogitator:pii',
    async wrapModelCall(call, next) {
      const { masked, vault } = maskChatRequest(call.request, masker, config);
      if (mode !== 'mask' || vault.size === 0) return next({ ...call, request: masked });
      const stream = call.stream && restoringStream(call.stream, vault);
      const response = await next({
        ...call,
        request: masked,
        ...(stream && { stream: stream.sink }),
      });
      stream?.flush();
      return restoreChatResponse(response, vault);
    },
  };
}

/** `sink` behind restorers that put the values of `vault` back into streamed text. */
function restoringStream(
  sink: ModelStreamSink,
  vault: PiiVault
): { sink: ModelStreamSink; flush: () => void } {
  const content = new StreamRestorer(vault);
  const reasoning = new StreamRestorer(vault);
  const emit = (text: string, to: (text: string) => void) => {
    if (text) to(text);
  };
  return {
    sink: {
      onToken: (token) => emit(content.push(token), (text) => sink.onToken(text)),
      ...(sink.onReasoning && {
        onReasoning: (delta: string) =>
          emit(reasoning.push(delta), (text) => sink.onReasoning?.(text)),
      }),
    },
    flush: () => {
      emit(content.flush(), (text) => sink.onToken(text));
      emit(reasoning.flush(), (text) => sink.onReasoning?.(text));
    },
  };
}

/**
 * Refuses a run whose input `detector` finds a prompt injection in, with
 * `PROMPT_INJECTION_DETECTED`. The Cogitator adds it from `security.promptInjection`.
 */
export function promptInjectionMiddleware(detector: PromptInjectionDetector): RunMiddleware {
  return {
    name: 'cogitator:prompt-injection',
    async beforeRun({ input }) {
      const result = await detector.analyze(input);
      if (result.action !== 'blocked') return;
      throw new CogitatorError({
        message: `Prompt injection detected: ${result.threats.map((threat) => threat.type).join(', ')}`,
        code: ErrorCode.PROMPT_INJECTION_DETECTED,
        details: { threats: result.threats },
      });
    },
  };
}

/**
 * The guardrails of `ai` on a run: the input filter on a new run's input, the output filter on
 * every answer (a blocked one is replaced by its revision, or fails the run with
 * `LLM_CONTENT_FILTERED`, and a streamed run holds each turn's text until it passed), the tool
 * guard before each tool call and the result filter after it. The Cogitator adds it from
 * `guardrails`. `filterToolCalls` overrides the guardrails' own setting for the tool guard.
 */
export function guardrailsMiddleware(
  ai: ConstitutionalAI,
  options: { filterToolCalls?: boolean } = {}
): RunMiddleware {
  return {
    name: 'cogitator:guardrails',
    get holdsStream() {
      return Boolean(ai.config.enabled && ai.config.filterOutput);
    },
    async beforeRun({ input }) {
      if (!ai.config.filterInput) return;
      const result = await ai.filterInput(input);
      if (result.allowed) return;
      throw new CogitatorError({
        message: `Input blocked: ${result.blockedReason ?? 'Policy violation'}`,
        code: ErrorCode.LLM_CONTENT_FILTERED,
        details: { harmScores: result.harmScores },
      });
    },
    async afterModel({ response, messages }) {
      if (!ai.config.filterOutput || !response.content) return;
      const result = await ai.filterOutput(response.content, [...messages]);
      if (result.allowed) return;
      if (result.suggestedRevision) return { content: result.suggestedRevision };
      throw new CogitatorError({
        message: `Output blocked: ${result.blockedReason ?? 'Policy violation'}`,
        code: ErrorCode.LLM_CONTENT_FILTERED,
        details: { harmScores: result.harmScores },
      });
    },
    async wrapToolCall(call, next, context) {
      const { toolCall, tool } = call;
      if (options.filterToolCalls ?? ai.config.filterToolCalls ?? false) {
        const guard = await ai.guardTool(
          tool,
          call.args as Record<string, unknown>,
          toolContextOf(context),
          { approvedByUser: call.approved }
        );
        if (!guard.approved) {
          return {
            callId: toolCall.id,
            name: toolCall.name,
            result: null,
            error: `Tool blocked: ${guard.reason ?? 'Policy violation'}`,
          };
        }
      }
      const result = await next(call);
      if (result.error) return result;
      const filtered = await ai.filterToolResult(tool.name, toolResultText(result.result));
      if (filtered.allowed) return result;
      return {
        ...result,
        result: null,
        error: `Tool result blocked: ${filtered.blockedReason ?? 'Policy violation'}`,
      };
    },
  };
}

/**
 * How a compacting middleware asks the run's middleware whether a compaction may run
 * (`beforeCompaction`) and tells them it ran (`afterCompaction`)
 */
export interface CompactionNotices {
  before(
    context: RunMiddlewareContext,
    event: CompactionStartEvent
  ): Promise<{ skip: boolean; reason?: string }>;
  after(context: RunMiddlewareContext, event: CompactionEndEvent): Promise<void>;
}

/**
 * Compresses the run's conversation per `context` before a turn that would pass the context
 * manager's threshold for the run's model. What the agent must not lose is kept: the
 * instructions of the skills it activated (`use_skill`) and its todo list (`write_todos`) come
 * back as system messages when the compression dropped them. The run's middleware hear of it
 * (`beforeCompaction` can keep the conversation as it is). The Cogitator adds it from `context`.
 */
export function compactionMiddleware(
  manager: ContextManager,
  notices?: CompactionNotices
): RunMiddleware {
  return {
    name: 'cogitator:compaction',
    async beforeModel({ messages, model }, context) {
      const conversation = [...messages];
      if (!manager.shouldCompress(conversation, model)) return;
      const asked = await notices?.before(context, { trigger: 'auto', scope: 'turn' });
      if (asked?.skip) return;
      const reserve = countMessagesTokens(pinnedNotes(conversation));
      const compressed = await manager.compress(conversation, model, reserve);
      await notices?.after(context, { trigger: 'auto', scope: 'turn' });
      return { messages: keepThroughCompaction(conversation, compressed.messages) };
    },
  };
}

function toolContextOf(context: RunMiddlewareContext): ToolContext {
  return {
    agentId: context.agentId,
    runId: context.runId,
    signal: context.signal,
    ...(context.threadId !== undefined && { threadId: context.threadId }),
    ...(context.userId !== undefined && { userId: context.userId }),
    ...(context.channelType !== undefined && { channelType: context.channelType }),
    ...(context.channelId !== undefined && { channelId: context.channelId }),
    ...(context.topicId !== undefined && { topicId: context.topicId }),
    ...(context.conversationId !== undefined && { conversationId: context.conversationId }),
    ...(context.deps !== undefined && { deps: context.deps }),
    ...(context.workspace !== undefined && { workspace: context.workspace }),
  };
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  const parts = toolResultParts(value);
  if (parts) return toolPartsToText(parts);
  return JSON.stringify(value) ?? String(value);
}
