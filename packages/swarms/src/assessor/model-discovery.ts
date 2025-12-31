import type {
  DiscoveredModel,
  ModelProvider,
  ModelCapabilitiesInfo,
  AssessorConfig,
} from '@cogitator-ai/types';

interface OllamaModelInfo {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    format?: string;
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface OllamaTagsResponse {
  models: OllamaModelInfo[];
}

const KNOWN_MODEL_CAPABILITIES: Record<string, Partial<ModelCapabilitiesInfo>> = {
  'llama3': { supportsTools: true, supportsJson: true },
  'llama3.1': { supportsTools: true, supportsJson: true },
  'llama3.2': { supportsTools: true, supportsJson: true },
  'llama3.3': { supportsTools: true, supportsJson: true },
  'qwen': { supportsTools: true, supportsJson: true },
  'qwen2': { supportsTools: true, supportsJson: true },
  'qwen2.5': { supportsTools: true, supportsJson: true },
  'mistral': { supportsTools: true, supportsJson: true },
  'mixtral': { supportsTools: true, supportsJson: true },
  'llava': { supportsVision: true, supportsJson: true },
  'bakllava': { supportsVision: true, supportsJson: true },
  'llama3.2-vision': { supportsVision: true, supportsTools: true, supportsJson: true },
  'minicpm-v': { supportsVision: true, supportsJson: true },
  'moondream': { supportsVision: true },
  'deepseek': { supportsTools: true, supportsJson: true },
  'phi3': { supportsJson: true },
  'phi4': { supportsTools: true, supportsJson: true },
  'gemma': { supportsJson: true },
  'gemma2': { supportsJson: true },
  'codellama': { supportsJson: true },
  'starcoder': { supportsJson: true },
};

const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  'llama3.2:1b': 128000,
  'llama3.2:3b': 128000,
  'llama3.1': 128000,
  'llama3': 8192,
  'qwen2.5': 128000,
  'qwen2': 32768,
  'mistral': 32768,
  'mixtral': 32768,
  'phi3': 128000,
  'phi4': 16384,
  'gemma2': 8192,
  'deepseek': 64000,
};

const CLOUD_MODELS: DiscoveredModel[] = [
  {
    id: 'gpt-4o',
    provider: 'openai',
    displayName: 'GPT-4o',
    capabilities: { supportsVision: true, supportsTools: true, supportsJson: true, supportsStreaming: true },
    pricing: { input: 2.5, output: 10 },
    contextWindow: 128000,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    displayName: 'GPT-4o Mini',
    capabilities: { supportsVision: true, supportsTools: true, supportsJson: true, supportsStreaming: true },
    pricing: { input: 0.15, output: 0.6 },
    contextWindow: 128000,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'gpt-4-turbo',
    provider: 'openai',
    displayName: 'GPT-4 Turbo',
    capabilities: { supportsVision: true, supportsTools: true, supportsJson: true, supportsStreaming: true },
    pricing: { input: 10, output: 30 },
    contextWindow: 128000,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 4',
    capabilities: { supportsVision: true, supportsTools: true, supportsJson: true, supportsStreaming: true },
    pricing: { input: 3, output: 15 },
    contextWindow: 200000,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    provider: 'anthropic',
    displayName: 'Claude 3.5 Sonnet',
    capabilities: { supportsVision: true, supportsTools: true, supportsJson: true, supportsStreaming: true },
    pricing: { input: 3, output: 15 },
    contextWindow: 200000,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'claude-3-5-haiku-20241022',
    provider: 'anthropic',
    displayName: 'Claude 3.5 Haiku',
    capabilities: { supportsTools: true, supportsJson: true, supportsStreaming: true },
    pricing: { input: 0.8, output: 4 },
    contextWindow: 200000,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'claude-3-opus-20240229',
    provider: 'anthropic',
    displayName: 'Claude 3 Opus',
    capabilities: { supportsVision: true, supportsTools: true, supportsJson: true, supportsStreaming: true },
    pricing: { input: 15, output: 75 },
    contextWindow: 200000,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'gemini-1.5-pro',
    provider: 'google',
    displayName: 'Gemini 1.5 Pro',
    capabilities: { supportsVision: true, supportsTools: true, supportsJson: true, supportsStreaming: true },
    pricing: { input: 1.25, output: 5 },
    contextWindow: 2000000,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'gemini-1.5-flash',
    provider: 'google',
    displayName: 'Gemini 1.5 Flash',
    capabilities: { supportsVision: true, supportsTools: true, supportsJson: true, supportsStreaming: true },
    pricing: { input: 0.075, output: 0.3 },
    contextWindow: 1000000,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'gemini-2.0-flash',
    provider: 'google',
    displayName: 'Gemini 2.0 Flash',
    capabilities: { supportsVision: true, supportsTools: true, supportsJson: true, supportsStreaming: true },
    pricing: { input: 0.1, output: 0.4 },
    contextWindow: 1000000,
    isLocal: false,
    isAvailable: true,
  },
];

