import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import type { DeployConfig } from '@cogitator-ai/types';
import {
  COMPOSE_OLLAMA_URL,
  OLLAMA_IMAGE,
  generateDockerCompose,
} from '../templates/docker-compose';

interface ComposeService {
  image?: string;
  environment?: Record<string, string>;
  entrypoint?: string[];
  command?: string[];
  depends_on?: Record<string, { condition: string }>;
  volumes?: string[];
  healthcheck?: { test: string[] };
  restart?: string;
  deploy?: {
    resources: { reservations: { devices: { driver: string; capabilities: string[] }[] } };
  };
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
}

function compose(config: DeployConfig): ComposeFile {
  const parsed: unknown = parse(generateDockerCompose(config));
  if (typeof parsed !== 'object' || parsed === null || !('services' in parsed)) {
    throw new Error('The compose file has no services');
  }
  return parsed as ComposeFile;
}

function service(file: ComposeFile, name: string): ComposeService {
  const found = file.services[name];
  if (!found) throw new Error(`No ${name} service`);
  return found;
}

const withOllama = (ollama: DeployConfig['ollama'] = {}): DeployConfig => ({
  image: 'api',
  services: { ollama: true },
  ollama,
});

describe('generateDockerCompose with Ollama', () => {
  it('runs no Ollama for a project without it', () => {
    const file = compose({ image: 'api', services: { redis: true } });
    expect(Object.keys(file.services)).toEqual(['app', 'redis']);
    expect(service(file, 'app').environment).not.toHaveProperty('OLLAMA_HOST');
    expect(file.volumes).not.toHaveProperty('ollama-data');
  });

  it('runs an ollama service with a model volume and a health check', () => {
    const file = compose(withOllama({ models: ['llama3.2'] }));
    const ollama = service(file, 'ollama');

    expect(ollama.image).toBe(OLLAMA_IMAGE);
    expect(ollama.volumes).toEqual(['ollama-data:/root/.ollama']);
    expect(ollama.healthcheck?.test).toEqual(['CMD', 'ollama', 'list']);
    expect(ollama.restart).toBe('unless-stopped');
    expect(ollama.deploy).toBeUndefined();
    expect(file.volumes).toHaveProperty('ollama-data');
  });

  it('leaves the Ollama URL of the app to the env the analyzer decides', () => {
    const plain = service(compose(withOllama({ models: ['llama3.2'] })), 'app').environment;
    expect(plain).not.toHaveProperty('OLLAMA_HOST');

    const wired = service(
      compose({
        ...withOllama({ models: ['llama3.2'] }),
        env: { OLLAMA_HOST: COMPOSE_OLLAMA_URL },
      }),
      'app'
    ).environment;
    expect(wired?.OLLAMA_HOST).toBe(COMPOSE_OLLAMA_URL);
  });

  it('pulls the models as arguments of a one-shot service the app waits for', () => {
    const file = compose(withOllama({ models: ['qwen3:8b', 'nomic-embed-text', 'qwen3:8b'] }));
    const pull = service(file, 'ollama-pull');

    expect(pull.environment).toEqual({ OLLAMA_HOST: COMPOSE_OLLAMA_URL });
    expect(pull.entrypoint?.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(pull.entrypoint?.[2]).not.toContain('qwen3');
    expect(pull.command).toEqual(['qwen3:8b', 'nomic-embed-text']);
    expect(pull.depends_on).toEqual({ ollama: { condition: 'service_healthy' } });
    expect(pull.restart).toBe('no');
    expect(service(file, 'app').depends_on).toEqual({
      ollama: { condition: 'service_healthy' },
      'ollama-pull': { condition: 'service_completed_successfully' },
    });
  });

  it('skips a model the volume has already, so a restart without network still starts', () => {
    const script = service(compose(withOllama({ models: ['llama3.2'] })), 'ollama-pull')
      .entrypoint?.[2];
    expect(script).toContain('ollama show -- "$$model"');
    expect(script).toContain('|| ollama pull -- "$$model"');
  });

  it('keeps a $ in a model name away from compose interpolation', () => {
    const pull = service(compose(withOllama({ models: ['odd$name'] })), 'ollama-pull');
    expect(pull.command).toEqual(['odd$$name']);
  });

  it('waits only for the server when there is nothing to pull', () => {
    const file = compose(withOllama());
    expect(file.services).not.toHaveProperty('ollama-pull');
    expect(service(file, 'app').depends_on).toEqual({ ollama: { condition: 'service_healthy' } });
  });

  it('reserves the NVIDIA GPUs of the host when asked', () => {
    const ollama = service(compose(withOllama({ gpu: true, models: ['llama3.2'] })), 'ollama');
    expect(ollama.deploy?.resources.reservations.devices).toEqual([
      { driver: 'nvidia', count: 'all', capabilities: ['gpu'] },
    ]);
  });

  it('runs the image ollama.image names in both services', () => {
    const file = compose(withOllama({ image: 'ollama/ollama:rocm', models: ['llama3.2'] }));
    expect(service(file, 'ollama').image).toBe('ollama/ollama:rocm');
    expect(service(file, 'ollama-pull').image).toBe('ollama/ollama:rocm');
  });

  it('keeps redis and postgres next to the ollama service', () => {
    const file = compose({
      ...withOllama({ models: ['llama3.2'] }),
      services: { redis: true, postgres: true, ollama: true },
    });
    expect(Object.keys(file.services)).toEqual([
      'app',
      'redis',
      'postgres',
      'ollama',
      'ollama-pull',
    ]);
    expect(Object.keys(service(file, 'app').depends_on ?? {})).toEqual([
      'redis',
      'postgres',
      'ollama',
      'ollama-pull',
    ]);
    expect(Object.keys(file.volumes ?? {})).toEqual(['redis-data', 'postgres-data', 'ollama-data']);
  });
});
