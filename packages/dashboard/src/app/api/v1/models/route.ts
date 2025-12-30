/**
 * OpenAI-Compatible Models API
 *
 * Lists available models in OpenAI format.
 */

import { NextResponse } from 'next/server';
import { getOllamaModels, checkOllamaHealth } from '@/lib/ollama';
import { OPENAI_MODELS, ANTHROPIC_MODELS, GOOGLE_MODELS } from '@cogitator/models';

export async function GET() {
  try {
    const models: Array<{
      id: string;
      object: 'model';
      created: number;
      owned_by: string;
    }> = [];

    const ollamaHealth = await checkOllamaHealth();
    if (ollamaHealth.available) {
      const ollamaModels = await getOllamaModels();
      for (const model of ollamaModels) {
        models.push({
          id: model.name,
          object: 'model',
          created: Math.floor(new Date(model.modifiedAt).getTime() / 1000),
          owned_by: 'ollama',
        });
      }
    }

    if (process.env.OPENAI_API_KEY) {
      for (const model of OPENAI_MODELS) {
        models.push({
          id: model.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000) - 86400 * 30,
          owned_by: 'openai',
        });
      }
    }

    if (process.env.ANTHROPIC_API_KEY) {
      for (const model of ANTHROPIC_MODELS) {
        models.push({
          id: model.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000) - 86400 * 30,
          owned_by: 'anthropic',
        });
      }
    }

    if (process.env.GOOGLE_API_KEY) {
      for (const model of GOOGLE_MODELS) {
        models.push({
          id: model.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000) - 86400 * 30,
          owned_by: 'google',
        });
      }
    }

    return NextResponse.json({
      object: 'list',
      data: models,
    });
  } catch (error) {
    console.error('[openai-compat] Models error:', error);
    return NextResponse.json(
      {
        error: {
          message: error instanceof Error ? error.message : 'Failed to list models',
          type: 'server_error',
        },
      },
      { status: 500 }
    );
  }
}