export class ModelDiscovery {
  private ollamaUrl: string;
  private enabledProviders: Set<ModelProvider>;
  private cache = new Map<string, { models: DiscoveredModel[]; timestamp: number }>();
  private cacheTTL: number;

  constructor(config: AssessorConfig) {
    this.ollamaUrl = config.ollamaUrl ?? 'http://localhost:11434';
    this.enabledProviders = new Set(config.enabledProviders ?? ['ollama', 'openai', 'anthropic', 'google']);
    this.cacheTTL = config.cacheTTL ?? 5 * 60 * 1000; // 5 minutes
  }

  async discoverAll(): Promise<DiscoveredModel[]> {
    const cacheKey = 'all';
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.models;
    }

    const models: DiscoveredModel[] = [];

    if (this.enabledProviders.has('ollama')) {
      const ollamaModels = await this.discoverOllama();
      models.push(...ollamaModels);
    }

    const cloudModels = this.getCloudModels();
    models.push(...cloudModels);

    this.cache.set(cacheKey, { models, timestamp: Date.now() });
    return models;
  }

  async discoverOllama(): Promise<DiscoveredModel[]> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as OllamaTagsResponse;

      return data.models.map((model) => this.transformOllamaModel(model));
    } catch {
      return [];
    }
  }

  private transformOllamaModel(model: OllamaModelInfo): DiscoveredModel {
    const name = model.name.toLowerCase();
    const capabilities = this.inferOllamaCapabilities(name);
    const contextWindow = this.inferContextWindow(name);

    return {
      id: model.name,
      provider: 'ollama',
      displayName: this.formatModelName(model.name),
      capabilities: {
        ...capabilities,
        supportsStreaming: true,
      },
      pricing: { input: 0, output: 0 },
      contextWindow,
      isLocal: true,
      isAvailable: true,
    };
  }

  private inferOllamaCapabilities(name: string): ModelCapabilitiesInfo {
    for (const [pattern, caps] of Object.entries(KNOWN_MODEL_CAPABILITIES)) {
      if (name.includes(pattern.toLowerCase())) {
        return { ...caps };
      }
    }
    return { supportsStreaming: true };
  }

  private inferContextWindow(name: string): number {
    for (const [pattern, size] of Object.entries(KNOWN_CONTEXT_WINDOWS)) {
      if (name.includes(pattern.toLowerCase())) {
        return size;
      }
    }
    return 4096;
  }

  private formatModelName(name: string): string {
    const [base, tag] = name.split(':');
    const formatted = base
      .split(/[-_]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
    return tag && tag !== 'latest' ? `${formatted} (${tag})` : formatted;
  }

  getCloudModels(filterProviders?: ModelProvider[]): DiscoveredModel[] {
    const providers = filterProviders
      ? new Set(filterProviders.filter((p) => this.enabledProviders.has(p)))
      : this.enabledProviders;
    return CLOUD_MODELS.filter((model) => providers.has(model.provider));
  }

  async checkOllamaAvailability(): Promise<boolean> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
