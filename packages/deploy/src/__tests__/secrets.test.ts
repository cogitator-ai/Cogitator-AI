import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectAnalyzer, type AnalyzerResult } from '../analyzer';

describe('secrets a deployment needs', () => {
  let dir: string;
  const analyzer = new ProjectAnalyzer();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-secrets-'));
    write(
      'package.json',
      JSON.stringify({ name: 'app', dependencies: { '@cogitator-ai/express': '^1.0.0' } })
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(file: string, content: string) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), content);
  }

  function analyze(env: NodeJS.ProcessEnv = {}): AnalyzerResult {
    return analyzer.analyze(dir, undefined, { env });
  }

  const emptySecretsCheck = (result: AnalyzerResult) =>
    result.checks.find((c) => c.name === 'Secrets');

  describe('provider routing', () => {
    it('routes a model with an unknown prefix to the default provider, like the runtime', () => {
      write(
        'cogitator.yml',
        'llm:\n  defaultProvider: together\n  defaultModel: meta-llama/Llama-3.3-70B-Instruct-Turbo\n'
      );
      expect(analyze().secrets).toEqual(['TOGETHER_API_KEY']);
    });

    it('requires the Azure endpoint along with the key', () => {
      write('cogitator.yml', 'llm:\n  defaultModel: azure/gpt-5\n');
      expect(analyze().secrets).toEqual(['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT']);
    });

    it('takes a value written in cogitator.yml as provided', () => {
      write(
        'cogitator.yml',
        'llm:\n  defaultModel: azure/gpt-5\n  providers:\n    azure:\n      apiKey: ${AZURE_OPENAI_API_KEY}\n      endpoint: https://acme.openai.azure.com\n'
      );
      expect(analyze().secrets).toEqual(['AZURE_OPENAI_API_KEY']);
    });

    it('passes the alias that is actually set, such as GEMINI_API_KEY', () => {
      write('cogitator.yml', 'llm:\n  defaultModel: google/gemini-3.8-flash\n');
      expect(analyze({ GEMINI_API_KEY: 'g' }).secrets).toEqual(['GEMINI_API_KEY']);
      expect(analyze({}).secrets).toEqual(['GOOGLE_API_KEY']);
    });

    it('needs a region and credentials for Bedrock and forwards a session token', () => {
      write('cogitator.yml', 'llm:\n  defaultModel: bedrock/anthropic.claude\n');
      expect(analyze().secrets).toEqual([
        'AWS_REGION',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
      ]);

      const temporary = analyze({
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'ASIA',
        AWS_SECRET_ACCESS_KEY: 's',
        AWS_SESSION_TOKEN: 't',
        AWS_PROFILE: 'dev',
      });
      expect(temporary.secrets).toEqual([
        'AWS_REGION',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
      ]);
      expect(temporary.warnings.some((w) => w.includes('AWS_SESSION_TOKEN'))).toBe(true);
    });

    it('forwards optional provider settings that are set', () => {
      write('cogitator.yml', 'llm:\n  defaultModel: openai/gpt-6\n');
      expect(analyze({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://proxy' }).secrets).toEqual([
        'OPENAI_API_KEY',
        'OPENAI_BASE_URL',
      ]);
    });
  });

  describe('code-first projects (cogitator init)', () => {
    it('finds the variables the code requires with requireEnv()', () => {
      write(
        'src/gateway.ts',
        [
          "function requireEnv(name: string): string { return process.env[name] ?? '' }",
          "const key = requireEnv('ANTHROPIC_API_KEY');",
          'const token = requireEnv("TELEGRAM_BOT_TOKEN");',
        ].join('\n')
      );
      write('node_modules/x/index.ts', "requireEnv('NOT_MINE');");
      expect(analyze().secrets).toEqual(['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN']);
    });

    it('forwards the .env.example variables that are set', () => {
      write('.env.example', '# Keys\nOPENAI_API_KEY=\nSEARCH_API_KEY=\n# HOST=127.0.0.1\n');
      expect(analyze({ SEARCH_API_KEY: 's' }).secrets).toEqual(['SEARCH_API_KEY']);
    });

    it('fails preflight when nothing was detected but the project .env holds variables', () => {
      write('.env', 'ANTHROPIC_API_KEY=sk-ant\nTELEGRAM_BOT_TOKEN=123\n');
      const check = emptySecretsCheck(analyze());
      expect(check?.passed).toBe(false);
      expect(check?.message).toContain('ANTHROPIC_API_KEY');
      expect(check?.fix).toContain('deploy.secrets');
    });

    it('accepts an explicit empty deploy.secrets', () => {
      write('.env', 'LOCAL_ONLY=1\n');
      write('cogitator.yml', 'deploy:\n  secrets: []\n');
      expect(emptySecretsCheck(analyze())).toBeUndefined();
    });
  });
});
