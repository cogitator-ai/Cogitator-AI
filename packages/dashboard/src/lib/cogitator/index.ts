/**
 * Cogitator Singleton Instance for Dashboard
 *
 * Provides a singleton instance of Cogitator runtime with:
 * - PostgreSQL + Redis memory
 * - All LLM backends (Ollama, OpenAI, Anthropic, Google)
 * - Tool registry with built-in tools
 */

import {
  Cogitator,
  Agent,
  tool,
  ToolRegistry,
  builtinTools,
} from '@cogitator/core';
import type {
  CogitatorConfig,
  AgentConfig,
  LLMProvider,
} from '@cogitator/types';

let cogitatorInstance: Cogitator | null = null;
let isInitializing = false;
let initPromise: Promise<Cogitator> | null = null;

export interface DashboardConfig {
  llm: {
    ollama?: { baseUrl: string };
    openai?: { apiKey: string };
    anthropic?: { apiKey: string };
    google?: { apiKey: string };
    defaultProvider: LLMProvider;
  };
  memory: {
    redis?: { url: string };
    postgres?: { connectionString: string };
    adapter: 'memory' | 'redis' | 'postgres';
  };
}

function buildCogitatorConfig(): CogitatorConfig {
  const config: CogitatorConfig = {
    llm: {
      defaultProvider: 'ollama',
      providers: {},
    },
    memory: {
      adapter: 'memory',
    },
  };

  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  config.llm!.providers!.ollama = { baseUrl: ollamaUrl };

  if (process.env.OPENAI_API_KEY) {
    config.llm!.providers!.openai = {
      apiKey: process.env.OPENAI_API_KEY,
    };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    config.llm!.providers!.anthropic = {
      apiKey: process.env.ANTHROPIC_API_KEY,
    };
  }

  if (process.env.GOOGLE_API_KEY) {
    config.llm!.providers!.google = {
      apiKey: process.env.GOOGLE_API_KEY,
    };
  }

  const postgresUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  const redisUrl = process.env.REDIS_URL;

  if (postgresUrl) {
    config.memory = {
      adapter: 'postgres',
      postgres: {
        connectionString: postgresUrl,
      },
      contextBuilder: {
        maxTokens: 8000,
        strategy: 'recent',
      },
    };
  } else if (redisUrl) {
    config.memory = {
      adapter: 'redis',
      redis: {
        url: redisUrl,
      },
      contextBuilder: {
        maxTokens: 8000,
        strategy: 'recent',
      },
    };
  } else {
    config.memory = {
      adapter: 'memory',
      inMemory: {
        maxEntries: 1000,
      },
      contextBuilder: {
        maxTokens: 8000,
        strategy: 'recent',
      },
    };
  }

  return config;
}

export async function getCogitator(): Promise<Cogitator> {
  if (cogitatorInstance) {
    return cogitatorInstance;
  }

  if (isInitializing && initPromise) {
    return initPromise;
  }

  isInitializing = true;
  initPromise = (async () => {
    try {
      const config = buildCogitatorConfig();
      cogitatorInstance = new Cogitator(config);

      for (const t of builtinTools) {
        cogitatorInstance.tools.register(t as Parameters<typeof cogitatorInstance.tools.register>[0]);
      }

      console.log('[cogitator] Singleton initialized with config:', {
        llmProviders: Object.keys(config.llm?.providers || {}),
        memoryAdapter: config.memory?.adapter,
      });

      return cogitatorInstance;
    } catch (error) {
      console.error('[cogitator] Failed to initialize:', error);
      throw error;
    } finally {
      isInitializing = false;
    }
  })();

  return initPromise;
}

export async function closeCogitator(): Promise<void> {
  if (cogitatorInstance) {
    await cogitatorInstance.close();
    cogitatorInstance = null;
    initPromise = null;
  }
}

export function createAgentFromConfig(config: AgentConfig): Agent {
  return new Agent(config);
}

export type BuiltinTool = (typeof builtinTools)[number];

export function getAvailableTools(): BuiltinTool[] {
  return [...builtinTools];
}

export function getToolByName(name: string): BuiltinTool | undefined {
  return builtinTools.find((t) => t.name === name);
}

export interface AvailableProvider {
  id: LLMProvider;
  name: string;
  configured: boolean;
  models: string[];
}

export function getAvailableProviders(): AvailableProvider[] {
  return [
    {
      id: 'ollama',
      name: 'Ollama (Local)',
      configured: true,
      models: [],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      configured: !!process.env.OPENAI_API_KEY,
      models: [
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-4-turbo',
        'gpt-4',
        'gpt-3.5-turbo',
        'o1-preview',
        'o1-mini',
      ],
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      configured: !!process.env.ANTHROPIC_API_KEY,
      models: [
        'claude-sonnet-4-20250514',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
        'claude-3-opus-20240229',
      ],
    },
    {
      id: 'google',
      name: 'Google',
      configured: !!process.env.GOOGLE_API_KEY,
      models: [
        'gemini-2.5-pro-preview-06-05',
        'gemini-2.5-flash-preview-05-20',
        'gemini-2.0-flash',
        'gemini-1.5-pro',
        'gemini-1.5-flash',
      ],
    },
  ];
}

export { Cogitator, Agent, tool, ToolRegistry };

