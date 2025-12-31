import { NextResponse } from 'next/server';
import { getOllamaModels, checkOllamaHealth, POPULAR_MODELS } from '@/lib/ollama';
import { getApiKeysStatus, setApiKeys, type ApiKeysConfig } from '@/lib/db/config';
import {
  initializeModels,
  getModel,
  getPrice,
  listModels,
  BUILTIN_MODELS,
  OPENAI_MODELS,
  ANTHROPIC_MODELS,
  GOOGLE_MODELS,
} from '@cogitator-ai/models';
import { withAuth } from '@/lib/auth/middleware';

let modelsInitialized = false;

async function ensureModelsInitialized() {
  if (!modelsInitialized) {
    try {
      await initializeModels();
      modelsInitialized = true;
    } catch (error) {
      console.warn('[models] Failed to initialize models registry:', error);
      modelsInitialized = true;
    }
  }
}

export const GET = withAuth(async (request) => {
  try {
    const searchParams = request.nextUrl.searchParams;
    const action = searchParams.get('action');

    if (action === 'pricing') {
      await ensureModelsInitialized();
      const modelName = searchParams.get('model');

      if (modelName) {
        const price = getPrice(modelName);
        const model = getModel(modelName);
        return NextResponse.json({
          model: modelName,
          pricing: price,
          info: model,
        });
      }

      const allModels = listModels();
      return NextResponse.json({
        models: allModels.map((m) => ({
          ...m,
          pricing: getPrice(m.id),
        })),
      });
    }

    if (action === 'registry') {
      await ensureModelsInitialized();
      const provider = searchParams.get('provider');
      const models = listModels(provider ? { provider } : undefined);
      return NextResponse.json({ models });
    }

    const ollamaHealth = await checkOllamaHealth();
    const ollamaModels = ollamaHealth.available ? await getOllamaModels() : [];

    const apiKeysStatus = await getApiKeysStatus();

    const downloadedFullNames = new Set(ollamaModels.map((m) => m.name));

    const availableModels = POPULAR_MODELS.map((m) => {
      const [baseName, tag] = m.name.split(':');

      if (downloadedFullNames.has(m.name)) {
        return { ...m, isDownloaded: true };
      }

      if (!tag) {
        if (downloadedFullNames.has(`${baseName}:latest`)) {
          return { ...m, isDownloaded: true };
        }
      }

      return { ...m, isDownloaded: false };
    });

    await ensureModelsInitialized();

    const cloudProviders = [
      {
        id: 'openai',
        name: 'OpenAI',
        models: OPENAI_MODELS.map((m) => ({
          id: m.id,
          name: m.displayName,
          contextLength: m.contextWindow,
          pricing: m.pricing,
          capabilities: m.capabilities,
        })),
        configured: apiKeysStatus.openai,
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: ANTHROPIC_MODELS.map((m) => ({
          id: m.id,
          name: m.displayName,
          contextLength: m.contextWindow,
          pricing: m.pricing,
          capabilities: m.capabilities,
        })),
        configured: apiKeysStatus.anthropic,
      },
      {
        id: 'google',
        name: 'Google',
        models: GOOGLE_MODELS.map((m) => ({
          id: m.id,
          name: m.displayName,
          contextLength: m.contextWindow,
          pricing: m.pricing,
          capabilities: m.capabilities,
        })),
        configured: apiKeysStatus.google,
      },
    ];

    return NextResponse.json({
      ollama: {
        available: ollamaHealth.available,
        version: ollamaHealth.version,
        models: ollamaModels,
      },
      available: availableModels,
      cloud: cloudProviders,
      registry: {
        totalModels: BUILTIN_MODELS.length,
        providers: ['openai', 'anthropic', 'google', 'ollama'],
      },
    });
  } catch (error) {
    console.error('Failed to fetch models:', error);
    return NextResponse.json({ error: 'Failed to fetch models' }, { status: 500 });
  }
});

export const POST = withAuth(async (request) => {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'save_api_keys') {
      const { openai, anthropic, google } = body;

      const keys: ApiKeysConfig = {};
      if (openai) keys.openai = openai;
      if (anthropic) keys.anthropic = anthropic;
      if (google) keys.google = google;

      await setApiKeys(keys);

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('Failed to process request:', error);
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
  }
});
