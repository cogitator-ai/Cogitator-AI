import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactGenerator, ProjectAnalyzer } from '@cogitator-ai/deploy';

const composeAvailable =
  spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;
const describeCompose = composeAvailable ? describe : describe.skip;

interface ResolvedService {
  image?: string;
  command?: string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition: string }>;
  volumes?: { source?: string; target?: string }[];
}

interface ResolvedCompose {
  services: Record<string, ResolvedService>;
  volumes?: Record<string, unknown>;
}

describeCompose('deploy: compose file with a local Ollama model', () => {
  let projectDir: string;
  let composeFile: string;
  let resolved: ResolvedCompose;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'cogitator-deploy-ollama-'));
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({
        name: 'ollama-agent',
        scripts: { start: 'node server.js' },
        dependencies: { '@cogitator-ai/express': '^1.0.0' },
      })
    );
    writeFileSync(
      join(projectDir, 'cogitator.yml'),
      [
        'llm:',
        '  defaultModel: ollama/qwen3:8b',
        'memory:',
        '  adapter: redis',
        '  embedding:',
        '    provider: ollama',
        '    baseUrl: ${OLLAMA_BASE_URL:-http://localhost:11434}',
        'deploy:',
        '  health:',
        '    path: /health',
        '',
      ].join('\n')
    );

    const analysis = new ProjectAnalyzer().analyze(projectDir, { target: 'docker' }, { env: {} });
    const artifacts = new ArtifactGenerator().generate(analysis.deployConfig, analysis);
    mkdirSync(join(projectDir, artifacts.outputDir));
    for (const file of artifacts.files) {
      writeFileSync(join(projectDir, artifacts.outputDir, file.path), file.content);
    }
    composeFile = join(projectDir, artifacts.outputDir, 'docker-compose.prod.yml');

    const config = spawnSync(
      'docker',
      ['compose', '-p', 'ollama-agent', '-f', composeFile, 'config', '--format', 'json'],
      { encoding: 'utf-8' }
    );
    if (config.status !== 0) throw new Error(`docker compose config failed: ${config.stderr}`);
    resolved = JSON.parse(config.stdout) as ResolvedCompose;
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('is a valid compose file with the app, redis, ollama and the pull job', () => {
    expect(Object.keys(resolved.services).sort()).toEqual([
      'app',
      'ollama',
      'ollama-pull',
      'redis',
    ]);
    expect(Object.keys(resolved.volumes ?? {}).sort()).toEqual(['ollama-data', 'redis-data']);
  });

  it('keeps the models in a named volume', () => {
    expect(resolved.services.ollama.volumes).toEqual([
      expect.objectContaining({ source: 'ollama-data', target: '/root/.ollama' }),
    ]);
  });

  it('pulls the chat and embedding models before the app starts', () => {
    expect(resolved.services['ollama-pull'].command).toEqual(['qwen3:8b', 'nomic-embed-text']);
    expect(resolved.services.app.depends_on).toMatchObject({
      redis: { condition: 'service_healthy' },
      ollama: { condition: 'service_healthy' },
      'ollama-pull': { condition: 'service_completed_successfully' },
    });
  });

  it('points the app at the ollama service', () => {
    expect(resolved.services.app.environment).toMatchObject({
      OLLAMA_HOST: 'http://ollama:11434',
      OLLAMA_URL: 'http://ollama:11434',
      REDIS_URL: 'redis://redis:6379',
    });
  });
});
