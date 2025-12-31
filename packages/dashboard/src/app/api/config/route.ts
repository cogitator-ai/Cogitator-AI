import { NextResponse } from 'next/server';
import { getCogitatorConfig, setCogitatorConfig, getAllConfig } from '@/lib/db/config';
import { initializeSchema } from '@/lib/db';
import {
  loadConfig,
  CogitatorConfigSchema,
  loadEnvConfig,
} from '@cogitator-ai/config';
import * as yaml from 'js-yaml';
import { withRole } from '@/lib/auth/middleware';

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    try {
      await initializeSchema();
      initialized = true;
    } catch (error) {
      console.error('Failed to initialize database:', error);
    }
  }
}

export const GET = withRole(['admin'], async (request) => {
  try {
    await ensureInitialized();

    const searchParams = request.nextUrl.searchParams;
    const action = searchParams.get('action');

    if (action === 'load-from-file') {
      try {
        const config = loadConfig({
          configPath: process.cwd(),
        });
        return NextResponse.json({
          source: 'file',
          config,
          valid: true,
        });
      } catch (error) {
        return NextResponse.json({
          source: 'file',
          error: error instanceof Error ? error.message : 'Failed to load config',
          valid: false,
        });
      }
    }

    if (action === 'validate') {
      const yamlContent = searchParams.get('yaml');
      if (!yamlContent) {
        return NextResponse.json({ error: 'yaml parameter required' }, { status: 400 });
      }

      try {
        const parsed = yaml.load(yamlContent);
        const result = CogitatorConfigSchema.safeParse(parsed);
        return NextResponse.json({
          valid: result.success,
          errors: result.success ? undefined : result.error.errors,
          config: result.success ? result.data : undefined,
        });
      } catch (error) {
        return NextResponse.json({
          valid: false,
          errors: [{ message: error instanceof Error ? error.message : 'Invalid YAML' }],
        });
      }
    }

    if (action === 'schema') {
      return NextResponse.json({
        schema: {
          type: 'object',
          properties: {
            llm: {
              type: 'object',
              properties: {
                defaultProvider: {
                  type: 'string',
                  enum: ['ollama', 'openai', 'anthropic', 'google', 'vllm'],
                },
                providers: { type: 'object' },
              },
            },
            memory: {
              type: 'object',
              properties: {
                adapter: { type: 'string', enum: ['memory', 'redis', 'postgres'] },
              },
            },
            sandbox: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                type: { type: 'string', enum: ['native', 'docker', 'wasm'] },
              },
            },
            limits: {
              type: 'object',
              properties: {
                maxTurns: { type: 'number' },
                maxTokens: { type: 'number' },
                maxCost: { type: 'number' },
              },
            },
          },
        },
      });
    }

    const config = await getCogitatorConfig();
    const allConfig = await getAllConfig();

    const envVars = {
      POSTGRES_HOST: process.env.POSTGRES_HOST || 'localhost',
      POSTGRES_PORT: process.env.POSTGRES_PORT || '5432',
      REDIS_HOST: process.env.REDIS_HOST || 'localhost',
      REDIS_PORT: process.env.REDIS_PORT || '6379',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '***' : undefined,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? '***' : undefined,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ? '***' : undefined,
      OLLAMA_URL: process.env.OLLAMA_URL || 'http://localhost:11434',
    };

    let envConfig;
    try {
      envConfig = loadEnvConfig();
    } catch {
      envConfig = null;
    }

    return NextResponse.json({
      cogitator: config || getDefaultConfig(),
      all: allConfig,
      environment: envVars,
      fromEnv: envConfig,
    });
  } catch (error) {
    console.error('Failed to fetch config:', error);
    return NextResponse.json({ error: 'Failed to fetch config' }, { status: 500 });
  }
});

export const PUT = withRole(['admin'], async (request) => {
  try {
    await ensureInitialized();
    const body = await request.json();

    if (!body.llm?.provider || !body.llm?.model) {
      return NextResponse.json(
        { error: 'llm.provider and llm.model are required' },
        { status: 400 }
      );
    }

    await setCogitatorConfig(body);
    const config = await getCogitatorConfig();

    return NextResponse.json(config);
  } catch (error) {
    console.error('Failed to update config:', error);
    return NextResponse.json({ error: 'Failed to update config' }, { status: 500 });
  }
});

function getDefaultConfig() {
  return {
    llm: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      temperature: 0.7,
      maxTokens: 4096,
    },
    memory: {
      adapter: 'postgres',
      postgres: {
        url: `postgresql://${process.env.POSTGRES_USER || 'cogitator'}:${process.env.POSTGRES_PASSWORD || 'cogitator'}@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || '5432'}/${process.env.POSTGRES_DB || 'cogitator'}`,
      },
    },
    sandbox: {
      enabled: false,
      type: 'docker',
      timeout: 30000,
    },
    limits: {
      maxTurns: 10,
      maxTokens: 100000,
      maxCost: 1.0,
    },
  };
}
