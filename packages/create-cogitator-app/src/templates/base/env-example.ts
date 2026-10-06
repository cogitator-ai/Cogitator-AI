import type { LLMProvider, Template, TemplateFile } from '../../types.js';

export function generateEnvExample(provider: LLMProvider, template?: Template): TemplateFile {
  const lines: string[] = ['# Cogitator Environment Variables', ''];

  switch (provider) {
    case 'ollama':
      lines.push('# Ollama (default: http://localhost:11434)');
      lines.push('# OLLAMA_BASE_URL=http://localhost:11434');
      break;
    case 'openai':
      lines.push('# OpenAI, https://platform.openai.com/api-keys');
      lines.push('OPENAI_API_KEY=');
      break;
    case 'anthropic':
      lines.push('# Anthropic, https://console.anthropic.com/settings/keys');
      lines.push('ANTHROPIC_API_KEY=');
      break;
    case 'google':
      lines.push('# Google AI, https://aistudio.google.com/apikey');
      lines.push('GOOGLE_API_KEY=');
      break;
  }

  if (template === 'memory') {
    lines.push('');
    lines.push('# Redis');
    lines.push('REDIS_URL=redis://localhost:6379');
  }

  if (template === 'api-server') {
    lines.push('');
    lines.push('# Bearer token that every API route except health and docs requires.');
    lines.push('# Optional in development, where the server listens on 127.0.0.1 only,');
    lines.push('# required in production (NODE_ENV=production), where it listens on 0.0.0.0.');
    lines.push('API_TOKEN=');
    lines.push('');
    lines.push('# Comma-separated browser origins allowed to call the API, CORS is off without it');
    lines.push('# CORS_ORIGIN=http://localhost:5173');
    lines.push('');
    lines.push('# HOST=127.0.0.1');
    lines.push('# PORT=3000');
  }

  lines.push('');

  return { path: '.env.example', content: lines.join('\n') };
}
