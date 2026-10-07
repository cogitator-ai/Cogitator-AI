import type { Template, TemplateFile } from '../../types.js';

/** What `next build` and `next dev` write next to the sources. */
const NEXT_OUTPUT = ['.next/', 'out/', 'next-env.d.ts'];

export function generateGitignore(template: Template): TemplateFile {
  return {
    path: '.gitignore',
    content: [
      'node_modules/',
      'dist/',
      ...(template === 'nextjs' ? NEXT_OUTPUT : []),
      '.env',
      '.env.*',
      '!.env.example',
      '*.log',
      '*.tsbuildinfo',
      '.DS_Store',
      'coverage/',
      '.turbo/',
      '',
    ].join('\n'),
  };
}
