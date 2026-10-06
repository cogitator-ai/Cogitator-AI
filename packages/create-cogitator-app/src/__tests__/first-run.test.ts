import { describe, it, expect } from 'vitest';
import { nextSteps } from '../next-steps.js';
import { generateReadme } from '../templates/base/readme.js';
import { generateEnvExample } from '../templates/base/env-example.js';
import { generateDockerCompose } from '../templates/base/docker-compose.js';
import { generateCogitatorYml } from '../templates/base/cogitator-yml.js';
import { getTemplate } from '../templates/index.js';
import { defaultModels, modelFor } from '../utils/providers.js';
import type { ProjectOptions } from '../types.js';

const base: ProjectOptions = {
  name: 'my-agents',
  path: '/tmp/my-agents',
  template: 'basic',
  provider: 'ollama',
  packageManager: 'npm',
  docker: false,
  git: false,
};

const commands = (opts: ProjectOptions, state: Parameters<typeof nextSteps>[1]) =>
  nextSteps(opts, { directory: 'my-agents', ...state }).map((step) => step.command);

describe('Ollama default model', () => {
  it('is a current small tool-calling model', () => {
    expect(defaultModels.ollama).toBe('qwen3.5:9b');
  });

  it('can be overridden per project', () => {
    expect(modelFor({ ...base, model: 'qwen2.5:0.5b' })).toBe('qwen2.5:0.5b');
    expect(modelFor(base)).toBe('qwen3.5:9b');
  });

  it('flows into the agents and cogitator.yml', () => {
    const opts = { ...base, model: 'llama3.2:3b' };
    const indexTs = getTemplate('basic')
      .files(opts)
      .find((f) => f.path === 'src/index.ts')!.content;
    expect(indexTs).toContain("model: 'llama3.2:3b'");
    expect(generateCogitatorYml('ollama', 'basic', 'llama3.2:3b').content).toContain(
      'defaultModel: llama3.2:3b'
    );
  });
});

describe('next steps', () => {
  it('tells the user to pull the Ollama model when it is not installed', () => {
    expect(commands(base, { installed: true, modelReady: false })).toEqual([
      'cd my-agents',
      'ollama pull qwen3.5:9b',
      'npm run dev',
    ]);
  });

  it('skips the pull once the model is there', () => {
    expect(commands(base, { installed: true, modelReady: true })).toEqual([
      'cd my-agents',
      'npm run dev',
    ]);
  });

  it('copies .env.example and names the key for a cloud provider', () => {
    const steps = nextSteps(
      { ...base, provider: 'anthropic', packageManager: 'pnpm' },
      { installed: false, modelReady: true, directory: 'my-agents' }
    );
    expect(steps.map((s) => s.command)).toEqual([
      'cd my-agents',
      'pnpm install',
      'cp .env.example .env',
      'pnpm dev',
    ]);
    expect(steps[2].note).toContain('ANTHROPIC_API_KEY');
  });

  it('starts Redis before the memory template runs', () => {
    expect(
      commands({ ...base, template: 'memory', docker: true }, { installed: true, modelReady: true })
    ).toContain('docker compose up -d redis');
  });

  it('changes into the directory the project was created in', () => {
    expect(commands(base, { installed: true, modelReady: true, directory: 'apps/bot' })[0]).toBe(
      'cd apps/bot'
    );
  });

  it('leaves out cd when the project is the current directory', () => {
    const steps = nextSteps(base, { installed: true, modelReady: true });
    expect(steps[0].command).not.toMatch(/^cd /);
  });
});

describe('generated README', () => {
  it('walks through .env for a cloud provider', () => {
    const readme = generateReadme({ ...base, provider: 'openai' }).content;
    expect(readme).toContain('cp .env.example .env');
    expect(readme).toContain('OPENAI_API_KEY');
  });

  it('pulls the Ollama model before the first run', () => {
    const readme = generateReadme(base).content;
    expect(readme).toContain('ollama pull qwen3.5:9b');
  });
});

describe('.env.example', () => {
  it('leaves the key empty, so a copied but unedited file is reported as missing', () => {
    expect(generateEnvExample('openai').content).toContain('\nOPENAI_API_KEY=\n');
  });

  it('documents the api-server token and CORS origins', () => {
    const env = generateEnvExample('openai', 'api-server').content;
    expect(env).toContain('API_TOKEN=');
    expect(env).toContain('CORS_ORIGIN');
  });
});

describe('docker compose with Ollama', () => {
  it('pulls the project model into the Ollama volume once the server is healthy', () => {
    const compose = generateDockerCompose('ollama', 'qwen3.5:9b').content;
    expect(compose).toContain('  ollama-pull:');
    expect(compose).toContain('entrypoint: ["ollama", "pull", "qwen3.5:9b"]');
    expect(compose).toContain('OLLAMA_HOST: http://ollama:11434');
    expect(compose).toContain('condition: service_healthy');
  });
});

describe('cogitator.yml for deploy', () => {
  it('declares the in-process memory of the chat templates', () => {
    for (const template of ['api-server', 'nextjs'] as const) {
      expect(generateCogitatorYml('openai', template).content).toContain(
        'memory:\n  adapter: memory\n'
      );
    }
  });

  it('makes deploy require the api-server token next to the provider key', () => {
    const yml = generateCogitatorYml('openai', 'api-server').content;
    expect(yml).toContain('  secrets:\n    - OPENAI_API_KEY\n    - API_TOKEN\n');
    expect(generateCogitatorYml('ollama', 'api-server').content).toContain(
      '  secrets:\n    - API_TOKEN\n'
    );
  });
});
