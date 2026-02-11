import type { LLMProvider, TemplateFile } from '../../types.js';
import { defaultModels } from '../../utils/providers.js';

export function generateCogitatorYml(provider: LLMProvider): TemplateFile {
  const model = defaultModels[provider];

  const lines = [`provider: ${provider}`, `model: ${model}`, ''];

  if (provider === 'ollama') {
    lines.push('ollama:', '  baseUrl: http://localhost:11434', '');
  }

  return { path: 'cogitator.yml', content: lines.join('\n') };
}
