export { scaffold } from './scaffold.js';
export { parseArgs, collectOptions } from './prompts.js';
export { getTemplate, templateChoices } from './templates/index.js';
export { detectPackageManager, devCommand } from './utils/package-manager.js';
export { defaultModels, providerConfig, providerEnvKey } from './utils/providers.js';
export { validateProjectName } from './utils/project-name.js';
export type {
  ProjectOptions,
  Template,
  LLMProvider,
  PackageManager,
  TemplateFile,
  ScaffoldResult,
  ScaffoldStep,
} from './types.js';
