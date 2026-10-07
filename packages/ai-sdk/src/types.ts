import type { Tool } from '@cogitator-ai/types';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from '@ai-sdk/provider';
import type { Agent } from '@cogitator-ai/core';
import type { LanguageModel as InstalledAILanguageModel } from 'ai';
import type { JSONObject, JSONValue } from './json.js';
import type { LanguageModelV1 } from './v1-types.js';

/**
 * Language model specification implemented by the models that `cogitatorModel()` and
 * `createCogitatorProvider()` return:
 *
 * - `'v1'` — AI SDK 4 (`ai@4`)
 * - `'v2'` — AI SDK 5, 6 and 7
 * - `'v3'` — AI SDK 6 and 7
 * - `'v4'` — AI SDK 7
 *
 * When omitted, the version matching the installed `ai` package is used.
 */
export type CogitatorSpecificationVersion = 'v1' | 'v2' | 'v3' | 'v4';

type ModelSpec<T> = T extends { readonly specificationVersion: infer S } ? S : never;

/**
 * Specification picked when `specificationVersion` is omitted: the newest one accepted by the
 * installed `ai` package (ai@4 → v1, ai@5 → v2, ai@6 → v3, ai@7 → v4). It mirrors the runtime
 * detection in `cogitatorModel()` and `createCogitatorProvider()`.
 */
export type DefaultSpecificationVersion = [
  Extract<ModelSpec<InstalledAILanguageModel>, 'v4'>,
] extends [never]
  ? [Extract<ModelSpec<InstalledAILanguageModel>, 'v3'>] extends [never]
    ? [Extract<ModelSpec<InstalledAILanguageModel>, 'v2'>] extends [never]
      ? 'v1'
      : 'v2'
    : 'v3'
  : 'v4';

export interface CogitatorTextContent {
  type: 'text';
  text: string;
}

/** The agent's reasoning summary (`reasoning.summary` on the agent). */
export interface CogitatorReasoningContent {
  type: 'reasoning';
  text: string;
}

/** A tool call the agent executed itself, reported as provider-executed. */
export interface CogitatorToolCallContent {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: string;
  providerExecuted: true;
  dynamic: true;
}

export interface CogitatorToolResultContent {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  result: NonNullable<JSONValue>;
  isError: boolean;
  providerExecuted: true;
  dynamic: true;
}

export type CogitatorContent =
  | CogitatorTextContent
  | CogitatorReasoningContent
  | CogitatorToolCallContent
  | CogitatorToolResultContent;

/**
 * A provider-executed tool call the agent's run waits to have approved (`requiresApproval`).
 * Answer it with a `tool-approval-response` (`providerExecuted: true`) in the next prompt and the
 * run resumes.
 */
export interface CogitatorToolApprovalRequestContent {
  type: 'tool-approval-request';
  approvalId: string;
  toolCallId: string;
}

/** Content of the v3 and v4 models, which can ask for tool approvals. */
export type CogitatorContentV3 = CogitatorContent | CogitatorToolApprovalRequestContent;

export type CogitatorStreamPart<TWarning, TUsage, TFinishReason, TExtra = never> =
  | { type: 'stream-start'; warnings: TWarning[] }
  | { type: 'response-metadata'; id?: string; timestamp?: Date; modelId?: string }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string }
  | {
      type: 'tool-input-start';
      id: string;
      toolName: string;
      providerExecuted: true;
      dynamic: true;
    }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-input-end'; id: string }
  | CogitatorToolCallContent
  | CogitatorToolResultContent
  | {
      type: 'finish';
      usage: TUsage;
      finishReason: TFinishReason;
      providerMetadata: Record<string, JSONObject>;
    }
  | { type: 'error'; error: unknown }
  | TExtra;

export type CogitatorWarningV2 =
  | { type: 'unsupported-setting'; setting: string; details?: string }
  | { type: 'other'; message: string };

export type CogitatorWarningV3 =
  { type: 'unsupported'; feature: string; details?: string } | { type: 'other'; message: string };

