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
  llama3: { supportsJson: true },
  'llama3.1': { supportsTools: true, supportsJson: true },
  'llama3.2': { supportsTools: true, supportsJson: true },
  'llama3.3': { supportsTools: true, supportsJson: true },
  qwen: { supportsTools: true, supportsJson: true },
  qwen2: { supportsTools: true, supportsJson: true },
  'qwen2.5': { supportsTools: true, supportsJson: true },
  qwen3: { supportsTools: true, supportsJson: true },
  'qwen3.5': { supportsVision: true, supportsTools: true, supportsJson: true },
  mistral: { supportsTools: true, supportsJson: true },
  mixtral: { supportsTools: true, supportsJson: true },
  llava: { supportsVision: true, supportsJson: true },
  bakllava: { supportsVision: true, supportsJson: true },
  'llama3.2-vision': { supportsVision: true, supportsTools: true, supportsJson: true },
  'minicpm-v': { supportsVision: true, supportsJson: true },
  moondream: { supportsVision: true },
  deepseek: { supportsTools: true, supportsJson: true },
  phi3: { supportsJson: true },
  phi4: { supportsTools: true, supportsJson: true },
  gemma: { supportsJson: true },
  gemma2: { supportsJson: true },
  codellama: { supportsJson: true },
  starcoder: { supportsJson: true },
};

const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  'llama3.2:1b': 128000,
  'llama3.2:latest': 128000,
  'llama3.1': 128000,
  llama3: 8192,
  'qwen2.5': 128000,
  qwen3: 40960,
  'qwen3.5': 262144,
  qwen2: 32768,
  mistral: 32768,
  mixtral: 32768,
  phi3: 128000,
  phi4: 16384,
  gemma2: 8192,
  deepseek: 64000,
};

const CLOUD_MODELS: DiscoveredModel[] = [
  {
    id: 'gpt-6-astra',
    provider: 'openai',
    displayName: 'GPT-6 Astra',
    capabilities: {
      supportsVision: true,
      supportsTools: true,
      supportsJson: true,
      supportsStreaming: true,
    },
    pricing: { input: 10, output: 50 },
    contextWindow: 1050000,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'gpt-6.1-sol',
    provider: 'openai',
    displayName: 'GPT-6.1 Sol',
    capabilities: {
      supportsVision: true,
      supportsTools: true,
      supportsJson: true,
      supportsStreaming: true,
    },
    pricing: { input: 2, output: 10 },
    contextWindow: 1050000,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'gpt-6-luna',
    provider: 'openai',
    displayName: 'GPT-6 Luna',
    capabilities: {
      supportsVision: true,
      supportsTools: true,
      supportsJson: true,
      supportsStreaming: true,
    },
    pricing: { input: 0.1, output: 0.5 },
    contextWindow: 1050000,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'claude-opus-5-5',
    provider: 'anthropic',
    displayName: 'Claude Opus 5.5',
    capabilities: {
      supportsVision: true,
      supportsTools: true,
      supportsJson: true,
      supportsStreaming: true,
    },
    pricing: { input: 4, output: 20 },
    contextWindow: 1000000,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'claude-sonnet-5-5',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 5.5',
    capabilities: {
      supportsVision: true,
      supportsTools: true,
      supportsJson: true,
      supportsStreaming: true,
    },
    pricing: { input: 2, output: 10 },
    contextWindow: 1000000,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    capabilities: {
      supportsVision: true,
      supportsTools: true,
      supportsJson: true,
      supportsStreaming: true,
    },
    pricing: { input: 1, output: 5 },
    contextWindow: 200000,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'gemini-3.1-pro-preview',
    provider: 'google',
    displayName: 'Gemini 3.1 Pro Preview',
    capabilities: {
      supportsVision: true,
      supportsTools: true,
      supportsJson: true,
      supportsStreaming: true,
    },
    pricing: { input: 2, output: 12 },
    contextWindow: 1048576,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'gemini-3.8-flash',
    provider: 'google',
    displayName: 'Gemini 3.8 Flash',
    capabilities: {
      supportsVision: true,
      supportsTools: true,
      supportsJson: true,
      supportsStreaming: true,
    },
    pricing: { input: 0.75, output: 3.75 },
    contextWindow: 1048576,
    isLocal: false,
    isAvailable: true,
  },
  {
    id: 'gemini-3.5-flash-lite',
    provider: 'google',
    displayName: 'Gemini 3.5 Flash-Lite',
    capabilities: {
      supportsVision: true,
      supportsTools: true,
      supportsJson: true,
      supportsStreaming: true,
    },
    pricing: { input: 0.3, output: 2.5 },
    contextWindow: 1048576,
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
    this.enabledProviders = new Set(
      config.enabledProviders ?? ['ollama', 'openai', 'anthropic', 'google']
    );
    this.cacheTTL = config.cacheTTL ?? 5 * 60 * 1000;
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
    let bestMatch = '';
    let bestCaps: Partial<ModelCapabilitiesInfo> | undefined;

    for (const [pattern, caps] of Object.entries(KNOWN_MODEL_CAPABILITIES)) {
      const lowerPattern = pattern.toLowerCase();
      if (name.includes(lowerPattern) && lowerPattern.length > bestMatch.length) {
        bestMatch = lowerPattern;
        bestCaps = caps;
      }
    }

    return bestCaps ? { ...bestCaps } : { supportsStreaming: true };
  }

  private inferContextWindow(name: string): number {
    let bestMatch = '';
    let bestSize = 4096;

    for (const [pattern, size] of Object.entries(KNOWN_CONTEXT_WINDOWS)) {
      const lowerPattern = pattern.toLowerCase();
      if (name.includes(lowerPattern) && lowerPattern.length > bestMatch.length) {
        bestMatch = lowerPattern;
        bestSize = size;
      }
    }

    return bestSize;
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
