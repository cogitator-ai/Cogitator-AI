import { describe, it, expect } from 'vitest';
import { ProjectAnalyzer } from '../analyzer';

describe('ProjectAnalyzer', () => {
  it('detects server from package.json dependencies', () => {
    const analyzer = new ProjectAnalyzer();
    const result = analyzer.detectServer({
      dependencies: { '@cogitator-ai/express': '^0.1.0' },
    });
    expect(result).toBe('express');
  });

  it('detects hono server', () => {
    const analyzer = new ProjectAnalyzer();
    const result = analyzer.detectServer({
      dependencies: { '@cogitator-ai/hono': '^0.1.0' },
    });
    expect(result).toBe('hono');
  });

  it('returns undefined when no server detected', () => {
    const analyzer = new ProjectAnalyzer();
    const result = analyzer.detectServer({ dependencies: {} });
    expect(result).toBeUndefined();
  });

  it('detects redis service from memory config', () => {
    const analyzer = new ProjectAnalyzer();
    const services = analyzer.detectServices({ memory: { adapter: 'redis' } });
    expect(services.redis).toBe(true);
    expect(services.postgres).toBe(false);
  });

  it('detects postgres service from memory config', () => {
    const analyzer = new ProjectAnalyzer();
    const services = analyzer.detectServices({ memory: { adapter: 'postgres' } });
    expect(services.redis).toBe(false);
    expect(services.postgres).toBe(true);
  });

  it('detects required secrets from LLM provider', () => {
    const analyzer = new ProjectAnalyzer();
    const secrets = analyzer.detectSecrets('openai/gpt-4o');
    expect(secrets).toContain('OPENAI_API_KEY');
  });

  it('detects Ollama Cloud when model has :cloud tag', () => {
    const analyzer = new ProjectAnalyzer();
    const result = analyzer.isOllamaCloud('qwen3.5:cloud');
    expect(result).toBe(true);
  });

  it('detects local Ollama for regular models', () => {
    const analyzer = new ProjectAnalyzer();
    const result = analyzer.isOllamaCloud('llama3.2:3b');
    expect(result).toBe(false);
  });

  it('warns about local Ollama in cloud deploy', () => {
    const analyzer = new ProjectAnalyzer();
    const warnings = analyzer.getDeployWarnings('ollama/llama3.2:3b', 'fly');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('Ollama');
  });

  it('no Ollama warning for cloud models', () => {
    const analyzer = new ProjectAnalyzer();
    const warnings = analyzer.getDeployWarnings('ollama/qwen3.5:cloud', 'fly');
    expect(warnings.length).toBe(0);
  });
});
