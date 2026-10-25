import { resolve } from 'node:path';
import {
  CogitatorError,
  ErrorCode,
  type CommandDefinition,
  type CommandsConfig,
  type DefinitionDiagnostic,
  type DefinitionFileOptions,
  type SubagentCatalog,
  type SubagentDefinition,
  type SubagentsConfig,
} from '@cogitator-ai/types';
import { getLogger } from '../logger';
import {
  definitionDirs,
  parseCommandFile,
  parseSubagentFile,
  scanDefinitionDirs,
  subagentNameProblem,
} from './definitions';

/** The commands a run may expand, and what was wrong with the files */
export interface CommandCatalog {
  readonly commands: readonly CommandDefinition[];
  readonly diagnostics: readonly DefinitionDiagnostic[];
  get(name: string): CommandDefinition | undefined;
}

/** Where a project's definitions are read: the files' options and the project root */
export interface DefinitionPlace {
  options?: DefinitionFileOptions;
  root: string;
  /** The working directory of the run, inside `root`: project folders are read from it up */
  start?: string;
}

/** Logs each diagnostic once and hands it to `onDiagnostic` */
class DiagnosticLog {
  private readonly seen = new Set<string>();

  constructor(
    private readonly what: string,
    private readonly onDiagnostic?: (diagnostic: DefinitionDiagnostic) => void
  ) {}

