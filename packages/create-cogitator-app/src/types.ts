export type Template = 'basic' | 'memory' | 'swarm' | 'workflow' | 'api-server' | 'nextjs';

export type LLMProvider = 'ollama' | 'openai' | 'anthropic' | 'google';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface ProjectOptions {
  name: string;
  path: string;
  template: Template;
  provider: LLMProvider;
  /**
   * The model the agents use, without the provider prefix (`qwen3.5:9b`, `gpt-6.1-sol`).
   * Defaults to the provider's entry in `defaultModels`.
   */
  model?: string;
  packageManager: PackageManager;
  docker: boolean;
  git: boolean;
  /** Run `<packageManager> install` after writing the files (default `true`). */
  install?: boolean;
}

/** How an optional step of `scaffold()` went. */
export type ScaffoldStep =
  { status: 'done' } | { status: 'skipped' } | { status: 'failed'; error: Error };

/** What `scaffold()` did: the project is written even when a later step failed. */
export interface ScaffoldResult {
  /** The generated files, relative to the project directory. */
  files: string[];
  /** `<packageManager> install`, skipped with `install: false`. */
  install: ScaffoldStep;
  /** `git init` and the first commit, skipped with `git: false` or when git is not installed. */
  git: ScaffoldStep;
}

export interface TemplateFile {
  path: string;
  content: string;
}

export interface TemplateGenerator {
  /**
   * The path the generated app answers health checks on, written to
   * cogitator.yml as `deploy.health.path` so `cogitator deploy` probes it.
   * Absent for templates that run as scripts rather than servers.
   */
  healthPath?: string;
  /**
   * The memory adapter the generated code configures, written to cogitator.yml so
   * `cogitator deploy` provisions the services it needs. Absent when it keeps none.
   */
  memoryAdapter?: 'memory' | 'redis';
  /**
   * Environment variables the deployed app needs besides the provider key, written
   * to cogitator.yml as `deploy.secrets` together with that key.
   */
  secrets?: string[];
  files(options: ProjectOptions): TemplateFile[];
  dependencies(): Record<string, string>;
  devDependencies(): Record<string, string>;
  scripts(): Record<string, string>;
}
