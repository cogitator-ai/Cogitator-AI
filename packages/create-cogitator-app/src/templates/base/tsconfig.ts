import type { TemplateFile } from '../../types.js';

export function generateTsconfig(): TemplateFile {
  return {
    path: 'tsconfig.json',
    content: JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          esModuleInterop: true,
          strict: true,
          skipLibCheck: true,
          outDir: 'dist',
          rootDir: 'src',
          declaration: true,
          resolveJsonModule: true,
          isolatedModules: true,
        },
        include: ['src'],
      },
      null,
      2
    ),
  };
}
