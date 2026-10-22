import { describe, it } from 'vitest';
import {
  anthropicWire,
  backendConformanceCases,
  bedrockConverseWire,
  geminiWire,
  ollamaWire,
  openAIChatWire,
  openAIResponsesWire,
  type BackendConformanceTarget,
} from '@cogitator-ai/test-utils';
import { createLLMBackend } from '../llm';
import { AzureOpenAIBackend } from '../llm/azure';
import { OpenAIBackend } from '../llm/openai';

const headers = { 'x-conformance': 'on' };

const targets: BackendConformanceTarget[] = [
  {
    name: 'OpenAI Chat Completions',
    wire: openAIChatWire,
    model: 'conformance-model',
    headers,
    createBackend: (url) =>
      createLLMBackend('openai', {
        providers: { openai: { apiKey: 'sk-conformance', baseUrl: `${url}/v1`, headers } },
      }),
  },
  {
    name: 'OpenAI Responses',
    wire: openAIResponsesWire,
    model: 'conformance-model',
    headers,
    createBackend: (url) =>
      createLLMBackend('openai', {
        providers: {
          openai: { apiKey: 'sk-conformance', baseUrl: `${url}/v1`, api: 'responses', headers },
        },
      }),
  },
  {
    name: 'OpenRouter',
    wire: openAIChatWire,
    model: 'vendor/conformance-model',
    headers,
    createBackend: (url) =>
      createLLMBackend('openrouter', {
        providers: { openrouter: { apiKey: 'or-conformance', baseUrl: `${url}/api/v1`, headers } },
      }),
  },
  {
    name: 'Mistral profile',
    wire: openAIChatWire,
    model: 'mistral-conformance',
    createBackend: (url) =>
      new OpenAIBackend({ apiKey: 'k', baseUrl: `${url}/v1`, provider: 'mistral', maxRetries: 0 }),
  },
  {
    name: 'Azure OpenAI',
    wire: openAIChatWire,
    model: 'conformance-deployment',
    createBackend: (url) =>
      new AzureOpenAIBackend({ endpoint: url, apiKey: 'azure-conformance', maxRetries: 0 }),
  },
  {
    name: 'Anthropic',
    wire: anthropicWire,
    model: 'claude-conformance',
    headers,
    createBackend: (url) =>
      createLLMBackend('anthropic', {
        providers: { anthropic: { apiKey: 'sk-ant-conformance', baseUrl: url, headers } },
      }),
  },
  {
    name: 'Google Gemini',
    wire: geminiWire,
    model: 'gemini-conformance',
    headers,
    createBackend: (url) =>
      createLLMBackend('google', {
        providers: { google: { apiKey: 'g-conformance', baseUrl: `${url}/v1beta`, headers } },
      }),
  },
  {
    name: 'Ollama',
    wire: ollamaWire,
    model: 'llama-conformance',
    headers,
    createBackend: (url) =>
      createLLMBackend('ollama', { providers: { ollama: { baseUrl: url, headers } } }),
  },
  {
    name: 'Bedrock',
    wire: bedrockConverseWire,
    model: 'anthropic.claude-conformance-v1:0',
    http2: true,
    createBackend: (url) =>
      createLLMBackend('bedrock', {
        providers: {
          bedrock: {
            region: 'us-east-1',
            accessKeyId: 'AKIACONFORMANCE',
            secretAccessKey: 'conformance-secret',
            endpoint: url,
          },
        },
      }),
  },
];

describe.each(targets)('$name backend conformance', (target) => {
  for (const conformance of backendConformanceCases(target)) {
    if (conformance.skip) it.skip(`${conformance.name}: ${conformance.skip}`, () => undefined);
    else it(conformance.name, () => conformance.run(), 10_000);
  }
});
