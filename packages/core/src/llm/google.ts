/**
 * Google Gemini LLM Backend
 *
 * Implements the Gemini API with full support for:
 * - Chat completions
 * - Tool/function calling
 * - Streaming responses
 * - Token counting
 */

import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ChatUsage,
  FinishReason,
  ReasoningConfig,
  ReasoningEffort,
  ToolCall,
  ToolChoice,
  Message,
  ToolSchema,
  LLMResponseFormat,
  MessageContent,
  ContentPart,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import { BaseLLMBackend } from './base';
import {
  createLLMError,
  retryAfterFromHeaders,
  llmUnavailable,
  llmInvalidResponse,
  type LLMErrorContext,
} from './errors';
import { getLogger } from '../logger';
import { jsonInstruction } from './json-instruction';
import { normalizeTurn } from './turn';

interface GoogleConfig {
  apiKey: string;
  baseUrl?: string;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } }
  | { functionCall: GeminiFunctionCall; thoughtSignature?: string }
  | { functionResponse: GeminiFunctionResponse };

interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

interface GeminiFunctionResponse {
  name: string;
  response: Record<string, unknown>;
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** JSON Schema form of the parameters, which unlike `parameters` can hold `$ref` and `$defs` */
  parametersJsonSchema?: Record<string, unknown>;
}

interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

interface GeminiToolConfig {
  functionCallingConfig: {
    mode: 'AUTO' | 'ANY' | 'NONE';
    allowedFunctionNames?: string[];
  };
}

interface GeminiRequest {
  contents: GeminiContent[];
  tools?: GeminiTool[];
  toolConfig?: GeminiToolConfig;
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    responseMimeType?: string;
    responseSchema?: Record<string, unknown>;
    thinkingConfig?: GeminiThinkingConfig;
  };
  systemInstruction?: {
    parts: { text: string }[];
  };
  safetySettings?: Array<{ category: string; threshold: string }>;
}

interface GeminiCandidate {
  content: GeminiContent;
  /** `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `MALFORMED_FUNCTION_CALL` and others */
  finishReason?: string;
  /** Why the turn ended, for some finish reasons such as `MALFORMED_FUNCTION_CALL` */
  finishMessage?: string;
  safetyRatings?: unknown[];
}

interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount?: number;
  totalTokenCount: number;
  /** Reasoning tokens; billed as output but not part of `candidatesTokenCount` */
  thoughtsTokenCount?: number;
  /** Prompt tokens served from the context cache; part of `promptTokenCount` */
  cachedContentTokenCount?: number;
}

interface GeminiThinkingConfig {
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
  thinkingBudget?: number;
  includeThoughts?: boolean;
}

interface GeminiPromptFeedback {
  blockReason?: string;
  blockReasonMessage?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  promptFeedback?: GeminiPromptFeedback;
}

interface GeminiStreamChunk {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  promptFeedback?: GeminiPromptFeedback;
}

export class GoogleBackend extends BaseLLMBackend {
  readonly provider = 'google' as const;
  private apiKey: string;
  private baseUrl: string;

