/**
 * Skill types: bundles of tools and instructions defined in code (`defineSkill`), and skills read
 * from `SKILL.md` folders in the Agent Skills format (agentskills.io), which an agent loads on
 * demand
 */

import type { Tool } from './tool';
import type { Workspace } from './workspace';

export interface SkillConfig {
  name: string;
  version: string;
  description: string;
  tools: Tool[];
  instructions?: string;
  env?: string[];
  dependencies?: string[];
}

export interface Skill {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly tools: Tool[];
  readonly instructions?: string;
  readonly env?: string[];
  readonly dependencies?: string[];
}

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  missingEnv: string[];
  missingDependencies: string[];
}

/**
 * A skill read from a `SKILL.md` folder: the metadata of its frontmatter and where the folder is.
 * The body of `SKILL.md` and the other files are read when the agent activates the skill.
 */
export interface SkillManifest {
  /** `name` of the frontmatter, the folder name when it has none */
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  /** Environment requirements the skill states, such as the system packages it needs */
  readonly compatibility?: string;
  /** Additional properties, a map of strings */
  readonly metadata?: Readonly<Record<string, string>>;
  /**
   * `allowed-tools` of the frontmatter, split on whitespace: tools the skill declares as
   * pre-approved. Experimental in the format, kept here and not enforced
   */
  readonly allowedTools?: readonly string[];
  /**
   * The skill folder: an absolute path on the host, or a path relative to the workspace root for
   * a skill found in the run's workspace
   */
  readonly location: string;
  /** Whether the folder is on the host or in the run's workspace */
  readonly source: 'host' | 'workspace';
}

/** Something wrong with a `SKILL.md` that a skill loader found, and skipped or tolerated. */
export interface SkillDiagnostic {
  /** `error`: the skill was skipped. `warning`: it was loaded anyway */
  readonly level: 'error' | 'warning';
  readonly message: string;
  /** The `SKILL.md` (or folder) it is about, as `SkillManifest.location` names folders */
  readonly path: string;
}

/** The skills a loader found for a run, with access to their bodies and files. */
export interface SkillCatalog {
  /** Every skill found, one per name, in the order they are shown to the model */
  readonly skills: readonly SkillManifest[];
  readonly diagnostics: readonly SkillDiagnostic[];
  get(name: string): SkillManifest | undefined;
  /** The Markdown body of the skill's `SKILL.md`, without its frontmatter, read now */
  body(name: string): Promise<string>;
  /** Paths of the files in the skill folder, relative to it, `SKILL.md` aside, as many as fit a listing */
  files(name: string): Promise<string[]>;
  /**
   * The text of a file of the skill, `path` relative to its folder. Throws for a path that leaves
   * the folder, symbolic links followed
   */
  readFile(name: string, path: string): Promise<string>;
}

/** What a skill loader may search in, for one run. */
export interface SkillDiscoveryContext {
  /** The run's workspace (`RunOptions.workspace`, else the agent's) */
  readonly workspace?: Workspace;
}

/**
 * Finds `SKILL.md` skills for a run. `SkillRegistry` from `@cogitator-ai/core` reads them from
 * folders on the host and in the run's workspace.
 */
export interface SkillLoader {
  discover(context?: SkillDiscoveryContext): Promise<SkillCatalog>;
}

/**
 * Where a `SkillRegistry` looks for skill folders (folders with a `SKILL.md`). When two skills
 * share a name, the first place in this order wins: `dirs` in the order given, the workspace, the
 * project, the user.
 */
export interface SkillRegistryConfig {
  /** Folders that hold skill folders (or are one: a folder with a `SKILL.md`), searched first */
  dirs?: readonly string[];
  /**
   * Search the run's workspace for project skills, in `.agents/skills`, `.cogitator/skills` and
   * `.claude/skills` under its root (default true)
   */
  workspace?: boolean;
  /** A project folder on the host whose `.agents/skills`, `.cogitator/skills` and `.claude/skills` are searched */
  project?: string;
  /**
   * User skills: `true` searches `.agents/skills`, `.cogitator/skills` and `.claude/skills` in
   * the home folder, a string names another folder to search them in (default false)
   */
  user?: boolean | string;
}

/**
 * What `AgentConfig.skills` takes: a skill defined in code (`defineSkill`), whose tools and
 * instructions join the agent's, or a source of `SKILL.md` skills the agent activates on demand,
 * as a loader (`SkillRegistry`) or the configuration of one.
 */
export type AgentSkillSource = Skill | SkillLoader | SkillRegistryConfig;
