import type { LLMProvider, TemplateFile } from '../../types.js';

export function generateEnvExample(provider: LLMProvider): TemplateFile {
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

  lines.push('');

  return { path: '.env.example', content: lines.join('\n') };
}