export interface CogitatorUsageV2 {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface CogitatorUsageV3 {
  inputTokens: {
    total: number;
    noCache: number | undefined;
    cacheRead: number | undefined;
    cacheWrite: number | undefined;
  };
  outputTokens: { total: number; text: number | undefined; reasoning: number | undefined };
}

/**
 * Why a v3 or v4 model's turn ended: `stop` when the agent answered, `tool-calls` (raw `paused`)
 * when its run waits for tool approvals, `content-filter` when the answer was withheld (raw
 * `content_filter` for a provider's filter, `refusal` when the model declined), `length` when the
 * answer stopped at the output token limit, and `other` (raw `iteration-limit`) when tool calls
 * used up the agent's `maxIterations`.
 */
export type CogitatorFinishReasonV3 =
  | { unified: 'stop'; raw: 'stop' }
  | { unified: 'tool-calls'; raw: 'paused' }
  | { unified: 'content-filter'; raw: 'content_filter' | 'refusal' }
  | { unified: 'length'; raw: 'length' }
  | { unified: 'other'; raw: 'iteration-limit' };

/**
 * Why a v2 model's turn ended: `other` when the run waits for tool approvals or used up its
 * iterations, `content-filter` when the answer was withheld, `length` when it was cut off.
 */
export type CogitatorFinishReasonV2 = 'stop' | 'other' | 'content-filter' | 'length';

export interface CogitatorGenerateResult<
  TWarning,
  TUsage,
  TFinishReason,
  TContent = CogitatorContent,
> {
  content: TContent[];
  finishReason: TFinishReason;
  usage: TUsage;
  providerMetadata: Record<string, JSONObject>;
  request: { body: unknown };
  response: { id: string; timestamp: Date; modelId: string };
  warnings: TWarning[];
}

export interface CogitatorStreamResult<TWarning, TUsage, TFinishReason, TExtra = never> {
  stream: ReadableStream<CogitatorStreamPart<TWarning, TUsage, TFinishReason, TExtra>>;
  request: { body: unknown };
}

interface CogitatorModernLanguageModel<
  TCallOptions,
  TWarning,
  TUsage,
  TFinishReason,
  TContent = CogitatorContent,
> {
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]>;
  doGenerate(
    options: TCallOptions
  ): PromiseLike<CogitatorGenerateResult<TWarning, TUsage, TFinishReason, TContent>>;
  doStream(
    options: TCallOptions
  ): PromiseLike<
    CogitatorStreamResult<TWarning, TUsage, TFinishReason, Exclude<TContent, CogitatorContent>>
  >;
}

/**
 * `LanguageModelV2` implemented by Cogitator agents. Its result types are deliberately narrow
 * so the model satisfies the `LanguageModelV2` of every `@ai-sdk/provider` release (ai@5 – ai@7).
 */
export interface CogitatorLanguageModelV2 extends CogitatorModernLanguageModel<
  LanguageModelV2CallOptions,
  CogitatorWarningV2,
  CogitatorUsageV2,
  CogitatorFinishReasonV2
> {
  readonly specificationVersion: 'v2';
}

/** `LanguageModelV3` implemented by Cogitator agents (ai@6, ai@7). */
export interface CogitatorLanguageModelV3 extends CogitatorModernLanguageModel<
  LanguageModelV3CallOptions,
  CogitatorWarningV3,
  CogitatorUsageV3,
  CogitatorFinishReasonV3,
  CogitatorContentV3
> {
  readonly specificationVersion: 'v3';
}

/** `LanguageModelV4` implemented by Cogitator agents (ai@7). */
export interface CogitatorLanguageModelV4 extends CogitatorModernLanguageModel<
  LanguageModelV4CallOptions,
  CogitatorWarningV3,
  CogitatorUsageV3,
  CogitatorFinishReasonV3,
  CogitatorContentV3
> {
  readonly specificationVersion: 'v4';
}

export type CogitatorLanguageModel<
  V extends CogitatorSpecificationVersion = DefaultSpecificationVersion,
> = V extends 'v1'
  ? LanguageModelV1
  : V extends 'v3'
    ? CogitatorLanguageModelV3
    : V extends 'v4'
      ? CogitatorLanguageModelV4
      : CogitatorLanguageModelV2;

/** Any AI SDK language model that `fromAISDK()` can wrap as a Cogitator backend. */
export type AISDKLanguageModel =
  LanguageModelV1 | LanguageModelV2 | LanguageModelV3 | LanguageModelV4;

export interface CogitatorProviderOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export interface CogitatorModelOptions<
  V extends CogitatorSpecificationVersion = DefaultSpecificationVersion,
> extends CogitatorProviderOptions {
  specificationVersion?: V;
}

export interface CogitatorProviderConfig<
  V extends CogitatorSpecificationVersion = DefaultSpecificationVersion,
> {
  agents: Agent[] | Map<string, Agent> | Record<string, Agent>;
  specificationVersion?: V;
}

