import type { LLMProvider, Template, TemplateFile } from '../../types.js';
import { defaultModels, providerEnvKey } from '../../utils/providers.js';
import { getTemplate } from '../index.js';

const HEADER = [
  '# Read by `cogitator run` and `cogitator deploy`: the provider and model, the',
  '# memory to provision and the deploy settings. The code in src/ configures',
  '# Cogitator itself, so change the provider, model or memory in both places.',
  '',
];

/**
 * `cogitator.yml` in the shape `@cogitator-ai/config` loads: the provider and model
 * the generated code uses, the memory it connects to, and for servers the path
 * `cogitator deploy` probes for health and the secrets the app needs. API keys stay
 * in the environment, where the config loader picks them up.
 */
export function generateCogitatorYml(
  provider: LLMProvider,
  template?: Template,
  model: string = defaultModels[provider]
): TemplateFile {
  const generator = template ? getTemplate(template) : undefined;
  const lines = [...HEADER, 'llm:', `  defaultProvider: ${provider}`, `  defaultModel: ${model}`];

  if (provider === 'ollama') {
    lines.push(
      '  providers:',
      '    ollama:',
      '      baseUrl: ${OLLAMA_BASE_URL:-http://localhost:11434}'
    );
  }

  if (generator?.memoryAdapter === 'redis') {
    lines.push(
      '',
      'memory:',
      '  adapter: redis',
      '  redis:',
      '    url: ${REDIS_URL:-redis://localhost:6379}'
    );
  } else if (generator?.memoryAdapter === 'memory') {
    lines.push('', 'memory:', '  adapter: memory');
  }

  const deploy: string[] = [];
  if (generator?.healthPath) {
    deploy.push('  health:', `    path: ${generator.healthPath}`);
  }
  if (generator?.secrets?.length) {
    const secrets = [
      ...(provider === 'ollama' ? [] : [providerEnvKey(provider)]),
      ...generator.secrets,
    ];
    deploy.push('  secrets:', ...secrets.map((name) => `    - ${name}`));
  }
  if (deploy.length > 0) {
    lines.push('', 'deploy:', ...deploy);
  }

  lines.push('');
  return { path: 'cogitator.yml', content: lines.join('\n') };
}
