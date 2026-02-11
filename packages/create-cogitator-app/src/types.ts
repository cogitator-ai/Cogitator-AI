export type Template = 'basic' | 'memory' | 'swarm' | 'workflow' | 'api-server' | 'nextjs';

export type LLMProvider = 'ollama' | 'openai' | 'anthropic' | 'google';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface ProjectOptions {
  name: string;
  path: string;
  template: Template;
  provider: LLMProvider;
  packageManager: PackageManager;
  docker: boolean;
  git: boolean;
}

export interface TemplateFile {
  path: string;
  content: string;
}

export interface TemplateGenerator {
  files(options: ProjectOptions): TemplateFile[];
  dependencies(): Record<string, string>;
  devDependencies(): Record<string, string>;
  scripts(): Record<string, string>;
}
