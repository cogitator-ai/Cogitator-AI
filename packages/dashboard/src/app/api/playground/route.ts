import { NextResponse } from 'next/server';
import { getCogitator, createAgentFromConfig, getToolByName } from '@/lib/cogitator';
import {
  createRun,
  completeRun,
  createThread,
  getThread,
  incrementAgentStats,
} from '@/lib/cogitator/db';
import { nanoid } from 'nanoid';
import { withAuth } from '@/lib/auth/middleware';
import { withRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PlaygroundRequest {
  model: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  tools?: string[];
  threadId?: string;
  agentId?: string;
}

function buildModelString(model: string): string {
  if (model.includes('/')) return model;

  if (model.includes('gpt') || model.includes('o1') || model.includes('o3')) {
    return `openai/${model}`;
  }
  if (model.includes('claude')) {
    return `anthropic/${model}`;
  }
  if (model.includes('gemini')) {
    return `google/${model}`;
  }

  return `ollama/${model}`;
}

export const POST = withAuth(withRateLimit(RATE_LIMITS.playground, async (request) => {
  try {
    const body: PlaygroundRequest = await request.json();
    const {
      model,
      messages,
      temperature = 0.7,
      tools = [],
      threadId,
      agentId,
    } = body;

    if (!model || !messages || messages.length === 0) {
      return NextResponse.json({ error: 'Model and messages required' }, { status: 400 });
    }

    const userMessages = messages.filter((m) => m.role === 'user');
    const input = userMessages[userMessages.length - 1]?.content || '';

    const systemMessage = messages.find((m) => m.role === 'system');
    const instructions = systemMessage?.content || 'You are a helpful assistant.';

    const cogitator = await getCogitator();

    const selectedTools = tools
      .map((name) => getToolByName(name))
      .filter((t): t is NonNullable<typeof t> => t !== undefined);

    const modelString = buildModelString(model);

    const agent = createAgentFromConfig({
      id: agentId || `playground_${nanoid(8)}`,
      name: 'Playground Agent',
      model: modelString,
      instructions,
      tools: selectedTools as Parameters<typeof createAgentFromConfig>[0]['tools'],
      temperature,
      maxIterations: 5,
    });

    const actualThreadId = threadId || `thread_${nanoid(12)}`;
    const existingThread = await getThread(actualThreadId).catch(() => null);
    if (!existingThread) {
      await createThread({
        id: actualThreadId,
        agentId: agent.id,
        title: input.slice(0, 50),
      }).catch(() => {
      });
    }

    const runId = `run_${nanoid(12)}`;
    await createRun({
      id: runId,
      agentId: agent.id,
      threadId: actualThreadId,
      input,
    }).catch(() => {
    });

    const encoder = new TextEncoder();
    let _fullContent = '';
    const allToolCalls: {
      id: string;
      name: string;
      arguments: unknown;
      result?: unknown;
    }[] = [];

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const result = await cogitator.run(agent, {
            input,
            threadId: actualThreadId,
            stream: true,
            useMemory: true,
            saveHistory: true,
            onToken: (token: string) => {
              _fullContent += token;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ content: token })}\n\n`)
              );
            },
            onToolCall: (toolCall) => {
              allToolCalls.push({
                id: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments,
              });
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    toolCall: {
                      id: toolCall.id,
                      name: toolCall.name,
                      arguments: toolCall.arguments,
                    },
                  })}\n\n`
                )
              );
            },
            onToolResult: (toolResult) => {
              const tc = allToolCalls.find((t) => t.id === toolResult.callId);
              if (tc) tc.result = toolResult.result;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    toolResult: {
                      callId: toolResult.callId,
                      name: toolResult.name,
                      result: toolResult.result,
                      error: toolResult.error,
                    },
                  })}\n\n`
                )
              );
            },
          });

          await completeRun(runId, {
            status: 'completed',
            output: result.output,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cost: result.usage.cost,
            duration: result.usage.duration,
            iterations: result.toolCalls.length + 1,
            trace: result.trace,
          }).catch(() => {});

          if (agentId) {
            await incrementAgentStats(
              agentId,
              result.usage.totalTokens,
              result.usage.cost
            ).catch(() => {});
          }

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                done: true,
                runId: result.runId,
                threadId: result.threadId,
                usage: result.usage,
                toolCalls: allToolCalls,
              })}\n\n`
            )
          );
          controller.close();
        } catch (error) {
          console.error('[playground] Run error:', error);

          await completeRun(runId, {
            status: 'failed',
            inputTokens: 0,
            outputTokens: 0,
            cost: 0,
            duration: 0,
            iterations: 0,
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => {});

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                error: error instanceof Error ? error.message : 'Run failed',
              })}\n\n`
            )
          );
          controller.close();
        }
      },
    });

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error('[playground] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to process request' },
      { status: 500 }
    );
  }
}));
