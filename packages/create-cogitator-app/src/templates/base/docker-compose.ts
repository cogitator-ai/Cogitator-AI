import type { LLMProvider, TemplateFile } from '../../types.js';
import { defaultModels } from '../../utils/providers.js';

/**
 * Ollama with an empty volume answers "model not found", so a one-shot
 * `ollama-pull` service downloads the project's model into it once the server
 * is up. Later runs find the model in the volume and finish at once.
 */
function ollamaServices(model: string): string[] {
  return [
    '  ollama:',
    '    image: ollama/ollama:latest',
    '    ports:',
    '      - "11434:11434"',
    '    volumes:',
    '      - ollama_data:/root/.ollama',
    '    healthcheck:',
    '      test: ["CMD", "ollama", "list"]',
    '      interval: 5s',
    '      timeout: 5s',
    '      retries: 20',
    '',
    '  ollama-pull:',
    '    image: ollama/ollama:latest',
    '    depends_on:',
    '      ollama:',
    '        condition: service_healthy',
    '    environment:',
    '      OLLAMA_HOST: http://ollama:11434',
    `    entrypoint: ["ollama", "pull", ${JSON.stringify(model)}]`,
    '    restart: "no"',
    '',
  ];
}

export function generateDockerCompose(
  provider: LLMProvider,
  model: string = defaultModels[provider]
): TemplateFile {
  const services: string[] = [];

  if (provider === 'ollama') {
    services.push(...ollamaServices(model));
  }

  services.push(
    ...[
      '  redis:',
      '    image: redis:7-alpine',
      '    ports:',
      '      - "6379:6379"',
      '    volumes:',
      '      - redis_data:/data',
      '',
      '  postgres:',
      '    image: postgres:16-alpine',
      '    ports:',
      '      - "5432:5432"',
      '    environment:',
      '      POSTGRES_USER: ${POSTGRES_USER:-cogitator}',
      '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-cogitator}',
      '      POSTGRES_DB: ${POSTGRES_DB:-cogitator}',
      '    volumes:',
      '      - postgres_data:/var/lib/postgresql/data',
    ]
  );

  const volumes = ['volumes:'];
  if (provider === 'ollama') volumes.push('  ollama_data:');
  volumes.push('  redis_data:', '  postgres_data:');

  const content = ['services:', ...services, '', ...volumes, ''].join('\n');

  return { path: 'docker-compose.yml', content };
}
