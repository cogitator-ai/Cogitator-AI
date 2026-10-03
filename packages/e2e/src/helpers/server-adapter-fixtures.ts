import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import { WorkflowBuilder } from '@cogitator-ai/workflows';
import type { Workflow, WorkflowState } from '@cogitator-ai/types';
import { z } from 'zod';
import { getOllamaUrl, getTestModel } from './setup';

export interface TestLLM {
  provider: 'ollama' | 'google';
  model: string;
  createCogitator(): Cogitator;
}

async function ollamaHasModel(model: string): Promise<boolean> {
  try {
    const res = await fetch(`${getOllamaUrl()}/api/tags`);
    if (!res.ok) return false;
    const body = (await res.json()) as { models?: Array<{ name: string }> };
    const wanted = model.includes(':') ? model : `${model}:latest`;
    return (body.models ?? []).some((m) => m.name === wanted || m.name === model);
  } catch {
    return false;
  }
}

export async function resolveTestLLM(): Promise<TestLLM | null> {
  const ollamaModel = getTestModel();
  if (process.env.TEST_OLLAMA === 'true' && (await ollamaHasModel(ollamaModel))) {
    return {
      provider: 'ollama',
      model: `ollama/${ollamaModel}`,
      createCogitator: () =>
        new Cogitator({
          llm: {
            defaultModel: `ollama/${ollamaModel}`,
            providers: { ollama: { baseUrl: getOllamaUrl() } },
          },
          memory: { adapter: 'memory' },
        }),
    };
  }

  const googleKey = process.env.GOOGLE_API_KEY;
  if (googleKey) {
    return {
      provider: 'google',
      model: 'google/gemini-3.5-flash-lite',
      createCogitator: () =>
        new Cogitator({
          llm: {
            defaultModel: 'google/gemini-3.5-flash-lite',
            providers: { google: { apiKey: googleKey } },
          },
          memory: { adapter: 'memory' },
        }),
    };
  }

  return null;
}

export function createOfflineCogitator(): Cogitator {
  const cogitator = new Cogitator({ llm: { defaultModel: `ollama/${getTestModel()}` } });
  cogitator.memory = new InMemoryAdapter({ provider: 'memory' });
  return cogitator;
}

export const multiplyTool = tool({
  name: 'multiply',
  description: 'Multiply two numbers together. Returns the product.',
  parameters: z.object({
    a: z.number().describe('First number'),
    b: z.number().describe('Second number'),
  }),
  execute: async ({ a, b }) => ({ result: a * b }),
});

export function createChatAgent(model: string): Agent {
  return new Agent({
    name: 'chat',
    description: 'Answers short questions',
    instructions: 'You are a concise assistant. Answer in one short sentence.',
    model,
    maxTokens: 256,
    temperature: 0,
  });
}

export function createCalculatorAgent(model: string): Agent {
  return new Agent({
    name: 'calculator',
    description: 'Multiplies numbers with a tool',
    instructions:
      'You are a calculator. Always call the multiply tool to compute products, then state the result.',
    model,
    tools: [multiplyTool],
    maxIterations: 4,
    temperature: 0,
  });
}

function textOf(state: WorkflowState): string {
  return typeof state.text === 'string' ? state.text : '';
}

function stepsOf(state: WorkflowState): string[] {
  return Array.isArray(state.steps) ? state.steps.map(String) : [];
}

export function createPipelineWorkflow(): Workflow<WorkflowState> {
  return new WorkflowBuilder('text-pipeline')
    .initialState({ text: '', steps: [] })
    .addNode('upper', async (ctx) => {
      const text = textOf(ctx.state).toUpperCase();
      return { state: { text, steps: [...stepsOf(ctx.state), 'upper'] }, output: text };
    })
    .addNode(
      'exclaim',
      async (ctx) => {
        const text = `${textOf(ctx.state)}!`;
        return { state: { text, steps: [...stepsOf(ctx.state), 'exclaim'] }, output: text };
      },
      { after: ['upper'] }
    )
    .build();
}

export function createFailingWorkflow(): Workflow<WorkflowState> {
  return new WorkflowBuilder('failing-pipeline')
    .initialState({ text: '' })
    .addNode('explode', async () => {
      throw new Error('database password is hunter2');
    })
    .build();
}

export function createSlowWorkflow(onSecondStep: () => void): Workflow<WorkflowState> {
  return new WorkflowBuilder('slow-pipeline')
    .initialState({ steps: [] })
    .addNode('wait', async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { state: { steps: [...stepsOf(ctx.state), 'wait'] } };
    })
    .addNode(
      'after',
      async (ctx) => {
        onSecondStep();
        return { state: { steps: [...stepsOf(ctx.state), 'after'] } };
      },
      { after: ['wait'] }
    )
    .build();
}

export function parseSSEData(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .map((block) =>
      block
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n')
    )
    .filter((data) => data.length > 0 && data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}