  report(diagnostics: readonly DefinitionDiagnostic[]): void {
    for (const diagnostic of diagnostics) {
      const key = `${diagnostic.path}\n${diagnostic.message}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      getLogger().warn(
        diagnostic.level === 'error'
          ? `Skipped a ${this.what}: ${diagnostic.message}`
          : `${this.what} loaded with a problem: ${diagnostic.message}`,
        { path: diagnostic.path }
      );
      try {
        this.onDiagnostic?.(diagnostic);
      } catch (error) {
        getLogger().warn('onDiagnostic failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/** The subagents in code, checked once: a name Claude Code would refuse is a mistake in code */
export function codeSubagents(config: SubagentsConfig): SubagentDefinition[] {
  return Object.entries(config.agents ?? {}).map(([name, input]) => {
    const problem = subagentNameProblem(name);
    if (problem) {
      throw new CogitatorError({
        message: `subagents.agents: the name "${name}" ${problem}`,
        code: ErrorCode.CONFIGURATION_ERROR,
      });
    }
    if (typeof input.description !== 'string' || input.description.trim() === '') {
      throw new CogitatorError({
        message: `subagents.agents.${name} needs a description, the model picks subagents by it`,
        code: ErrorCode.CONFIGURATION_ERROR,
      });
    }
    return { ...input, name, prompt: input.prompt ?? '', source: 'code' as const };
  });
}

/** The commands in code, checked once */
export function codeCommands(config: CommandsConfig): CommandDefinition[] {
  return Object.entries(config.commands ?? {}).map(([name, input]) => {
    if (!/^[^\s/:<>][^\s/<>]*$/.test(name) || name.endsWith(':')) {
      throw new CogitatorError({
        message: `commands.commands: "${name}" cannot name a command, use letters, digits, "-", "_" and ":" between parts`,
        code: ErrorCode.CONFIGURATION_ERROR,
      });
    }
    return typeof input === 'string'
      ? { name, template: input, source: 'code' as const }
      : { ...input, name, source: 'code' as const };
  });
}

/**
 * Finds the subagents a run may delegate to: those of the managed directories, then the ones in
 * code, the host's `dirs`, the trusted project's `.agents/agents`, `.cogitator/agents` and
 * `.claude/agents`, and the user's folders, the first one of a name winning. The folders are
 * read for every run, so an edited file counts from the next delegation on, as in Claude Code
 */
export class SubagentFinder {
  private readonly code: SubagentDefinition[];
  /** The folder of definitions each file was found in, by its path */
  private readonly folders = new Map<string, string>();
  private readonly log: DiagnosticLog;

  constructor(config: SubagentsConfig) {
    this.code = codeSubagents(config);
    this.log = new DiagnosticLog('subagent', config.onDiagnostic);
  }

  async catalog(place: DefinitionPlace, signal?: AbortSignal): Promise<SubagentCatalog> {
    const diagnostics: DefinitionDiagnostic[] = [];
    const found: SubagentDefinition[] = [];
    if (place.options) {
      const { dirs } = definitionDirs(
        'agents',
        place.options,
        resolve(place.root),
        place.start ?? place.root
      );
      const managed = dirs.filter((dir) => dir.source === 'managed');
      const rest = dirs.filter((dir) => dir.source !== 'managed');
      found.push(...(await this.read(managed, diagnostics, signal)));
      found.push(...this.code);
      found.push(...(await this.read(rest, diagnostics, signal)));
    } else {
      found.push(...this.code);
    }
    const byName = new Map<string, SubagentDefinition>();
    for (const definition of found) {
      const kept = byName.get(definition.name);
      if (!kept) {
        byName.set(definition.name, definition);
      } else if (
        definition.path !== undefined &&
        kept.path !== undefined &&
        this.folders.get(kept.path) === this.folders.get(definition.path)
      ) {
        diagnostics.push({
          level: 'warning',
          message: `Another ${definition.source} subagent is named "${definition.name}" (${kept.path ?? 'code'}), this one is ignored`,
          path: definition.path,
        });
      }
    }
    this.log.report(diagnostics);
    const agents = [...byName.values()];
    return {
      agents,
      diagnostics,
      get: (name) => byName.get(name),
    };
  }

  private async read(
    dirs: Parameters<typeof scanDefinitionDirs>[0],
    diagnostics: DefinitionDiagnostic[],
    signal?: AbortSignal
  ): Promise<SubagentDefinition[]> {
    const files = await scanDefinitionDirs(dirs, diagnostics, signal);
    const definitions: SubagentDefinition[] = [];
    for (const file of files) {
      const parsed = parseSubagentFile(file.text, { path: file.path, source: file.source });
      this.folders.set(file.path, file.dir);
      diagnostics.push(...parsed.diagnostics);
      if (parsed.definition) definitions.push(parsed.definition);
    }
    return definitions;
  }
}

/**
 * Finds the commands a run's input may name: those of the managed directories, then the ones in
 * code, the host's `dirs`, the trusted project's `commands/` folders and the user's, the first
 * one of a name winning. A file's name is its path under the folder, with `:` between folders
 * (`frontend/component.md` is `/frontend:component`)
 */
export class CommandFinder {
  private readonly code: CommandDefinition[];
  private readonly log: DiagnosticLog;

  constructor(config: CommandsConfig) {
    this.code = codeCommands(config);
    this.log = new DiagnosticLog('command', config.onDiagnostic);
  }

  async catalog(place: DefinitionPlace, signal?: AbortSignal): Promise<CommandCatalog> {
    const diagnostics: DefinitionDiagnostic[] = [];
    const found: CommandDefinition[] = [];
    if (place.options) {
      const { dirs } = definitionDirs(
        'commands',
        place.options,
        resolve(place.root),
        place.start ?? place.root
      );
      const managed = dirs.filter((dir) => dir.source === 'managed');
      const rest = dirs.filter((dir) => dir.source !== 'managed');
      found.push(...(await this.read(managed, diagnostics, signal)));
      found.push(...this.code);
      found.push(...(await this.read(rest, diagnostics, signal)));
    } else {
      found.push(...this.code);
    }
    const byName = new Map<string, CommandDefinition>();
    for (const command of found) {
      if (!byName.has(command.name)) byName.set(command.name, command);
    }
    this.log.report(diagnostics);
    return {
      commands: [...byName.values()],
      diagnostics,
      get: (name) => byName.get(name),
    };
  }

  private async read(
    dirs: Parameters<typeof scanDefinitionDirs>[0],
    diagnostics: DefinitionDiagnostic[],
    signal?: AbortSignal
  ): Promise<CommandDefinition[]> {
    const files = await scanDefinitionDirs(dirs, diagnostics, signal);
    const commands: CommandDefinition[] = [];
    for (const file of files) {
      const name = file.name.split('/').join(':');
      if (/\s|[<>]/.test(name)) {
        diagnostics.push({
          level: 'error',
          message: `"${name}" cannot name a command: rename the file without spaces, "<" or ">"`,
          path: file.path,
        });
        continue;
      }
      const parsed = parseCommandFile(file.text, name, { path: file.path, source: file.source });
      diagnostics.push(...parsed.diagnostics);
      if (parsed.definition) commands.push(parsed.definition);
    }
    return commands;
  }
}
