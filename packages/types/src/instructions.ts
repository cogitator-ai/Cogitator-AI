/**
 * Project instructions: the `AGENTS.md` and `CLAUDE.md` files of a workspace the runtime reads into
 * an agent's system prompt
 */

/** Which project instruction files a run reads, see `InstructionsConfig.projectFiles` */
export interface ProjectInstructionsOptions {
  /**
   * The files looked up in each directory from the workspace root down to its `cwd`, in this
   * order within a directory (default `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`,
   * `CLAUDE.local.md`). A file whose content another one already brought (a `CLAUDE.md` that is a
   * symlink to `AGENTS.md`, or imports it) is read once
   */
  files?: readonly string[];
  /**
   * Read the rules of `.claude/rules/` (`*.md`, in subdirectories too) of each of those
   * directories (default true): a rule without `paths` in its frontmatter joins the instructions,
   * a rule with `paths` joins the conversation once a tool reads or edits a file it matches
   */
  rules?: boolean;
  /**
   * Read the instruction files of a directory below the `cwd` once a tool reads or edits a file
   * in it (default true), as Claude Code reads a nested `CLAUDE.md`
   */
  nested?: boolean;
  /** Hops of `@path` imports a file may make, imports of imports included (default 4) */
  maxImportDepth?: number;
  /**
   * Absolute directories outside the workspace an `@path` import may read (`@~/notes.md`
   * included). Default none: an import that leaves the workspace is skipped with a warning
   */
  allowImportsFrom?: readonly string[];
  /**
   * Most characters the instructions take in all, imports and rules included (default 32 000):
   * what is past it is cut, with a notice of what was left out
   */
  maxChars?: number;
}

/** Instructions the runtime adds to agents' system prompts */
export interface InstructionsConfig {
  /**
   * Read the project instruction files of a run's workspace (`AGENTS.md`, and `CLAUDE.md` for
   * Claude Code projects) into the agent's system prompt: `true` for the defaults. Off by default,
   * and a run without a workspace reads none
   */
  projectFiles?: boolean | ProjectInstructionsOptions;
}

/**
 * Why a project instruction file was read: one of the files from the root down to the `cwd`
 * (`project`), an `@path` import of another one (`import`), a rule of `.claude/rules/` without
 * `paths` (`rule`), the file of a directory below the `cwd` a tool reached (`nested`), or a rule
 * whose `paths` match a file a tool reached (`scoped`)
 */
export type InstructionFileReason = 'project' | 'import' | 'rule' | 'nested' | 'scoped';

/** A project instruction file a run read, as `RunResult.instructions` lists it */
export interface LoadedInstructionFile {
  /** The path relative to the workspace root, or the absolute path of an import outside it */
  path: string;
  reason: InstructionFileReason;
  /** The file whose `@path` import brought it */
  importedBy?: string;
  /** Characters of it the instructions hold */
  chars: number;
  /** Whether the size limit (`maxChars`) cut it */
  truncated?: boolean;
}