  constructor(config: GoogleConfig) {
    super();
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { geminiRequest, model } = this.buildRequest(request);
    const endpoint = `${this.baseUrl}/models/${model}:generateContent`;
    const ctx: LLMErrorContext = {
      provider: this.provider,
      model: request.model,
      endpoint,
    };

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(geminiRequest),
        signal: request.signal,
      });
    } catch (e) {
      throw llmUnavailable(
        ctx,
        'Failed to connect to Gemini API',
        e instanceof Error ? e : undefined
      );
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw createLLMError(ctx, response.status, errorBody, {
        retryAfterOverride: retryAfterFromHeaders(response.headers),
      });
    }

    const data = (await response.json()) as GeminiResponse;
    return this.parseResponse(data, ctx);
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const { geminiRequest, model } = this.buildRequest(request);
    const endpoint = `${this.baseUrl}/models/${model}:streamGenerateContent`;
    const ctx: LLMErrorContext = {
      provider: this.provider,
      model: request.model,
      endpoint,
    };

    let response: Response;
    try {
      response = await fetch(`${endpoint}?alt=sse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(geminiRequest),
        signal: request.signal,
      });
    } catch (e) {
      throw llmUnavailable(
        ctx,
        'Failed to connect to Gemini API',
        e instanceof Error ? e : undefined
      );
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw createLLMError(ctx, response.status, errorBody, {
        retryAfterOverride: retryAfterFromHeaders(response.headers),
      });
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw llmInvalidResponse(ctx, 'No response body from stream');
    }

    const decoder = new TextDecoder();
    const id = this.generateId();
    let buffer = '';
    const accumulatedToolCalls: ToolCall[] = [];
    const mapFinish = this.mapFinishReason.bind(this);
    const promptBlockedError = (feedback: GeminiPromptFeedback) =>
      this.promptBlockedError(ctx, feedback);

    function* processLine(line: string) {
      if (!line.startsWith('data: ')) return;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === '[DONE]') return;

      let chunk: GeminiStreamChunk;
      try {
        chunk = JSON.parse(jsonStr) as GeminiStreamChunk;
      } catch (e) {
        getLogger().warn('Failed to parse stream chunk in Google backend', {
          json: jsonStr.slice(0, 200),
          error: e instanceof Error ? e.message : String(e),
        });
        return;
      }

      if (!chunk.candidates?.length && chunk.promptFeedback?.blockReason) {
        throw promptBlockedError(chunk.promptFeedback);
      }

      if (chunk.candidates?.[0]) {
        const candidate = chunk.candidates[0];
        const parts = candidate.content?.parts ?? [];

        for (const part of parts) {
          if ('text' in part) {
            if (part.thought) {
              if (part.text) yield { id, delta: { reasoning: part.text } };
              continue;
            }
            yield {
              id,
              delta: { content: part.text },
            } as ChatStreamChunk;
          } else if ('functionCall' in part) {
            accumulatedToolCalls.push(toToolCall(part));
          }
        }

        if (candidate.finishReason) {
          const end = normalizeTurn({
            finishReason: mapFinish(candidate.finishReason),
            toolCalls: accumulatedToolCalls,
          });
          const streamChunk: ChatStreamChunk = {
            id,
            delta: { toolCalls: end.toolCalls },
            finishReason: end.finishReason,
            ...(candidate.finishMessage && { finishMessage: candidate.finishMessage }),
          };

          if (chunk.usageMetadata) {
            streamChunk.usage = toChatUsage(chunk.usageMetadata);
          }

          yield streamChunk;
        }
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          yield* processLine(line);
        }
      }

      if (buffer.trim()) {
        yield* processLine(buffer);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private buildRequest(request: ChatRequest): {
    geminiRequest: GeminiRequest;
    model: string;
  } {
    const model = this.normalizeModel(request.model);
    const { systemInstruction, contents } = this.convertMessages(request.messages);

    const geminiRequest: GeminiRequest = {
      contents,
    };

    if (systemInstruction) {
      geminiRequest.systemInstruction = {
        parts: [{ text: systemInstruction }],
      };
    }

    if (request.tools && request.tools.length > 0) {
      geminiRequest.tools = [
        {
          functionDeclarations: request.tools.map((t) => this.convertTool(t)),
        },
      ];
    }

    const toolConfig = this.convertToolChoice(request.toolChoice);
    if (toolConfig) {
      geminiRequest.toolConfig = toolConfig;
    }

    geminiRequest.generationConfig = {};

    if (request.temperature !== undefined) {
      geminiRequest.generationConfig.temperature = request.temperature;
    }
    if (request.topP !== undefined) {
      geminiRequest.generationConfig.topP = request.topP;
    }
    if (request.maxTokens !== undefined) {
      geminiRequest.generationConfig.maxOutputTokens = request.maxTokens;
    }
    if (request.stop !== undefined) {
      geminiRequest.generationConfig.stopSequences = request.stop;
    }
    const thinkingConfig = geminiThinkingConfig(model, request.reasoning);
    if (thinkingConfig) {
      geminiRequest.generationConfig.thinkingConfig = thinkingConfig;
    }

    const jsonConfig = this.convertResponseFormat(request.responseFormat);
    if (jsonConfig && request.tools?.length && !supportsJsonModeWithTools(model)) {
      const instruction = jsonInstruction(jsonConfig.responseSchema);
      geminiRequest.systemInstruction = {
        parts: [
          { text: systemInstruction ? `${systemInstruction}\n\n${instruction}` : instruction },
        ],
      };
    } else if (jsonConfig) {
      geminiRequest.generationConfig.responseMimeType = jsonConfig.responseMimeType;
      if (jsonConfig.responseSchema) {
        geminiRequest.generationConfig.responseSchema = jsonConfig.responseSchema;
      }
    }

    if (Object.keys(geminiRequest.generationConfig).length === 0) {
      delete geminiRequest.generationConfig;
    }

    geminiRequest.safetySettings = [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ];

    return { geminiRequest, model };
  }

  private normalizeModel(model: string): string {
    const stripped = model.startsWith('google/') ? model.slice(7) : model;

    const modelMap: Record<string, string> = {
      default: 'gemini-3.8-flash',
      'gemini-pro': 'gemini-3.1-pro-preview',
      'gemini-flash': 'gemini-3.8-flash',
      'gemini-flash-lite': 'gemini-3.5-flash-lite',
      'gemini-3-pro': 'gemini-3.1-pro-preview',
      'gemini-3.1-pro': 'gemini-3.1-pro-preview',
      'gemini-3-flash': 'gemini-3.8-flash',
      'gemini-3-flash-lite': 'gemini-3.5-flash-lite',
      'gemini-2-flash': 'gemini-2.5-flash',
    };

    return modelMap[stripped] ?? stripped;
  }

  private convertMessages(messages: Message[]): {
    systemInstruction: string | null;
    contents: GeminiContent[];
  } {
    const systemParts: string[] = [];
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      switch (msg.role) {
        case 'system': {
          const text = this.getTextContent(msg.content);
          if (text) systemParts.push(text);
          break;
        }

        case 'user':
          contents.push({
            role: 'user',
            parts: this.convertContentToParts(msg.content),
          });
          break;

        case 'assistant': {
          const parts = this.convertContentToParts(msg.content);
          const toolCalls = (msg as Message & { toolCalls?: ToolCall[] }).toolCalls;
          if (toolCalls && toolCalls.length > 0) {
            parts.push(
              ...toolCalls.map((tc): GeminiPart => ({
                functionCall: {
                  name: tc.name,
                  args: tc.arguments,
                },
                ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
              }))
            );
          }
          contents.push({
            role: 'model',
            parts: parts.length > 0 ? parts : [{ text: '' }],
          });
          break;
        }

        case 'tool': {
          const functionResponse: GeminiFunctionResponse = {
            name: msg.name ?? '',
            response: this.parseToolResult(this.getTextContent(msg.content)),
          };

          const images =
            typeof msg.content === 'string'
              ? []
              : msg.content
                  .filter((part) => part.type !== 'text')
                  .map((part) => this.convertContentPart(part));

          const previous = contents[contents.length - 1];
          if (previous?.role === 'user' && isToolResponseTurn(previous.parts)) {
            const firstImage = previous.parts.findIndex((part) => !('functionResponse' in part));
            const at = firstImage === -1 ? previous.parts.length : firstImage;
            previous.parts.splice(at, 0, { functionResponse });
            previous.parts.push(...images);
          } else {
            contents.push({
              role: 'user',
              parts: [{ functionResponse }, ...images],
            });
          }
          break;
        }
      }
    }

    return {
      systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : null,
      contents,
    };
  }

  private convertContentToParts(content: MessageContent): GeminiPart[] {
    if (typeof content === 'string') {
      return content ? [{ text: content }] : [];
    }

    if (!Array.isArray(content)) {
      return [{ text: String(content ?? '') }];
    }

    return content.map((part) => this.convertContentPart(part));
  }

  private convertContentPart(part: ContentPart): GeminiPart {
    switch (part.type) {
      case 'text':
        return { text: part.text };
      case 'image_url': {
        const url = part.image_url.url;
        if (url.startsWith('data:')) {
          const match = /^data:([^;]+);base64,(.+)$/.exec(url);
          if (match) {
            return { inlineData: { mimeType: match[1], data: match[2] } };
          }
        }
        return { fileData: { mimeType: 'image/jpeg', fileUri: url } };
      }
      case 'image_base64':
        return {
          inlineData: {
            mimeType: part.image_base64.media_type,
            data: part.image_base64.data,
          },
        };
    }
  }

  private getTextContent(content: MessageContent): string {
    if (typeof content === 'string') {
      return content;
    }
    return content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ');
  }

  private parseToolResult(content: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(content) as unknown;
      return isJsonObject(parsed) ? parsed : { result: parsed };
    } catch {
      return { result: content };
    }
  }

  /**
   * A tool for Gemini. Parameters go in the OpenAPI subset of `parameters`, unless the schema is
   * recursive: then they go in `parametersJsonSchema`, the JSON Schema form that keeps `$defs`
   * and `$ref`, since `parameters` has no way to refer to a definition.
   */
  private convertTool(tool: ToolSchema): GeminiFunctionDeclaration {
    if (tool.parameters.$defs !== undefined || hasRef(tool.parameters)) {
      return {
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: cleanJsonSchemaForGemini(tool.parameters),
      };
    }
    return {
      name: tool.name,
      description: tool.description,
      parameters: this.cleanSchemaForGemini({
        type: 'object',
        properties: tool.parameters.properties,
        required: tool.parameters.required,
      }) as GeminiFunctionDeclaration['parameters'],
    };
  }

  private static readonly GEMINI_ALLOWED_KEYS = new Set([
    'type',
    'description',
    'properties',
    'required',
    'items',
    'enum',
    'nullable',
    'format',
    'minimum',
    'maximum',
    'minItems',
    'maxItems',
    'anyOf',
    'oneOf',
  ]);

  private cleanSchemaForGemini(
    schema: Record<string, unknown>,
    isPropertiesMap = false
  ): Record<string, unknown> {
    const source = isPropertiesMap ? schema : nullableForGemini(schema);
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (!isPropertiesMap && !GoogleBackend.GEMINI_ALLOWED_KEYS.has(key)) continue;
      if (Array.isArray(value)) {
        cleaned[key] = value.map((item) =>
          item !== null && typeof item === 'object'
            ? this.cleanSchemaForGemini(item as Record<string, unknown>)
            : item
        );
      } else if (value !== null && typeof value === 'object') {
        cleaned[key] = this.cleanSchemaForGemini(
          value as Record<string, unknown>,
          key === 'properties'
        );
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  private parseResponse(data: GeminiResponse, ctx: LLMErrorContext): ChatResponse {
    const candidate = data.candidates?.[0];
    if (!candidate) {
      if (data.promptFeedback?.blockReason) {
        throw this.promptBlockedError(ctx, data.promptFeedback);
      }
      throw llmInvalidResponse(ctx, 'No candidates in Gemini response');
    }

    const parts = candidate.content?.parts ?? [];
    let content = '';
    let reasoning = '';
    const toolCalls: ToolCall[] = [];

    for (const part of parts) {
      if ('text' in part) {
        if (part.thought) {
          reasoning += part.text;
          continue;
        }
        content += part.text;
      } else if ('functionCall' in part) {
        toolCalls.push(toToolCall(part));
      }
    }

    return normalizeTurn({
      id: this.generateId(),
      content,
      toolCalls,
      finishReason: this.mapFinishReason(candidate.finishReason),
      ...(candidate.finishMessage && { finishMessage: candidate.finishMessage }),
      usage: data.usageMetadata
        ? toChatUsage(data.usageMetadata)
        : { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      ...(reasoning && { reasoning }),
    });
  }

  private promptBlockedError(ctx: LLMErrorContext, feedback: GeminiPromptFeedback) {
    const reason = feedback.blockReasonMessage ?? feedback.blockReason ?? 'unknown reason';
    return llmInvalidResponse(ctx, `Gemini blocked the prompt: ${reason}`);
  }

  /**
   * Gemini's finish reason as a Cogitator one. Whether the turn runs tools is settled by
   * `normalizeTurn` from its function calls.
   */
  private mapFinishReason(reason: string | undefined): FinishReason {
    switch (reason) {
      case 'MAX_TOKENS':
        return 'length';
      case 'SAFETY':
      case 'RECITATION':
      case 'BLOCKLIST':
      case 'PROHIBITED_CONTENT':
      case 'SPII':
      case 'IMAGE_SAFETY':
      case 'IMAGE_PROHIBITED_CONTENT':
      case 'IMAGE_RECITATION':
        return 'content_filter';
      case 'OTHER':
      case 'LANGUAGE':
      case 'MALFORMED_FUNCTION_CALL':
      case 'UNEXPECTED_TOOL_CALL':
      case 'TOO_MANY_TOOL_CALLS':
      case 'NO_IMAGE':
      case 'IMAGE_OTHER':
        return 'error';
      default:
        return 'stop';
    }
  }

  private convertResponseFormat(
    format: LLMResponseFormat | undefined
  ): { responseMimeType: string; responseSchema?: Record<string, unknown> } | null {
    if (!format || format.type === 'text') {
      return null;
    }

    if (format.type === 'json_object') {
      return { responseMimeType: 'application/json' };
    }

    return {
      responseMimeType: 'application/json',
      responseSchema: this.cleanSchemaForGemini(format.jsonSchema.schema),
    };
  }

  private convertToolChoice(choice: ToolChoice | undefined): GeminiToolConfig | null {
    if (!choice) return null;

    if (typeof choice === 'string') {
      switch (choice) {
        case 'auto':
          return { functionCallingConfig: { mode: 'AUTO' } };
        case 'none':
          return { functionCallingConfig: { mode: 'NONE' } };
        case 'required':
          return { functionCallingConfig: { mode: 'ANY' } };
      }
    }

    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [choice.function.name],
      },
    };
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Gemini 1.x and 2.x refuse a JSON response mime type together with function
 * calling; Gemini 3 accepts both in one request.
 */
function supportsJsonModeWithTools(model: string): boolean {
  return !/^gemini-[12](\.|-|$)/.test(model);
}

function toToolCall(part: {
  functionCall: GeminiFunctionCall;
  thoughtSignature?: string;
}): ToolCall {
  const toolCall: ToolCall = {
    id: `call_${nanoid(12)}`,
    name: part.functionCall.name,
    arguments: part.functionCall.args ?? {},
  };
  if (part.thoughtSignature) {
    toolCall.thoughtSignature = part.thoughtSignature;
  }
  return toolCall;
}

/**
 * Gemini counts reasoning (`thoughtsTokenCount`) apart from the answer
 * (`candidatesTokenCount`) but bills both as output.
 */
function toChatUsage(meta: GeminiUsageMetadata): ChatUsage {
  const thoughts = meta.thoughtsTokenCount ?? 0;
  const outputTokens = (meta.candidatesTokenCount ?? 0) + thoughts;
  return {
    inputTokens: meta.promptTokenCount,
    outputTokens,
    totalTokens: meta.totalTokenCount || meta.promptTokenCount + outputTokens,
    ...(meta.cachedContentTokenCount ? { cachedInputTokens: meta.cachedContentTokenCount } : {}),
    ...(thoughts > 0 ? { reasoningTokens: thoughts } : {}),
  };
}

const GEMINI_VERSION = /gemini-(\d+)(?:\.(\d+))?/i;
const GEMINI_THINKING_LEVELS: Readonly<
  Record<ReasoningEffort, NonNullable<GeminiThinkingConfig['thinkingLevel']>>
> = {
  none: 'minimal',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};
const GEMINI_THINKING_BUDGETS: Readonly<Record<ReasoningEffort, number>> = {
  none: 0,
  minimal: 512,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 24576,
  max: 32768,
};

/**
 * `thinkingConfig` for a reasoning config: Gemini 3+ takes a thinking level,
 * Gemini 2.5 a token budget (Pro cannot think less than 128 tokens). Older
 * models do not think.
 */
export function geminiThinkingConfig(
  model: string,
  reasoning: ReasoningConfig | undefined
): GeminiThinkingConfig | undefined {
  if (!reasoning) return undefined;
  const match = GEMINI_VERSION.exec(model);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  const includeThoughts = reasoning.summary ? { includeThoughts: true } : {};

  if (major >= 3) {
    if (reasoning.effort) {
      return { thinkingLevel: GEMINI_THINKING_LEVELS[reasoning.effort], ...includeThoughts };
    }
    if (reasoning.budgetTokens !== undefined) {
      return { thinkingBudget: reasoning.budgetTokens, ...includeThoughts };
    }
    return reasoning.summary ? { includeThoughts: true } : undefined;
  }
  if (major === 2 && minor >= 5) {
    const budget =
      reasoning.budgetTokens ??
      (reasoning.effort ? GEMINI_THINKING_BUDGETS[reasoning.effort] : undefined);
    if (budget === undefined) return reasoning.summary ? { includeThoughts: true } : undefined;
    const floor = /pro/i.test(model) ? 128 : 0;
    return { thinkingBudget: Math.max(floor, budget), ...includeThoughts };
  }
  return undefined;
}

/**
 * A user turn of function responses, followed by the images those tool
 * results returned: Gemini reads them after the responses of the turn.
 */
function isToolResponseTurn(parts: GeminiPart[]): boolean {
  return (
    parts.length > 0 &&
    'functionResponse' in parts[0] &&
    parts.every((part) => 'functionResponse' in part || 'inlineData' in part || 'fileData' in part)
  );
}

const isNullSchema = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'null';

/**
 * Gemini's schema has no `null` type: a JSON Schema null in a `type` array
 * or in `anyOf`/`oneOf` (what Zod's `.nullable()` produces) becomes
 * `nullable: true` on the rest.
 */
function nullableForGemini(schema: Record<string, unknown>): Record<string, unknown> {
  const { type } = schema;
  if (Array.isArray(type) && type.includes('null')) {
    const types = type.filter((t) => t !== 'null');
    const { type: _type, ...rest } = schema;
    if (types.length === 0) return { ...rest, nullable: true };
    if (types.length === 1) return { ...rest, type: types[0], nullable: true };
    return { ...rest, anyOf: types.map((t) => ({ type: t })), nullable: true };
  }

  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = schema[key];
    if (!Array.isArray(options) || !options.some(isNullSchema)) continue;
    const rest = Object.fromEntries(Object.entries(schema).filter(([k]) => k !== key));
    const remaining = options.filter((option) => !isNullSchema(option));
    if (remaining.length === 1 && typeof remaining[0] === 'object' && remaining[0] !== null) {
      return nullableForGemini({
        ...(remaining[0] as Record<string, unknown>),
        ...rest,
        nullable: true,
      });
    }
    return { ...rest, [key]: remaining, nullable: true };
  }

  return schema;
}

const GEMINI_JSON_SCHEMA_KEYS = new Set([
  '$id',
  '$defs',
  '$ref',
  '$anchor',
  'type',
  'format',
  'title',
  'description',
  'enum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'anyOf',
  'oneOf',
  'properties',
  'additionalProperties',
  'required',
]);

const GEMINI_SCHEMA_MAPS = new Set(['properties', '$defs']);

/** A JSON Schema reduced to the keywords Gemini's `parametersJsonSchema` accepts. */
function cleanJsonSchemaForGemini(schema: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(withJsonSchemaNull(schema))) {
    if (!GEMINI_JSON_SCHEMA_KEYS.has(key)) continue;
    if (GEMINI_SCHEMA_MAPS.has(key) && isJsonObject(value)) {
      cleaned[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          isJsonObject(child) ? cleanJsonSchemaForGemini(child) : child,
        ])
      );
    } else if (Array.isArray(value)) {
      cleaned[key] = value.map((item) =>
        isJsonObject(item) ? cleanJsonSchemaForGemini(item) : item
      );
    } else if (isJsonObject(value)) {
      cleaned[key] = cleanJsonSchemaForGemini(value);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/** OpenAPI's `nullable: true` written as JSON Schema: `null` among the types. */
function withJsonSchemaNull(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.nullable !== true) return schema;
  const { nullable: _nullable, ...rest } = schema;
  if (typeof rest.type === 'string') return { ...rest, type: [rest.type, 'null'] };
  if (Array.isArray(rest.type)) {
    return rest.type.includes('null') ? rest : { ...rest, type: [...rest.type, 'null'] };
  }
  return { anyOf: [rest, { type: 'null' }] };
}

function hasRef(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasRef);
  if (!isJsonObject(node)) return false;
  if (typeof node.$ref === 'string') return true;
  return Object.values(node).some(hasRef);
}
