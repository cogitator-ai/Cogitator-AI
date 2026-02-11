import type { TemplateFile } from '../../types.js';

export function generateGitignore(): TemplateFile {
  return {
    path: '.gitignore',
    content: [
      'node_modules/',
      'dist/',
      '.env',
      '.env.local',
      '*.log',
      '.DS_Store',
      'coverage/',
      '.turbo/',
      '',
    ].join('\n'),
  };
}
