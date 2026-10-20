import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ModelInfo } from '@cogitator-ai/models';

const models: ModelInfo[] = [
  {
    id: 'mystery-model',
    provider: 'acme',
    displayName: 'Mystery',
    pricing: { input: 0, output: 0 },
    contextWindow: 128_000,
    capabilities: { supportsTools: true },
    priceUnknown: true,
  },
  {
    id: 'known-model',
    provider: 'acme',
    displayName: 'Known',
    pricing: { input: 0.5, output: 1.5 },
    contextWindow: 128_000,
    capabilities: { supportsTools: true },
  },
];

vi.mock('@cogitator-ai/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cogitator-ai/models')>();
  return {
    ...actual,
    getModelRegistry: () => ({
      initialize: async () => undefined,
      listModels: () => models,
    }),
  };
});

const { ModelSelector } = await import('../cost-routing/model-selector');

describe('ModelSelector', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('never picks a model whose price is unknown, which would look free', async () => {
    const selector = new ModelSelector({ enabled: true, autoSelectModel: true });

    const recommendation = await selector.selectAvailableModel(
      {
        complexity: 'simple',
        needsToolCalling: true,
        needsVision: false,
        needsLongContext: false,
        needsReasoning: 'basic',
        needsSpeed: 'balanced',
        costSensitivity: 'high',
      },
      () => true
    );

    expect(recommendation?.modelId).toBe('known-model');
    expect(recommendation?.estimatedCost).toBeGreaterThan(0);
    expect(recommendation?.fallbacks ?? []).not.toContain('mystery-model');
  });
});
