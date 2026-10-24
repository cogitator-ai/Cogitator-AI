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
      expect(result.deployConfig.env).toBeUndefined();
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
