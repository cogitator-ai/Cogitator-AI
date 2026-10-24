import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DeployTarget } from '@cogitator-ai/types';
import { ProjectAnalyzer, type AnalyzerResult } from '../analyzer';
import { generateProjectArtifacts } from '../providers/artifacts';

describe('what a project deploys as', () => {
  let dir: string;
  const analyzer = new ProjectAnalyzer();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-kind-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(file: string, content: string) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), content);
  }

  function pkg(dependencies: Record<string, string>, extra: Record<string, unknown> = {}) {
    write('package.json', JSON.stringify({ name: 'app', dependencies, ...extra }));
  }

  function analyze(target: DeployTarget = 'docker', env: NodeJS.ProcessEnv = {}): AnalyzerResult {
    return analyzer.analyze(dir, { target }, { env });
  }

  function artifact(result: AnalyzerResult, path: string): string {
    const file = generateProjectArtifacts(result.deployConfig, dir).files.find(
      (f) => f.path === path
    );
    if (!file) throw new Error(`No ${path} generated`);
    return file.content;
  }

  const check = (result: AnalyzerResult, name: string) =>
    result.checks.find((c) => c.name === name);

  describe('kind', () => {
    it('deploys a channel gateway as a worker: no health check, no published port', () => {
      pkg({ '@cogitator-ai/channels': '^1.0.0', grammy: '^1.0.0' });
      const result = analyze();

      expect(result.deployConfig.kind).toBe('worker');
      expect(result.deployConfig.port).toBeUndefined();
      expect(check(result, 'Project kind')?.passed).toBe(true);

      const dockerfile = artifact(result, 'Dockerfile');
      expect(dockerfile).not.toContain('HEALTHCHECK');
      expect(dockerfile).not.toContain('EXPOSE');

      const compose = artifact(result, 'docker-compose.prod.yml');
      expect(compose).not.toContain('ports:');
      expect(compose).toContain('restart: unless-stopped');
    });

    it('keeps a worker running on Fly: no HTTP service the proxy could auto-stop', () => {
      pkg({ '@cogitator-ai/channels': '^1.0.0' });
      const flyToml = artifact(analyze('fly'), 'fly.toml');

      expect(flyToml).not.toContain('[http_service]');
      expect(flyToml).not.toContain('[checks]');
      expect(flyToml).not.toContain('auto_stop_machines = "stop"');
    });

    it('publishes the port of a worker that sets one, without an HTTP health check', () => {
      pkg({ '@cogitator-ai/channels': '^1.0.0' });
      write('cogitator.yml', 'deploy:\n  kind: worker\n  port: 18789\n');
      const result = analyze();

      expect(artifact(result, 'docker-compose.prod.yml')).toContain('"18789:18789"');
      expect(artifact(result, 'Dockerfile')).not.toContain('HEALTHCHECK');

      const flyToml = artifact(analyze('fly'), 'fly.toml');
      expect(flyToml).toContain('internal_port = 18789');
      expect(flyToml).toContain('auto_stop_machines = "off"');
      expect(flyToml).not.toContain('[checks]');
    });

    it('refuses a script that exits after one run instead of restarting it forever', () => {
      pkg({ '@cogitator-ai/core': '^1.0.0' });
      const result = analyze();

      expect(result.deployConfig.kind).toBeUndefined();
      const kind = check(result, 'Project kind');
      expect(kind?.passed).toBe(false);
      expect(kind?.fix).toContain('deploy.kind');
    });

    it('lets deploy.kind override detection', () => {
      pkg({ '@cogitator-ai/core': '^1.0.0' });
      write('cogitator.yml', 'deploy:\n  kind: server\n  health:\n    path: /ready\n');
      const result = analyze();

      expect(result.deployConfig.kind).toBe('server');
      expect(result.deployConfig.port).toBe(3000);
      expect(check(result, 'Project kind')?.passed).toBe(true);
      expect(artifact(result, 'Dockerfile')).toContain('http://127.0.0.1:3000/ready');
    });

    it('detects servers from the Cogitator adapters, Tetsu and Next.js', () => {
      pkg({ '@cogitator-ai/hono': '^1.0.0' });
      expect(analyze().deployConfig).toMatchObject({ kind: 'server', server: 'hono' });
      pkg({ next: '^16.0.0' });
      expect(analyze().deployConfig).toMatchObject({ kind: 'server', server: 'next' });
    });

    it('skips the health check of a server whose health path is unknown, and says so', () => {
      pkg({ next: '^16.0.0' });
      const result = analyze();
      expect(artifact(result, 'Dockerfile')).not.toContain('HEALTHCHECK');
      expect(result.warnings.some((w) => w.includes('deploy.health.path'))).toBe(true);
    });
  });

  describe('package.json', () => {
    it('fails preflight without a package.json instead of failing the image build', () => {
      write('cogitator.yml', 'name: Assistant\npersonality: helpful\nllm:\n  provider: openai\n');
      const packageJson = check(analyze(), 'package.json');
      expect(packageJson?.passed).toBe(false);
      expect(packageJson?.fix).toContain('cogitator up');
    });
  });

  describe('SQLite memory', () => {
    it('keeps the database directory on a named volume across redeploys', () => {
      pkg({ '@cogitator-ai/channels': '^1.0.0', 'better-sqlite3': '^11.0.0' });
      write('cogitator.yml', 'memory:\n  adapter: sqlite\n  sqlite:\n    path: ./data/memory.db\n');
      const result = analyze();

      expect(result.deployConfig.volumes).toEqual([{ path: 'data' }]);
      const compose = artifact(result, 'docker-compose.prod.yml');
      expect(compose).toContain('- data:/app/data');
      expect(compose).toMatch(/^volumes:\n {2}data:/m);
      expect(artifact(result, '.dockerignore').split('\n')).toContain('data');
    });

    it('mounts the volume on Fly', () => {
      pkg({ '@cogitator-ai/channels': '^1.0.0' });
      write('cogitator.yml', 'memory:\n  adapter: sqlite\n  sqlite:\n    path: data/memory.db\n');
      const flyToml = artifact(analyze('fly'), 'fly.toml');
      expect(flyToml).toContain('[mounts]');
      expect(flyToml).toContain('source = "data"');
      expect(flyToml).toContain('destination = "/app/data"');
    });

    it('warns instead of mounting over the app when the database sits in the project root', () => {
      pkg({ '@cogitator-ai/channels': '^1.0.0' });
      write('cogitator.yml', 'memory:\n  adapter: sqlite\n  sqlite:\n    path: ./memory.db\n');
      const result = analyze();
      expect(result.deployConfig.volumes).toBeUndefined();
      expect(result.warnings.some((w) => w.includes('memory.db'))).toBe(true);
    });

    it('fails preflight for more than one volume on Fly', () => {
      pkg({ '@cogitator-ai/channels': '^1.0.0' });
      write('cogitator.yml', 'deploy:\n  volumes:\n    - path: data\n    - path: uploads\n');
      expect(check(analyze('fly'), 'Volumes')?.passed).toBe(false);
      expect(check(analyze('docker'), 'Volumes')).toBeUndefined();
    });
  });

  describe('local Ollama', () => {
    const SERVICE = 'http://ollama:11434';
    const ollamaYml =
      'llm:\n  defaultProvider: ollama\n  defaultModel: qwen3.5:9b\n  providers:\n    ollama:\n      baseUrl: ${OLLAMA_BASE_URL:-http://localhost:11434}\n';

    beforeEach(() => {
      pkg({ '@cogitator-ai/express': '^1.0.0' });
      write('cogitator.yml', ollamaYml);
    });

    it('runs an ollama service next to the app that pulls the model', () => {
      const result = analyze('docker');

      expect(result.deployConfig.services?.ollama).toBe(true);
      expect(result.deployConfig.ollama).toEqual({ models: ['qwen3.5:9b'] });
      expect(result.deployConfig.hostGateway).toBeUndefined();
      expect(result.deployConfig.env).toEqual({
        COGITATOR_OLLAMA_BASE_URL: SERVICE,
        OLLAMA_BASE_URL: SERVICE,
        OLLAMA_URL: SERVICE,
        OLLAMA_HOST: SERVICE,
      });
      expect(result.warnings.some((w) => w.includes('Ollama'))).toBe(false);

      const compose = artifact(result, 'docker-compose.prod.yml');
      expect(compose).toContain('OLLAMA_URL: "http://ollama:11434"');
      expect(compose).toContain('command: ["qwen3.5:9b"]');
      expect(compose).not.toContain('extra_hosts:');
    });

    it('pulls the Ollama embedding model and the models of memory stages', () => {
      write(
        'cogitator.yml',
        `${ollamaYml}memory:\n  embedding:\n    provider: ollama\n    baseUrl: \${OLLAMA_BASE_URL:-http://localhost:11434}\n  extraction:\n    model: ollama/qwen3:4b\n  brief:\n    model: openai/gpt-5-mini\n`
      );
      const result = analyze('docker', { OPENAI_API_KEY: 'sk' });

      expect(result.deployConfig.ollama?.models).toEqual([
        'qwen3.5:9b',
        'qwen3:4b',
        'nomic-embed-text',
      ]);
      expect(result.warnings.some((w) => w.includes('memory.embedding.baseUrl'))).toBe(false);
    });

    it('points a localhost URL found in .env.example at the service instead of forwarding it', () => {
      write('.env.example', 'OLLAMA_BASE_URL=http://localhost:11434\n');
      const result = analyze('docker', { OLLAMA_BASE_URL: 'http://localhost:11434' });

      expect(result.deployConfig.secrets).not.toContain('OLLAMA_BASE_URL');
      expect(result.deployConfig.env?.OLLAMA_BASE_URL).toBe(SERVICE);
      expect(artifact(result, 'docker-compose.prod.yml')).toContain(
        `OLLAMA_BASE_URL: "${SERVICE}"`
      );
    });

    it('pulls the models of reflection, guardrails and prompt injection detection', () => {
      write(
        'cogitator.yml',
        `${ollamaYml}reflection:\n  enabled: true\n  reflectionModel: ollama/qwen3:1.7b\nguardrails:\n  model: ollama/llama-guard3:1b\nsecurity:\n  promptInjection:\n    classifier: llm\n    llmModel: ollama/qwen3:0.6b\n`
      );
      expect(analyze('docker').deployConfig.ollama?.models).toEqual([
        'qwen3.5:9b',
        'qwen3:1.7b',
        'llama-guard3:1b',
        'qwen3:0.6b',
      ]);
    });

    it('pulls no model of a subsystem the runtime leaves off', () => {
      write(
        'cogitator.yml',
        `${ollamaYml}reflection:\n  enabled: false\n  reflectionModel: ollama/qwen3:1.7b\nguardrails:\n  enabled: false\n  model: ollama/llama-guard3:1b\nsecurity:\n  promptInjection:\n    classifier: local\n    llmModel: ollama/qwen3:0.6b\ncontext:\n  enabled: false\n  summaryModel: ollama/qwen3:4b\n`
      );
      expect(analyze('docker').deployConfig.ollama?.models).toEqual(['qwen3.5:9b']);
    });

    it('pulls the model COGITATOR_LLM_DEFAULT_MODEL selects, like loadConfig', () => {
      expect(
        analyze('docker', { COGITATOR_LLM_DEFAULT_MODEL: 'ollama/llama3.2' }).deployConfig.ollama
          ?.models
      ).toEqual(['llama3.2']);

      write(
        'cogitator.yml',
        `${ollamaYml}deploy:\n  env:\n    COGITATOR_LLM_DEFAULT_MODEL: ollama/gemma3:4b\n`
      );
      expect(analyze('docker').deployConfig.ollama?.models).toEqual(['gemma3:4b']);
    });

    it('merges deploy.ollama and deploy.services of overrides field by field', () => {
      write(
        'cogitator.yml',
        `${ollamaYml}deploy:\n  services:\n    redis: true\n  ollama:\n    models: [qwen3:8b]\n    image: ollama/ollama:rocm\n`
      );
      const result = analyzer.analyze(
        dir,
        { target: 'docker', ollama: { gpu: true }, services: { ollama: true } },
        { env: {} }
      );

      expect(result.deployConfig.ollama).toEqual({
        models: ['qwen3:8b'],
        image: 'ollama/ollama:rocm',
        gpu: true,
      });
      expect(result.deployConfig.services).toMatchObject({ redis: true, ollama: true });
    });

    it('pulls the model deploy.env selects for the app', () => {
      write(
        'cogitator.yml',
        'llm:\n  defaultModel: ${CHAT_MODEL:-ollama/qwen3:8b}\ndeploy:\n  env:\n    CHAT_MODEL: ollama/llama3.2\n'
      );
      expect(analyze('docker').deployConfig.ollama?.models).toEqual(['llama3.2']);
    });

    it('decides the chat role from deploy.env, which the deployment sets', () => {
      write(
        'cogitator.yml',
        `${ollamaYml}deploy:\n  env:\n    COGITATOR_OLLAMA_BASE_URL: http://gpu-box:11434\n`
      );
      const result = analyze('docker');

      expect(result.deployConfig.services?.ollama).toBeUndefined();
      expect(result.deployConfig.ollama).toBeUndefined();
      expect(result.deployConfig.env).toEqual({
        COGITATOR_OLLAMA_BASE_URL: 'http://gpu-box:11434',
      });
    });

    it('fails preflight on a model name that would reach ollama as a flag', () => {
      write(
        'cogitator.yml',
        'llm:\n  defaultModel: ollama/--insecure\nmemory:\n  extraction:\n    model: ollama/qwen3:4b\n'
      );
      const result = analyze('docker');

      expect(check(result, 'Ollama models')).toMatchObject({ passed: false });
      expect(check(result, 'Ollama models')?.message).toContain('"--insecure"');
      expect(result.deployConfig.ollama?.models).toEqual(['qwen3:4b']);
    });

    it('does not ask for a local Ollama URL found in .env and .env.example as a secret', () => {
      write('.env', 'OLLAMA_BASE_URL=http://localhost:11434\n');
      write('.env.example', 'OLLAMA_BASE_URL=http://localhost:11434\n');
      const result = analyze('docker', { OLLAMA_BASE_URL: 'http://localhost:11434' });
      expect(check(result, 'Secrets')).toBeUndefined();
      expect(result.deployConfig.env?.OLLAMA_BASE_URL).toBe(SERVICE);
    });

    describe('with llm.defaultProvider: ollama and models only in code', () => {
      const providerOnly = 'llm:\n  defaultProvider: ollama\n';

      it('reaches the Ollama of the host, since there is nothing to pull', () => {
        write('cogitator.yml', providerOnly);
        const result = analyze('docker');

        expect(result.deployConfig.services?.ollama).toBeUndefined();
        expect(result.deployConfig.hostGateway).toBe(true);
        expect(result.deployConfig.env?.COGITATOR_OLLAMA_BASE_URL).toBe(
          'http://host.docker.internal:11434'
        );
        expect(result.warnings.some((w) => w.includes('agents name in code'))).toBe(true);
      });

      it('runs the container for the models deploy.ollama.models lists', () => {
        write('cogitator.yml', `${providerOnly}deploy:\n  ollama:\n    models: [qwen3:8b]\n`);
        const result = analyze('docker');

        expect(result.deployConfig.services?.ollama).toBe(true);
        expect(result.deployConfig.ollama?.models).toEqual(['qwen3:8b']);
        expect(result.deployConfig.env?.COGITATOR_OLLAMA_BASE_URL).toBe(SERVICE);
      });

      it('warns that services.ollama pulls nothing for the chat without a model list', () => {
        write('cogitator.yml', `${providerOnly}deploy:\n  services:\n    ollama: true\n`);
        const result = analyze('docker');

        expect(result.deployConfig.hostGateway).toBeUndefined();
        expect(result.warnings.some((w) => w.includes('pulls none for the chat'))).toBe(true);
      });
    });

    it('warns when services.ollama runs a container nothing uses', () => {
      write(
        'cogitator.yml',
        'llm:\n  defaultModel: openai/gpt-5\ndeploy:\n  services:\n    ollama: true\n'
      );
      const result = analyze('docker', { OPENAI_API_KEY: 'sk' });
      expect(result.warnings.some((w) => w.includes('no model of the config runs on it'))).toBe(
        true
      );
    });

    describe('with roles on different Ollamas', () => {
      const embeddingYml = (baseUrl: string) =>
        `memory:\n  embedding:\n    provider: ollama\n    baseUrl: ${baseUrl}\n`;

      it('keeps a remote chat URL from the config and routes local embeddings to the service', () => {
        write(
          'cogitator.yml',
          `llm:\n  defaultModel: ollama/qwen3:32b\n  providers:\n    ollama:\n      baseUrl: http://gpu-box:11434\n${embeddingYml('${OLLAMA_BASE_URL:-http://localhost:11434}')}`
        );
        const result = analyze('docker');

        expect(result.deployConfig.ollama?.models).toEqual(['nomic-embed-text']);
        expect(result.deployConfig.env).toEqual({ OLLAMA_BASE_URL: SERVICE });
        expect(result.warnings).toEqual(
          expect.not.arrayContaining([expect.stringContaining('memory.embedding.baseUrl')])
        );
      });

      it('forwards a remote chat URL and gives local embeddings their own variable', () => {
        write(
          'cogitator.yml',
          `llm:\n  defaultModel: ollama/qwen3:32b\n${embeddingYml('${OLLAMA_EMBEDDING_URL:-http://localhost:11434}')}`
        );
        const result = analyze('docker', { OLLAMA_HOST: 'gpu-box' });

        expect(result.deployConfig.secrets).toContain('OLLAMA_HOST');
        expect(result.deployConfig.env).toEqual({ OLLAMA_EMBEDDING_URL: SERVICE });
        expect(result.deployConfig.ollama?.models).toEqual(['nomic-embed-text']);
      });

      it('never moves a remote chat URL to reach the embeddings, and says why', () => {
        write(
          'cogitator.yml',
          `llm:\n  defaultModel: ollama/qwen3:32b\n${embeddingYml('${OLLAMA_BASE_URL:-http://localhost:11434}')}`
        );
        const result = analyze('docker', { OLLAMA_URL: 'http://gpu-box:11434' });

        expect(result.deployConfig.secrets).toContain('OLLAMA_URL');
        expect(result.deployConfig.env ?? {}).not.toHaveProperty('OLLAMA_BASE_URL');
        expect(result.deployConfig.env ?? {}).not.toHaveProperty('COGITATOR_OLLAMA_BASE_URL');
        expect(
          result.warnings.some((w) =>
            w.includes('follows OLLAMA_BASE_URL, which the URL of the chat models')
          )
        ).toBe(true);
      });

      it('keeps Ollama Cloud chat models on the cloud while embeddings use the container', () => {
        write(
          'cogitator.yml',
          `llm:\n  defaultModel: ollama/qwen3.5:cloud\n  providers:\n    ollama:\n      baseUrl: https://ollama.com\n      apiKey: \${OLLAMA_API_KEY}\n${embeddingYml('${OLLAMA_BASE_URL:-http://localhost:11434}')}`
        );
        const result = analyze('docker', { OLLAMA_API_KEY: 'key' });

        expect(result.deployConfig.env).toEqual({ OLLAMA_BASE_URL: SERVICE });
        expect(result.deployConfig.ollama?.models).toEqual(['nomic-embed-text']);
        expect(result.deployConfig.secrets).toContain('OLLAMA_API_KEY');
      });

      it('reads an API key without a URL as Ollama Cloud, like the config schema', () => {
        write(
          'cogitator.yml',
          `llm:\n  defaultModel: ollama/qwen3.5:cloud\n${embeddingYml('${OLLAMA_BASE_URL:-http://localhost:11434}')}`
        );
        const result = analyze('docker', { OLLAMA_API_KEY: 'key' });

        expect(result.deployConfig.env ?? {}).not.toHaveProperty('COGITATOR_OLLAMA_BASE_URL');
        expect(result.deployConfig.env ?? {}).not.toHaveProperty('OLLAMA_BASE_URL');
        expect(
          result.warnings.some((w) =>
            w.includes('follows OLLAMA_BASE_URL, which the URL of the chat models')
          )
        ).toBe(true);
      });

      it('forwards the variable a remote chat baseUrl follows', () => {
        write(
          'cogitator.yml',
          'llm:\n  defaultModel: ollama/qwen3:32b\n  providers:\n    ollama:\n      baseUrl: ${GPU_OLLAMA}\n'
        );
        const result = analyze('docker', { GPU_OLLAMA: 'http://gpu-box:11434' });

        expect(result.deployConfig.secrets).toContain('GPU_OLLAMA');
        expect(result.deployConfig.services?.ollama).toBeUndefined();
        expect(result.warnings.some((w) => w.includes('Ollama'))).toBe(false);
      });

      it('does not check the names of models an Ollama elsewhere runs', () => {
        write(
          'cogitator.yml',
          'llm:\n  defaultModel: ollama/--odd\n  providers:\n    ollama:\n      baseUrl: http://gpu-box:11434\n'
        );
        expect(check(analyze('docker'), 'Ollama models')).toBeUndefined();
        write('cogitator.yml', 'llm:\n  defaultModel: ollama/--odd\n');
        expect(check(analyze('fly'), 'Ollama models')).toBeUndefined();
      });

      it('writes only the host into a variable that is the host part of the embedding URL', () => {
        write(
          'cogitator.yml',
          `llm:\n  defaultModel: openai/gpt-5\n${embeddingYml('http://${EMBED_HOST:-localhost}:11434')}`
        );
        const result = analyze('docker', { OPENAI_API_KEY: 'sk' });

        expect(result.deployConfig.env).toMatchObject({ EMBED_HOST: 'ollama' });
        expect(result.warnings.some((w) => w.includes('memory.embedding.baseUrl'))).toBe(false);
      });

      it('leaves a variable alone when no value of it gives the service URL, and warns', () => {
        write(
          'cogitator.yml',
          `llm:\n  defaultModel: openai/gpt-5\n${embeddingYml('http://localhost:${EMBED_PORT:-11434}/v1')}`
        );
        const result = analyze('docker', { OPENAI_API_KEY: 'sk' });

        expect(result.deployConfig.env ?? {}).not.toHaveProperty('EMBED_PORT');
        expect(
          result.warnings.some((w) => w.includes('builds its URL from EMBED_PORT in a way'))
        ).toBe(true);
      });

      it('forwards a host-part variable of a remote chat URL as it is', () => {
        write(
          'cogitator.yml',
          'llm:\n  defaultModel: ollama/qwen3:32b\n  providers:\n    ollama:\n      baseUrl: http://${GPU_HOST}:11434\n'
        );
        const result = analyze('docker', { GPU_HOST: 'gpu-box' });

        expect(result.deployConfig.secrets).toContain('GPU_HOST');
        expect(result.deployConfig.env ?? {}).not.toHaveProperty('GPU_HOST');
        expect(result.deployConfig.services?.ollama).toBeUndefined();
      });

      it('never rewrites a variable an OpenAI-compatible chat server reads', () => {
        write(
          'cogitator.yml',
          `llm:\n  defaultModel: openai/qwen3-32b\n  providers:\n    openai:\n      apiKey: \${OPENAI_API_KEY}\n      baseUrl: \${OLLAMA_BASE_URL:-https://gpu.example.com}/v1\n${embeddingYml('${OLLAMA_EMBEDDING_URL:-http://localhost:11434}')}`
        );
        const result = analyze('docker', { OPENAI_API_KEY: 'sk' });

        expect(result.deployConfig.env).toEqual({ OLLAMA_EMBEDDING_URL: SERVICE });
        expect(result.deployConfig.ollama?.models).toEqual(['nomic-embed-text']);
      });

      it('warns instead when the embeddings share their variable with another provider', () => {
        write(
          'cogitator.yml',
          `llm:\n  defaultModel: openai/qwen3-32b\n  providers:\n    openai:\n      apiKey: \${OPENAI_API_KEY}\n      baseUrl: \${OLLAMA_BASE_URL:-https://gpu.example.com}/v1\n${embeddingYml('${OLLAMA_BASE_URL:-http://localhost:11434}')}`
        );
        const result = analyze('docker', { OPENAI_API_KEY: 'sk' });

        expect(result.deployConfig.env ?? {}).not.toHaveProperty('OLLAMA_BASE_URL');
        expect(result.warnings.some((w) => w.includes('follows OLLAMA_BASE_URL'))).toBe(true);
      });

      it('keeps remote embeddings when only the chat model runs locally', () => {
        write(
          'cogitator.yml',
          `${ollamaYml.replace('${OLLAMA_BASE_URL:-http://localhost:11434}', 'http://localhost:11434')}${embeddingYml('${OLLAMA_BASE_URL}')}`
        );
        const result = analyze('docker', { OLLAMA_BASE_URL: 'http://embed-box:11434' });

        expect(result.deployConfig.ollama?.models).toEqual(['qwen3.5:9b']);
        expect(result.deployConfig.env?.COGITATOR_OLLAMA_BASE_URL).toBe(SERVICE);
        expect(result.deployConfig.env ?? {}).not.toHaveProperty('OLLAMA_BASE_URL');
        expect(result.deployConfig.secrets).toContain('OLLAMA_BASE_URL');
      });
    });

    it('runs Ollama for the embeddings alone when the chat model is elsewhere', () => {
      write(
        'cogitator.yml',
        'llm:\n  defaultModel: openai/gpt-5\nmemory:\n  embedding:\n    provider: ollama\n    model: mxbai-embed-large\n'
      );
      const result = analyze('docker', { OPENAI_API_KEY: 'sk' });

      expect(result.deployConfig.services?.ollama).toBe(true);
      expect(result.deployConfig.ollama?.models).toEqual(['mxbai-embed-large']);
    });

    it('warns when the embedding URL does not follow the Ollama of the deployment', () => {
      write(
        'cogitator.yml',
        `${ollamaYml}memory:\n  embedding:\n    provider: ollama\n    baseUrl: http://localhost:11434\n`
      );
      const result = analyze('docker');
      expect(result.warnings.some((w) => w.includes('memory.embedding.baseUrl'))).toBe(true);
    });

    it('pulls the models deploy.ollama.models lists instead of the detected ones', () => {
      write(
        'cogitator.yml',
        `${ollamaYml}deploy:\n  ollama:\n    gpu: true\n    models: [llama3.3:70b]\n`
      );
      const result = analyze('docker');
      expect(result.deployConfig.ollama).toEqual({ gpu: true, models: ['llama3.3:70b'] });
    });

    it('runs Ollama when services.ollama asks for it without a local model', () => {
      write(
        'cogitator.yml',
        'llm:\n  defaultModel: openai/gpt-5\ndeploy:\n  services:\n    ollama: true\n'
      );
      const result = analyze('docker', { OPENAI_API_KEY: 'sk' });
      expect(result.deployConfig.services).toMatchObject({ ollama: true });
      expect(result.deployConfig.ollama).toEqual({ models: [] });
    });

    describe('with services.ollama off', () => {
      beforeEach(() => {
        write('cogitator.yml', `${ollamaYml}deploy:\n  services:\n    ollama: false\n`);
      });

      it('points the container at the Docker host instead of its own localhost', () => {
        const result = analyze('docker');
        expect(result.deployConfig.services?.ollama).toBe(false);
        expect(result.deployConfig.hostGateway).toBe(true);
        expect(result.deployConfig.env).toMatchObject({
          COGITATOR_OLLAMA_BASE_URL: 'http://host.docker.internal:11434',
          OLLAMA_BASE_URL: 'http://host.docker.internal:11434',
          OLLAMA_URL: 'http://host.docker.internal:11434',
        });
        expect(result.warnings.some((w) => w.includes('host.docker.internal'))).toBe(true);

        const compose = artifact(result, 'docker-compose.prod.yml');
        expect(compose).toContain('extra_hosts:');
        expect(compose).toContain('"host.docker.internal:host-gateway"');
        expect(compose).not.toContain('ollama-pull');
      });

      it('reaches the host for embeddings alone and lists the models to pull there', () => {
        write(
          'cogitator.yml',
          'llm:\n  defaultModel: openai/gpt-5\nmemory:\n  embedding:\n    provider: ollama\n    baseUrl: ${OLLAMA_BASE_URL:-http://localhost:11434}\ndeploy:\n  services:\n    ollama: false\n'
        );
        const result = analyze('docker', { OPENAI_API_KEY: 'sk' });

        expect(result.deployConfig.hostGateway).toBe(true);
        expect(result.deployConfig.env?.OLLAMA_BASE_URL).toBe('http://host.docker.internal:11434');
        expect(result.warnings.some((w) => w.includes('ollama pull nomic-embed-text'))).toBe(true);
      });

      it('keeps redis and postgres detection next to the opt-out', () => {
        write(
          'cogitator.yml',
          `${ollamaYml}memory:\n  adapter: postgres\n  postgres:\n    connectionString: postgres://localhost/db\ndeploy:\n  services:\n    ollama: false\n`
        );
        expect(analyze('docker').deployConfig.services).toEqual({
          redis: false,
          postgres: true,
          ollama: false,
        });
      });

      it('gives each role the port of its own local Ollama on the host', () => {
        write(
          'cogitator.yml',
          'llm:\n  defaultModel: ollama/qwen3:8b\n  providers:\n    ollama:\n      baseUrl: http://localhost:11434\nmemory:\n  embedding:\n    provider: ollama\n    baseUrl: ${OLLAMA_EMBEDDING_URL:-http://localhost:11500}\ndeploy:\n  services:\n    ollama: false\n'
        );
        expect(analyze('docker').deployConfig.env).toMatchObject({
          COGITATOR_OLLAMA_BASE_URL: 'http://host.docker.internal:11434',
          OLLAMA_EMBEDDING_URL: 'http://host.docker.internal:11500',
        });
      });

      it('keeps the port of a local Ollama on another port', () => {
        const env = { OLLAMA_BASE_URL: 'http://127.0.0.1:11500' };
        expect(analyze('docker', env).deployConfig.env).toMatchObject({
          OLLAMA_URL: 'http://host.docker.internal:11500',
        });
      });
    });

    it('forwards an Ollama URL that already points beyond this machine', () => {
      const result = analyze('docker', { OLLAMA_BASE_URL: 'http://gpu-box:11434' });
      expect(result.deployConfig.hostGateway).toBeUndefined();
      expect(result.deployConfig.services?.ollama).toBeUndefined();
      expect(result.deployConfig.secrets).toContain('OLLAMA_BASE_URL');
      expect(result.warnings.some((w) => w.includes('Ollama'))).toBe(false);
    });

    it('warns on Fly, where no local Ollama exists', () => {
      const result = analyze('fly');
      expect(result.deployConfig.hostGateway).toBeUndefined();
      expect(result.deployConfig.services?.ollama).toBeUndefined();
      expect(result.warnings.some((w) => w.includes('Ollama'))).toBe(true);
    });

    it('warns on Fly about services.ollama and local embeddings', () => {
      write(
        'cogitator.yml',
        'llm:\n  defaultModel: openai/gpt-5\nmemory:\n  embedding:\n    provider: ollama\ndeploy:\n  services:\n    ollama: true\n'
      );
      const result = analyze('fly', { OPENAI_API_KEY: 'sk' });
      expect(result.warnings.some((w) => w.includes('docker target only'))).toBe(true);
      expect(result.warnings.some((w) => w.includes('nomic-embed-text'))).toBe(true);
    });
  });

  describe('Redis and Postgres on Fly', () => {
    it('requires REDIS_URL and DATABASE_URL instead of dropping the services', () => {
      pkg({ '@cogitator-ai/express': '^1.0.0' });
      write(
        'cogitator.yml',
        'llm:\n  defaultModel: openai/gpt-4o\ndeploy:\n  services:\n    redis: true\n    postgres: true\n'
      );
      const result = analyze('fly', { OPENAI_API_KEY: 'sk' });

      expect(result.deployConfig.secrets).toEqual(
        expect.arrayContaining(['OPENAI_API_KEY', 'REDIS_URL', 'DATABASE_URL'])
      );
      expect(result.warnings.some((w) => w.includes('fly redis create'))).toBe(true);
      expect(result.warnings.some((w) => w.includes('fly postgres create'))).toBe(true);
    });

    it('keeps provisioning them with Docker Compose on the docker target', () => {
      pkg({ '@cogitator-ai/express': '^1.0.0' });
      write('cogitator.yml', 'memory:\n  adapter: redis\n');
      const result = analyze('docker');
      expect(result.deployConfig.secrets).not.toContain('REDIS_URL');
      expect(artifact(result, 'docker-compose.prod.yml')).toContain(
        'REDIS_URL: "redis://redis:6379"'
      );
    });
  });
});
