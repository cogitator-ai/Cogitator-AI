import type { LLMProvider, Template, TemplateFile } from '../../types.js';
import { defaultModels } from '../../utils/providers.js';

/**
 * `cogitator.yml` in the shape `@cogitator-ai/config` loads: the provider and model
 * the generated code uses, and the memory it connects to. API keys stay in the
 * environment, where the config loader picks them up.
 */
export function generateCogitatorYml(provider: LLMProvider, template?: Template): TemplateFile {
  const lines = [
    'llm:',
    `  defaultProvider: ${provider}`,
    `  defaultModel: ${defaultModels[provider]}`,
  ];

  if (provider === 'ollama') {
    lines.push(
      '  providers:',
      '    ollama:',
      '      baseUrl: ${OLLAMA_BASE_URL:-http://localhost:11434}'
    );
  }

  if (template === 'memory') {
    lines.push(
      '',
      'memory:',
      '  adapter: redis',
      '  redis:',
      '    url: ${REDIS_URL:-redis://localhost:6379}'
    );
  }

  lines.push('');
  return { path: 'cogitator.yml', content: lines.join('\n') };
}
