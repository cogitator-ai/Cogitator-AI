import type { JSONSchema7 } from '@ai-sdk/provider';

export type LanguageModelV1JSONValue =
  | null
  | string
  | number
  | boolean
  | { [key: string]: LanguageModelV1JSONValue }
  | LanguageModelV1JSONValue[];

export type LanguageModelV1ProviderMetadata = Record<
  string,
  Record<string, LanguageModelV1JSONValue>
>;

export interface LanguageModelV1Source {
  sourceType: 'url';
  id: string;
  url: string;
  title?: string;
  providerMetadata?: LanguageModelV1ProviderMetadata;
}

export interface LanguageModelV1CallSettings {
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  responseFormat?:
    { type: 'text' } | { type: 'json'; schema?: JSONSchema7; name?: string; description?: string };
  seed?: number;
  abortSignal?: AbortSignal;
  headers?: Record<string, string | undefined>;
}

export interface LanguageModelV1FunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: JSONSchema7;
}

export interface LanguageModelV1ProviderDefinedTool {
  type: 'provider-defined';
  id: `${string}.${string}`;
  name: string;
  args: Record<string, unknown>;
}

export type LanguageModelV1ToolChoice =
  { type: 'auto' } | { type: 'none' } | { type: 'required' } | { type: 'tool'; toolName: string };

export interface LanguageModelV1TextPart {
  type: 'text';
  text: string;
  providerMetadata?: LanguageModelV1ProviderMetadata;
}

export interface LanguageModelV1ReasoningPart {
  type: 'reasoning';
  text: string;
  signature?: string;
  providerMetadata?: LanguageModelV1ProviderMetadata;
}

export interface LanguageModelV1RedactedReasoningPart {
  type: 'redacted-reasoning';
  data: string;
  providerMetadata?: LanguageModelV1ProviderMetadata;
}

export interface LanguageModelV1ImagePart {
  type: 'image';
  image: Uint8Array | URL;
  mimeType?: string;
  providerMetadata?: LanguageModelV1ProviderMetadata;
}

export interface LanguageModelV1FilePart {
  type: 'file';
  filename?: string;
  data: string | URL;
  mimeType: string;
  providerMetadata?: LanguageModelV1ProviderMetadata;
}

export interface LanguageModelV1ToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: unknown;
  providerMetadata?: LanguageModelV1ProviderMetadata;
}

export interface LanguageModelV1ToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
  content?: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType?: string }
  >;
  providerMetadata?: LanguageModelV1ProviderMetadata;
}

export type LanguageModelV1Message = (
  | { role: 'system'; content: string }
  | {
      role: 'user';
      content: Array<LanguageModelV1TextPart | LanguageModelV1ImagePart | LanguageModelV1FilePart>;
    }
  | {
      role: 'assistant';
      content: Array<
        | LanguageModelV1TextPart
        | LanguageModelV1FilePart
        | LanguageModelV1ReasoningPart
        | LanguageModelV1RedactedReasoningPart
        | LanguageModelV1ToolCallPart
      >;
    }
  | { role: 'tool'; content: Array<LanguageModelV1ToolResultPart> }
) & { providerMetadata?: LanguageModelV1ProviderMetadata };

export type LanguageModelV1Prompt = Array<LanguageModelV1Message>;

export type LanguageModelV1CallOptions = LanguageModelV1CallSettings & {
  inputFormat: 'messages' | 'prompt';
  mode:
    | {
        type: 'regular';
        tools?: Array<LanguageModelV1FunctionTool | LanguageModelV1ProviderDefinedTool>;
        toolChoice?: LanguageModelV1ToolChoice;
      }
    | { type: 'object-json'; schema?: JSONSchema7; name?: string; description?: string }
    | { type: 'object-tool'; tool: LanguageModelV1FunctionTool };
  prompt: LanguageModelV1Prompt;
  providerMetadata?: LanguageModelV1ProviderMetadata;
};

export type LanguageModelV1CallWarning =
  | { type: 'unsupported-setting'; setting: keyof LanguageModelV1CallSettings; details?: string }
  | {
      type: 'unsupported-tool';
      tool: LanguageModelV1FunctionTool | LanguageModelV1ProviderDefinedTool;
      details?: string;
    }
  | { type: 'other'; message: string };

export type LanguageModelV1FinishReason =
  'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown';

export interface LanguageModelV1FunctionToolCall {
  toolCallType: 'function';
  toolCallId: string;
  toolName: string;
  args: string;
}

export type LanguageModelV1LogProbs = Array<{
  token: string;
  logprob: number;
  topLogprobs: Array<{ token: string; logprob: number }>;
}>;

export type LanguageModelV1ObjectGenerationMode = 'json' | 'tool' | undefined;

export interface LanguageModelV1Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface LanguageModelV1GenerateResult {
  text?: string;
  reasoning?:
    | string
    | Array<
        { type: 'text'; text: string; signature?: string } | { type: 'redacted'; data: string }
      >;
  files?: Array<{ data: string | Uint8Array; mimeType: string }>;
  toolCalls?: Array<LanguageModelV1FunctionToolCall>;
  finishReason: LanguageModelV1FinishReason;
  usage: LanguageModelV1Usage;
  rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
  rawResponse?: { headers?: Record<string, string>; body?: unknown };
  request?: { body?: string };
  response?: { id?: string; timestamp?: Date; modelId?: string };
  warnings?: LanguageModelV1CallWarning[];
  providerMetadata?: LanguageModelV1ProviderMetadata;
  sources?: LanguageModelV1Source[];
  logprobs?: LanguageModelV1LogProbs;
}

export type LanguageModelV1StreamPart =
  | { type: 'text-delta'; textDelta: string }
  | { type: 'reasoning'; textDelta: string }
  | { type: 'reasoning-signature'; signature: string }
  | { type: 'redacted-reasoning'; data: string }
  | { type: 'source'; source: LanguageModelV1Source }
  | { type: 'file'; mimeType: string; data: string | Uint8Array }
  | ({ type: 'tool-call' } & LanguageModelV1FunctionToolCall)
  | {
      type: 'tool-call-delta';
      toolCallType: 'function';
      toolCallId: string;
      toolName: string;
      argsTextDelta: string;
    }
  | { type: 'response-metadata'; id?: string; timestamp?: Date; modelId?: string }
  | {
      type: 'finish';
      finishReason: LanguageModelV1FinishReason;
      providerMetadata?: LanguageModelV1ProviderMetadata;
      usage: LanguageModelV1Usage;
      logprobs?: LanguageModelV1LogProbs;
    }
  | { type: 'error'; error: unknown };

export interface LanguageModelV1StreamResult {
  stream: ReadableStream<LanguageModelV1StreamPart>;
  rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
  rawResponse?: { headers?: Record<string, string> };
  request?: { body?: string };
  warnings?: Array<LanguageModelV1CallWarning>;
}

export interface LanguageModelV1 {
  readonly specificationVersion: 'v1';
  readonly provider: string;
  readonly modelId: string;
  readonly defaultObjectGenerationMode: LanguageModelV1ObjectGenerationMode;
  readonly supportsImageUrls?: boolean;
  readonly supportsStructuredOutputs?: boolean;
  supportsUrl?(url: URL): boolean;
  doGenerate(options: LanguageModelV1CallOptions): PromiseLike<LanguageModelV1GenerateResult>;
  doStream(options: LanguageModelV1CallOptions): PromiseLike<LanguageModelV1StreamResult>;
}
