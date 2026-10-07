export {
  scaffold,
  silentLogger,
  readLock,
  writeLock,
  writeFiles,
  formatProject,
  hashContent,
  updateLock,
  LOCK_PATH,
} from './kit/scaffold.js';
export { planAdd, addToProject, AddConflictError, NotAScaffoldedProjectError } from './kit/add.js';
export type {
  AddChanges,
  AddPlan,
  AddOptions,
  AddResult,
  AddConflict,
  AddNote,
  FileChange,
} from './kit/add.js';
export { unifiedDiff } from './kit/diff.js';
export {
  examples,
  findExample,
  planExample,
  fetchExampleFiles,
  exampleRef,
  exampleFileUrl,
  parseExampleArgument,
} from './kit/examples.js';
export type { ExampleEntry, ExamplePlan, ExamplePlanOptions } from './kit/examples.js';
export {
  downloadTemplate,
  prepareTemplate,
  describeTemplate,
  templateArchive,
} from './kit/remote.js';
export type { RemoteTemplate, DownloadResult, PreparedTemplate } from './kit/remote.js';
export { createFromExample, createFromTemplate, resolveExample } from './kit/starter.js';
export type { StarterOptions, StarterResult } from './kit/starter.js';
export type {
  ScaffoldOptions,
  ScaffoldResult,
  ScaffoldLogger,
  ScaffoldLock,
  StepResult,
} from './kit/scaffold.js';
export { planProject, MANIFEST_KEY } from './kit/plan.js';
export type { ProjectPlan, PlanOptions, ScaffoldManifest } from './kit/plan.js';
export {
  ProjectSpecSchema,
  parseSpec,
  validateProjectName,
  qualifiedModel,
  bareModel,
  APP_KINDS,
  SERVERS,
  MEMORIES,
  VECTOR_STORES,
  FEATURES,
  DEPLOY_TARGETS,
  CODING_AGENTS,
  PACKAGE_MANAGERS,
  CHANNELS,
  PROVIDERS,
} from './kit/spec.js';
export type {
  ProjectSpec,
  ProjectSpecInput,
  AppKind,
  ServerFramework,
  MemoryKind,
  VectorStore,
  FeatureId,
  DeployTarget,
  CodingAgent,
  PackageManager,
  ChannelKind,
  LLMProvider,
} from './kit/spec.js';
export { compatibilityIssues, assertCompatible, IncompatibleSpecError } from './kit/compat.js';
export type { CompatIssue } from './kit/compat.js';
export { PRESETS, findPreset, presetIds, DEFAULT_PRESET } from './kit/presets.js';
export type { Preset } from './kit/presets.js';
export {
  APP_CHOICES,
  SERVER_CHOICES,
  MEMORY_CHOICES,
  VECTOR_STORE_CHOICES,
  FEATURE_CHOICES,
  DEPLOY_CHOICES,
  CHANNEL_CHOICES,
  CODING_AGENT_CHOICES,
} from './kit/catalog.js';
export type { Choice } from './kit/catalog.js';
export {
  PROVIDER_INFO,
  providerInfo,
  providerEnvKey,
  defaultModel,
  OLLAMA_SUGGESTED_MODELS,
  DEFAULT_OLLAMA_URL,
} from './kit/providers.js';
export type { ProviderInfo } from './kit/providers.js';
export {
  modelChoices,
  cloudModelChoices,
  ollamaModelChoices,
  describeModel,
} from './kit/models.js';
export type { ModelChoice, ModelChoices, ModelSource } from './kit/models.js';
export { checkApiKey, describeKeyCheck } from './kit/key-check.js';
export type { KeyCheck } from './kit/key-check.js';
export {
  listOllamaModels,
  hasOllamaModel,
  pullOllamaModel,
  resolveOllamaUrl,
} from './kit/ollama.js';
export type { OllamaModel } from './kit/ollama.js';
export {
  detectPackageManager,
  detectPackageManagerSpec,
  runScript,
  execCommand,
  installCommand,
} from './kit/package-manager.js';
export {
  cogitatorVersion,
  knownCogitatorVersions,
  scaffolderVersion,
  VERSIONS,
  IMAGES,
} from './kit/versions.js';
export { run } from './cli/main.js';
export { closest } from './cli/args.js';
