/**
 * OpenAI-Compatible Chat Completions API
 *
 * This endpoint is compatible with the OpenAI Chat Completions API.
 * You can use the OpenAI SDK pointing to this endpoint:
 *
 * ```typescript
 * import OpenAI from 'openai';
 * const openai = new OpenAI({
 *   baseURL: 'http://localhost:3000/api/v1',
 *   apiKey: 'any-key', // Or leave empty
 * });
 *
 * const response = await openai.chat.completions.create({
 *   model: 'gemma3:4b',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * });
 * ```
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCogitator } from '@/lib/cogitator';
import { Agent } from '@cogitator/core';
import { nanoid } from 'nanoid';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

export async function POST(request: NextRequest) {
  try {
    const body: ChatCompletionRequest = await request.json();
    const { model, messages, temperature = 0.7, max_tokens, stream = false, tools } = body;

    if (!model) {
      return NextResponse.json(
        { error: { message: 'model is required', type: 'invalid_request_error' } },
        { status: 400 }
      );
    }

    if (!messages || messages.length === 0) {
      return NextResponse.json(
        { error: { message: 'messages is required', type: 'invalid_request_error' } },
        { status: 400 }
      );
    }

    const cogitator = await getCogitator();

    const systemMessage = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');

    const lastUserMessage = [...chatMessages].reverse().find(m => m.role === 'user');
    const input = lastUserMessage?.content || '';

    const agent = new Agent({
      id: `openai-compat-${nanoid(8)}`,
      name: 'OpenAI Compatible Agent',
      model,
      instructions: systemMessage?.content || 'You are a helpful assistant.',
      tools: [],
      temperature,
      maxTokens: max_tokens,
    });

    if (stream) {
      const encoder = new TextEncoder();
      const streamResponse = new ReadableStream({
        async start(controller) {
          try {
            const result = await cogitator.run(agent, {
              input: input as string,
            });

            const completionId = `chatcmpl-${nanoid(24)}`;
            const created = Math.floor(Date.now() / 1000);

            const content = result.output;
            const chunks = splitIntoChunks(content, 20);

            for (const chunk of chunks) {
              const data = {
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                  index: 0,
                  delta: { content: chunk },
                  finish_reason: null,
                }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
              await new Promise(r => setTimeout(r, 50));
            }

            const finalData = {
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: 'stop',
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalData)}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          } catch (error) {
            const errorData = {
              error: {
                message: error instanceof Error ? error.message : 'Internal server error',
                type: 'server_error',
              },
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorData)}\n\n`));
            controller.close();
          }
        },
      });

      return new Response(streamResponse, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    } else {
      const result = await cogitator.run(agent, {
        input: input as string,
      });

      const completionId = `chatcmpl-${nanoid(24)}`;
      const created = Math.floor(Date.now() / 1000);

      const response = {
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: result.output,
          },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.totalTokens,
        },
      };

      return NextResponse.json(response);
    }
  } catch (error) {
    console.error('[openai-compat] Error:', error);
    return NextResponse.json(
      {
        error: {
          message: error instanceof Error ? error.message : 'Internal server error',
          type: 'server_error',
        },
      },
      { status: 500 }
    );
  }
}

function splitIntoChunks(text: string, maxChunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChunkSize) {
    chunks.push(text.slice(i, i + maxChunkSize));
  }
  return chunks;
}

