import type { LLMProvider, Template, TemplateFile } from '../../types.js';

export function generateEnvExample(provider: LLMProvider, template?: Template): TemplateFile {
  const lines: string[] = ['# Cogitator Environment Variables', ''];

  switch (provider) {
    case 'ollama':
      lines.push('# Ollama (default: http://localhost:11434)');
      lines.push('# OLLAMA_BASE_URL=http://localhost:11434');
      break;
    case 'openai':
      lines.push('# OpenAI');
      lines.push('OPENAI_API_KEY=sk-...');
      break;
    case 'anthropic':
      lines.push('# Anthropic');
      lines.push('ANTHROPIC_API_KEY=sk-ant-...');
      break;
    case 'google':
      lines.push('# Google AI');
      lines.push('GOOGLE_API_KEY=...');
      break;
  }

  if (template === 'memory') {
    lines.push('');
    lines.push('# Redis');
    lines.push('REDIS_URL=redis://localhost:6379');
  }

  lines.push('');

  return { path: '.env.example', content: lines.join('\n') };
}
