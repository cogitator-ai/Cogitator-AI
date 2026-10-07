import type { ProjectBuilder } from '../project.js';
import type { ProjectSpec } from '../spec.js';

/**
 * One part of a generated project. Modules run in a fixed order, and each adds
 * what it needs to the builder: files, packages, scripts, variables, services,
 * registry entries and AGENTS.md sections.
 */
export interface FeatureModule {
  id: string;
  applies(spec: ProjectSpec): boolean;
  apply(project: ProjectBuilder): void;
  /**
   * Runs after every module applied: for files that depend on what other
   * modules registered, such as entry points that mount every workflow.
   */
  finalize?(project: ProjectBuilder): void;
}