export interface CogitatorProvider<
  V extends CogitatorSpecificationVersion = DefaultSpecificationVersion,
> {
  (agentName: string, options?: CogitatorProviderOptions): CogitatorLanguageModel<V>;
  languageModel(agentName: string, options?: CogitatorProviderOptions): CogitatorLanguageModel<V>;
}

export type CogitatorTool<TParams = unknown, TResult = unknown> = Tool<TParams, TResult>;

type Bivariant<TArgs extends unknown[], TResult> = {
  bivarianceHack(...args: TArgs): TResult;
}['bivarianceHack'];

/** Options the AI SDK passes to a tool's `needsApproval` function (ai@6 and ai@7). */
export interface AISDKToolApprovalOptions {
  toolCallId: string;
  messages: unknown[];
  /** Tool context (ai@7). */
  context?: unknown;
  /** Tool context (ai@6). */
  experimental_context?: unknown;
}

/** Options the AI SDK passes to a tool's `execute` function (union of ai@4 – ai@7 shapes). */
export interface AISDKToolExecutionOptions {
  toolCallId: string;
  messages: unknown[];
  abortSignal?: AbortSignal;
  /** Tool context (ai@7). */
  context?: unknown;
  /** Tool context (ai@5 and ai@6). */
  experimental_context?: unknown;
}

export type AISDKToolExecuteResult<TOutput> =
  AsyncIterable<TOutput> | PromiseLike<TOutput> | TOutput;

/** An AI SDK tool as accepted by `fromAISDKTool()` — `tool()` output of any AI SDK major. */
export interface AISDKToolLike<TInput = unknown, TOutput = unknown> {
  name?: string;
  description?: string | Bivariant<[options: { context: unknown }], string>;
  /** Input schema (ai@5+): zod 4, Standard JSON Schema, `jsonSchema()` or `zodSchema()`. */
  inputSchema?: unknown;
  /** Input schema (ai@4): `jsonSchema()`, `zodSchema()` or a zod 4 schema. */
  parameters?: unknown;
  execute?: Bivariant<
    [input: TInput, options: AISDKToolExecutionOptions],
    AISDKToolExecuteResult<TOutput>
  >;
  /** Whether a call needs the user's approval before it runs (ai@6+) */
  needsApproval?:
    | boolean
    | Bivariant<[input: TInput, options: AISDKToolApprovalOptions], boolean | PromiseLike<boolean>>;
}

export interface AISDKValidationIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

export type AISDKValidationResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<AISDKValidationIssue> };

export interface AISDKJSONSchemaConverterOptions {
  readonly target: string;
  readonly libraryOptions?: Record<string, unknown>;
}

/**
 * Tool input schema emitted by `toAISDKTool()`. It is an AI SDK `Schema` (recognised by every
 * AI SDK major through `Symbol.for('vercel.ai.schema')`) and a Standard JSON Schema.
 */
export type AISDKSchemaValidation<T> =
  { success: true; value: T } | { success: false; error: Error };

export interface AISDKSchema<T = unknown> {
  readonly jsonSchema: Record<string, unknown>;
  validate(value: unknown): AISDKSchemaValidation<T> | PromiseLike<AISDKSchemaValidation<T>>;
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown): AISDKValidationResult<T> | Promise<AISDKValidationResult<T>>;
    readonly jsonSchema: {
      input(options: AISDKJSONSchemaConverterOptions): Record<string, unknown>;
      output(options: AISDKJSONSchemaConverterOptions): Record<string, unknown>;
    };
    readonly types?: { readonly input: T; readonly output: T };
  };
}

/** AI SDK tool produced by `toAISDKTool()`; works with `tools` of ai@4 – ai@7. */
export interface AISDKTool<TInput = unknown, TOutput = unknown> {
  description: string;
  /** Input schema read by ai@5, ai@6 and ai@7: the Cogitator tool's zod schema. */
  inputSchema: Tool<TInput>['parameters'];
  /** Input schema read by ai@4: an AI SDK `Schema` with JSON Schema and validation. */
  parameters: AISDKSchema<TInput>;
  execute(input: TInput, options: AISDKToolExecutionOptions): Promise<TOutput>;
  /**
   * The Cogitator tool's `requiresApproval`, so ai@6 and ai@7 ask for approval (a
   * `tool-approval-request`) before they run it
   */
  needsApproval?: boolean | ((input: TInput) => boolean);
}
