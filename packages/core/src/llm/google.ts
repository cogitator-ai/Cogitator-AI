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

interface GoogleConfig {
  apiKey: string;
  baseUrl?: string;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } }
  | { functionCall: GeminiFunctionCall }
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
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
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
  };
  systemInstruction?: {
    parts: { text: string }[];
  };
}

interface GeminiCandidate {
  content: GeminiContent;
  finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER';
  safetyRatings?: unknown[];
}

interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

interface GeminiResponse {
  candidates: GeminiCandidate[];
  usageMetadata: GeminiUsageMetadata;
}

interface GeminiStreamChunk {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
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

    const response = await fetch(
      `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(geminiRequest),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as GeminiResponse;
    return this.parseResponse(data);
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const { geminiRequest, model } = this.buildRequest(request);

    const response = await fetch(
      `${this.baseUrl}/models/${model}:streamGenerateContent?key=${this.apiKey}&alt=sse`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(geminiRequest),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    const id = this.generateId();
    let buffer = '';
    const accumulatedToolCalls: ToolCall[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;

            try {
              const chunk = JSON.parse(jsonStr) as GeminiStreamChunk;

              if (chunk.candidates?.[0]) {
                const candidate = chunk.candidates[0];
                const parts = candidate.content?.parts ?? [];

                for (const part of parts) {
                  if ('text' in part) {
                    yield {
                      id,
                      delta: { content: part.text },
                    };
                  } else if ('functionCall' in part) {
                    const toolCall: ToolCall = {
                      id: `call_${nanoid(12)}`,
                      name: part.functionCall.name,
                      arguments: part.functionCall.args,
                    };
                    accumulatedToolCalls.push(toolCall);
                  }
                }

                if (candidate.finishReason) {
                  const finishReason = this.mapFinishReason(candidate.finishReason);
                  const streamChunk: ChatStreamChunk = {
                    id,
                    delta: {
                      toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
                    },
                    finishReason,
                  };

                  if (chunk.usageMetadata) {
                    streamChunk.usage = {
                      inputTokens: chunk.usageMetadata.promptTokenCount,
                      outputTokens: chunk.usageMetadata.candidatesTokenCount,
                      totalTokens: chunk.usageMetadata.totalTokenCount,
                    };
                  }

                  yield streamChunk;
                }
              }
            } catch {}
          }
        }
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

    const jsonConfig = this.convertResponseFormat(request.responseFormat);
    if (jsonConfig) {
      geminiRequest.generationConfig.responseMimeType = jsonConfig.responseMimeType;
      if (jsonConfig.responseSchema) {
        geminiRequest.generationConfig.responseSchema = jsonConfig.responseSchema;
      }
    }

    if (Object.keys(geminiRequest.generationConfig).length === 0) {
      delete geminiRequest.generationConfig;
    }

    return { geminiRequest, model };
  }

  private normalizeModel(model: string): string {
    const stripped = model.startsWith('google/') ? model.slice(7) : model;

    const modelMap: Record<string, string> = {
      'gemini-pro': 'gemini-1.5-pro',
      'gemini-flash': 'gemini-1.5-flash',
      'gemini-2-flash': 'gemini-2.0-flash',
    };

    return modelMap[stripped] ?? stripped;
  }

  private convertMessages(messages: Message[]): {
    systemInstruction: string | null;
    contents: GeminiContent[];
  } {
    let systemInstruction: string | null = null;
    const contents: GeminiContent[] = [];

    const pendingToolResults = new Map<string, Message>();

    for (const msg of messages) {
      switch (msg.role) {
        case 'system':
          systemInstruction = this.getTextContent(msg.content);
          break;

        case 'user':
          contents.push({
            role: 'user',
            parts: this.convertContentToParts(msg.content),
          });
          break;

        case 'assistant': {
          const parts = this.convertContentToParts(msg.content);

          if (parts.length > 0 || pendingToolResults.size === 0) {
            contents.push({
              role: 'model',
              parts: parts.length > 0 ? parts : [{ text: '' }],
            });
          }
          break;
        }

        case 'tool': {
          const functionResponse: GeminiFunctionResponse = {
            name: msg.name ?? '',
            response: this.parseToolResult(this.getTextContent(msg.content)),
          };

          contents.push({
            role: 'user',
            parts: [{ functionResponse }],
          });
          break;
        }
      }
    }

    return { systemInstruction, contents };
  }

  private convertContentToParts(content: MessageContent): GeminiPart[] {
    if (typeof content === 'string') {
      return content ? [{ text: content }] : [];
    }

    return content.map((part) => this.convertContentPart(part));
  }

  private convertContentPart(part: ContentPart): GeminiPart {
    switch (part.type) {
      case 'text':
        return { text: part.text };
      case 'image_url':
        return {
          fileData: {
            mimeType: 'image/jpeg',
            fileUri: part.image_url.url,
          },
        };
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
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
      return { result: parsed };
    } catch {
      return { result: content };
    }
  }

  private convertTool(tool: ToolSchema): GeminiFunctionDeclaration {
    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: tool.parameters.properties,
        required: tool.parameters.required,
      },
    };
  }

  private parseResponse(data: GeminiResponse): ChatResponse {
    const candidate = data.candidates[0];
    if (!candidate) {
      throw new Error('No candidates in response');
    }

    const parts = candidate.content?.parts ?? [];
    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const part of parts) {
      if ('text' in part) {
        content += part.text;
      } else if ('functionCall' in part) {
        toolCalls.push({
          id: `call_${nanoid(12)}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args,
        });
      }
    }

    return {
      id: this.generateId(),
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: this.mapFinishReason(candidate.finishReason),
      usage: {
        inputTokens: data.usageMetadata.promptTokenCount,
        outputTokens: data.usageMetadata.candidatesTokenCount,
        totalTokens: data.usageMetadata.totalTokenCount,
      },
    };
  }

  private mapFinishReason(reason: string): 'stop' | 'tool_calls' | 'length' | 'error' {
    switch (reason) {
      case 'STOP':
        return 'stop';
      case 'MAX_TOKENS':
        return 'length';
      case 'SAFETY':
      case 'RECITATION':
      case 'OTHER':
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
      responseSchema: format.jsonSchema.schema,
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
