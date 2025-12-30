const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

export interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details: {
    format: string;
    family: string;
    parameter_size: string;
    quantization_level: string;
  };
}

export interface OllamaModelInfo {
  name: string;
  displayName: string;
  size: number;
  sizeFormatted: string;
  parameterSize: string;
  family: string;
  quantization: string;
  modifiedAt: string;
  isDownloaded: boolean;
}

export interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  percent?: number;
}

export async function getOllamaModels(): Promise<OllamaModelInfo[]> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status}`);
    }
    
    const data = await response.json();
    const models: OllamaModel[] = data.models || [];
    
    return models.map((m) => ({
      name: m.name,
      displayName: formatModelName(m.name),
      size: m.size,
      sizeFormatted: formatSize(m.size),
      parameterSize: m.details?.parameter_size || 'Unknown',
      family: m.details?.family || 'Unknown',
      quantization: m.details?.quantization_level || 'Unknown',
      modifiedAt: m.modified_at,
      isDownloaded: true,
    }));
  } catch (error) {
    console.error('Failed to fetch Ollama models:', error);
    return [];
  }
}

export async function getModelInfo(name: string): Promise<OllamaModelInfo | null> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    return {
      name,
      displayName: formatModelName(name),
      size: 0,
      sizeFormatted: 'Unknown',
      parameterSize: data.details?.parameter_size || 'Unknown',
      family: data.details?.family || 'Unknown',
      quantization: data.details?.quantization_level || 'Unknown',
      modifiedAt: data.modified_at || '',
      isDownloaded: true,
    };
  } catch {
    return null;
  }
}

export async function pullModel(
  name: string,
  onProgress: (progress: PullProgress) => void
): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
    });
    
    if (!response.ok || !response.body) {
      throw new Error(`Failed to pull model: ${response.status}`);
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const lines = decoder.decode(value).split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const progress = JSON.parse(line) as PullProgress;
          if (progress.total && progress.completed) {
            progress.percent = Math.round((progress.completed / progress.total) * 100);
          }
          onProgress(progress);
        } catch {
        }
      }
    }
    
    return true;
  } catch (error) {
    console.error('Failed to pull model:', error);
    return false;
  }
}

export async function deleteModel(name: string): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function checkOllamaHealth(): Promise<{ available: boolean; version?: string }> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/version`);
    if (response.ok) {
      const data = await response.json();
      return { available: true, version: data.version };
    }
    return { available: false };
  } catch {
    return { available: false };
  }
}

export const POPULAR_MODELS = [
  { name: 'llama3.2:3b', description: 'Llama 3.2 3B - Fast and efficient', size: '2.0 GB' },
  { name: 'llama3.2:1b', description: 'Llama 3.2 1B - Ultra-lightweight', size: '1.3 GB' },
  { name: 'llama3.1:8b', description: 'Llama 3.1 8B - Balanced performance', size: '4.7 GB' },
  { name: 'llama3.1:70b', description: 'Llama 3.1 70B - High capability', size: '40 GB' },
  { name: 'mistral:7b', description: 'Mistral 7B - Strong reasoning', size: '4.1 GB' },
  { name: 'mixtral:8x7b', description: 'Mixtral 8x7B MoE - Expert mixture', size: '26 GB' },
  { name: 'codellama:7b', description: 'Code Llama 7B - Code generation', size: '3.8 GB' },
  { name: 'codellama:13b', description: 'Code Llama 13B - Better code', size: '7.4 GB' },
  { name: 'gemma2:9b', description: 'Gemma 2 9B - Google model', size: '5.4 GB' },
  { name: 'gemma2:2b', description: 'Gemma 2 2B - Compact Google', size: '1.6 GB' },
  { name: 'qwen2.5:7b', description: 'Qwen 2.5 7B - Multilingual', size: '4.4 GB' },
  { name: 'qwen2.5:14b', description: 'Qwen 2.5 14B - Larger Qwen', size: '8.9 GB' },
  { name: 'phi3:mini', description: 'Phi-3 Mini - Microsoft compact', size: '2.2 GB' },
  { name: 'deepseek-coder:6.7b', description: 'DeepSeek Coder - Code specialist', size: '3.8 GB' },
  { name: 'nomic-embed-text', description: 'Nomic Embed - Text embeddings', size: '274 MB' },
];

function formatModelName(name: string): string {
  const parts = name.split(':');
  const base = parts[0].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const tag = parts[1] || 'latest';
  return `${base} (${tag})`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

