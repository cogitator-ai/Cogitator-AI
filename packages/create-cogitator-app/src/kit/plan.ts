import { assertCompatible } from './compat.js';
import {
  emitAgentsMd,
  emitCogitatorYml,
  emitCompose,
  emitEnvExample,
  emitEnvFile,
  emitEnvModule,
  emitGitignore,
  emitPackageJson,
  emitPnpmWorkspace,
  emitRegistry,
  emitToolsIndex,
} from './emit.js';
import { emitAssistant } from './features/base.js';
import { FEATURE_MODULES } from './features/index.js';
import { emitReadme, nextSteps, reproducibleCommand, type SetupState } from './guide.js';
import { ProjectBuilder, type EnvVar, type GeneratedFile, type NextStep } from './project.js';
import { parseSpec, type ProjectSpec } from './spec.js';
import { scaffolderVersion } from './versions.js';

export interface PlanOptions {
  /** Values for `.env`, such as the provider key. Never written anywhere else. */
  secrets?: Record<string, string>;
  /** `name@version` of the package manager, written to package.json's `packageManager`. */
  packageManagerSpec?: string;
}

/** Everything a project consists of, computed without touching the disk. */
export interface ProjectPlan {
  spec: ProjectSpec;
  files: GeneratedFile[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  env: EnvVar[];
  /** Compose services the project starts locally. */
  services: string[];
  warnings: string[];
  /** The command that creates this project again. */
  command: string;
  /** The steps to the first run, before anything is installed. */
  nextSteps(state: SetupState): NextStep[];
}

/** What package.json records under `cogitator` so `cogitator add` can grow the project. */
export interface ScaffoldManifest {
  generator: string;
  spec: ProjectSpec;
  command: string;
}

export const MANIFEST_KEY = 'cogitator';

/**
 * The project `spec` describes. Throws when the spec is invalid or its parts do
 * not fit together, before anything is generated.
 */
export function planProject(input: unknown, options: PlanOptions = {}): ProjectPlan {
  const spec = parseSpec(input);
  assertCompatible(spec);

  const project = new ProjectBuilder(spec);
  const active = FEATURE_MODULES.filter((feature) => feature.applies(spec));
  for (const feature of active) feature.apply(project);
  for (const feature of active) feature.finalize?.(project);

  const version = scaffolderVersion();
  const command = reproducibleCommand(spec, version);
  const manifest: ScaffoldManifest = {
    generator: `create-cogitator-app@${version}`,
    spec,
    command,
  };

  emitAssistant(project);
  emitToolsIndex(project);
  emitRegistry(project);
  emitEnvModule(project);
  emitEnvExample(project);
  emitEnvFile(project, options.secrets ?? {});
  emitCompose(project);
  emitCogitatorYml(project);
  emitPnpmWorkspace(project);
  emitGitignore(project);
  emitAgentsMd(project);
  emitReadme(project);
  emitPackageJson(project, {
    packageManagerSpec: options.packageManagerSpec,
    cogitator: { ...manifest },
  });

  const files = [...project.files.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    spec,
    files,
    dependencies: Object.fromEntries(
      [...project.dependencies].sort(([a], [b]) => a.localeCompare(b))
    ),
    devDependencies: Object.fromEntries(
      [...project.devDependencies].sort(([a], [b]) => a.localeCompare(b))
    ),
    scripts: Object.fromEntries(project.scripts),
    env: [...project.env.values()],
    services: spec.compose ? [...project.services.keys()] : [],
    warnings: [...project.warnings],
    command,
    nextSteps: (state) => nextSteps(project, state),
  };
}
