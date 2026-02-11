import type { LLMProvider, TemplateFile } from '../../types.js';

export function generateDockerCompose(provider: LLMProvider): TemplateFile {
  const services: string[] = [];

  if (provider === 'ollama') {
    services.push(
      ...[
        '  ollama:',
        '    image: ollama/ollama:latest',
        '    ports:',
        '      - "11434:11434"',
        '    volumes:',
        '      - ollama_data:/root/.ollama',
        '',
      ]
    );
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
      '      POSTGRES_USER: cogitator',
      '      POSTGRES_PASSWORD: cogitator',
      '      POSTGRES_DB: cogitator',
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
