/**
 * What plugins add, held by generation: a plugin's registrations go into the set of the
 * generation being built, and only a generation that loaded in full becomes live. Undoing a
 * generation runs its disposers in reverse order
 */

import { z } from 'zod';
import type {
  CommandDefinition,
  HookSettings,
  LLMPlugin,
  PermissionLayer,
  PluginDisposer,
  PluginPanelSpec,
  PluginToolSpec,
  RoutineDefinition,
  RunMiddleware,
  SkillLoader,
  SubagentDefinition,
  Tool,
  ToolSchema,
  TriggerSpec,
} from '@cogitator-ai/types';
import { assertToolName } from '../tool-name';
import { toToolParameters } from '../tool-schema';
import type { PluginCodeSkills } from './skills';

/** Hooks a plugin registered, with what their processes get */
export interface PluginHookSet {
  plugin: string;
  hooks: HookSettings;
  /** The file they came from, or `code` */
  source: string;
  /** The layer that enabled the plugin: the managed hook policies apply as for it */
  layer: PermissionLayer;
  /** `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CLAUDE_PLUGIN_OPTION_<KEY>` of the plugin */
  env: Readonly<Record<string, string>>;
}

/** A panel a plugin registered */
export interface PluginPanelEntry {
  plugin: string;
  panel: PluginPanelSpec;
  /** Its HTML file */
  path?: string;
  /** Its page, for one defined in code */
  html?: string;
  handlers: Readonly<Record<string, (params: unknown) => unknown>>;
}

/** A routine a plugin registered, as the trigger manager takes it */
export interface PluginRoutineEntry {
  /** The plugin's id */
  plugin: string;
  /** The routine, named `plugin:id`, with the triggers `registerTrigger` added */
  routine: RoutineDefinition;
}

/** A routine of one generation and the triggers registered for it later */
export class PluginRoutine {
  private merged?: RoutineDefinition;
  readonly extra: TriggerSpec[] = [];

  constructor(readonly routine: RoutineDefinition) {}

  /** The routine with every trigger, the same object until a trigger comes or goes */
  get full(): RoutineDefinition {
    this.merged ??= {
      ...this.routine,
      triggers: [...(this.routine.triggers ?? []), ...this.extra],
    };
    return this.merged;
  }

  changed(): void {
    this.merged = undefined;
  }
}

/** Everything the live generations of the plugins add, in the order the plugins loaded */
export interface PluginSnapshot {
  /** Changes whenever a plugin loads, unloads or a registration comes or goes */
  readonly version: number;
  readonly tools: readonly Tool[];
  readonly skills: readonly SkillLoader[];
  readonly agents: readonly SubagentDefinition[];
  readonly commands: readonly CommandDefinition[];
  readonly hooks: readonly PluginHookSet[];
  readonly middleware: readonly RunMiddleware[];
  /** LLM backend providers by name */
  readonly backends: ReadonlyMap<string, LLMPlugin>;
  /** The id of the plugin each provider of `backends` comes from */
  readonly backendOwners: ReadonlyMap<string, string>;
  readonly panels: readonly PluginPanelEntry[];
  /** Routines for the trigger manager */
  readonly routines: readonly PluginRoutineEntry[];
}

/**
 * A snapshot a run holds until it ends: the generations it was taken from stay loaded, even when
 * a reload replaces them, until every run that holds them released its lease
 */
export interface PluginLease {
  readonly snapshot: PluginSnapshot;
  /** Lets the generations go, once: a replaced one unloads when no other run holds it */
  release(): void;
}

/** The registrations of one generation of one plugin */
export class Contributions {
  readonly tools = new Map<string, Tool>();
  readonly skills: SkillLoader[] = [];
  codeSkills?: PluginCodeSkills;
  readonly agents = new Map<string, SubagentDefinition>();
  readonly commands = new Map<string, CommandDefinition>();
  readonly hooks: PluginHookSet[] = [];
  readonly backends = new Map<string, LLMPlugin>();
  readonly middleware: RunMiddleware[] = [];
  readonly panels = new Map<string, PluginPanelEntry>();
  readonly mcpServers = new Set<string>();
  /** By id with `plugin:` */
  readonly routines = new Map<string, PluginRoutine>();
}

/** A failure of a disposer, kept to report */
export interface DisposeFailure {
  label: string;
  error: unknown;
}

/** One load of a plugin: its registrations, their disposers, and what it waits for */
export class Generation {
  readonly contributions = new Contributions();
  readonly controller = new AbortController();
  private readonly stack: { dispose: () => Promise<void>; label: string }[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  private failure?: { error: unknown };
  private disposed = false;

  constructor(
    readonly number: number,
    /** Called when a registration comes or goes, while the generation is live */
    private readonly changed: () => void
  ) {}

  /** Whether the host serves this generation's registrations */
  live = false;

  /** Whether the generation replaces a live one, which goes on when this one fails to load */
  replacing = false;

  private leases = 0;
  private retire?: () => void;

  /** Keeps the generation loaded for a run that took its registrations */
  hold(): void {
    this.leases++;
  }

  /** Ends one hold, unloading a generation that was retired while held once none is left */
  letGo(): void {
    this.leases--;
    if (this.leases > 0 || !this.retire) return;
    const retire = this.retire;
    this.retire = undefined;
    retire();
  }

  /**
   * Runs `retire` (which unloads the generation) now when no run holds the generation, else once
   * the last one lets it go. Returns whether it ran now
   */
  retireWhenFree(retire: () => void): boolean {
    if (this.leases === 0) {
      retire();
      return true;
    }
    this.retire = retire;
    return false;
  }

  /** Whether runs still hold the generation */
  get held(): boolean {
    return this.leases > 0;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Tells the host the registrations changed */
  touch(): void {
    if (this.live) this.changed();
  }

  /**
   * Keeps `dispose` to run when the generation unloads, returning a disposer that runs it once,
   * now or then, and forgets it
   */
  track(dispose: PluginDisposer, label: string): PluginDisposer {
    let done = false;
    const entry = {
      label,
      dispose: async () => {
        if (done) return;
        done = true;
        await dispose();
      },
    };
    this.stack.push(entry);
    return async () => {
      const at = this.stack.indexOf(entry);
      if (at !== -1) this.stack.splice(at, 1);
      await entry.dispose();
      this.touch();
    };
  }

  /**
   * Something the generation finishes before it counts as loaded. With `fatal`, its failure fails
   * the load: `settled()` throws it
   */
  wait(work: Promise<unknown>, fatal = false): void {
    const kept = work.catch((error: unknown) => {
      if (fatal) this.failure ??= { error };
    });
    this.pending.add(kept);
    void kept.finally(() => this.pending.delete(kept));
  }

  /**
   * Waits for everything `wait` was given, including what that work starts, and throws the first
   * failure of fatal work
   */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
    if (this.failure) throw this.failure.error;
  }

  /**
   * Unloads the generation: aborts its signal and runs its disposers in reverse order. A disposer
   * that throws does not keep the others from running, its failure is returned
   */
  async dispose(): Promise<DisposeFailure[]> {
    if (this.disposed) return [];
    this.disposed = true;
    this.live = false;
    this.controller.abort(new Error('The plugin unloads'));
    const failures: DisposeFailure[] = [];
    for (const entry of this.stack.splice(0).reverse()) {
      try {
        await entry.dispose();
      } catch (error) {
        failures.push({ label: entry.label, error });
      }
    }
    return failures;
  }
}

/** Whether `value` is a tool built by `tool()` or an MCP adapter: Zod parameters and `toJSON` */
export function isBuiltTool(value: Tool | PluginToolSpec): value is Tool {
  return (
    typeof (value as Tool).toJSON === 'function' &&
    typeof (value as { parameters?: unknown }).parameters === 'object' &&
    (value as { parameters?: object }).parameters !== null &&
    '_zod' in ((value as { parameters?: object }).parameters ?? {})
  );
}

/** A tool of a plugin given by a JSON Schema: its arguments are checked against the schema */
export function toolFromSpec(spec: PluginToolSpec): Tool {
  assertToolName(spec.name);
  if (spec.parameters.type !== 'object') {
    throw new TypeError(`The parameters of tool ${spec.name} must be an object schema`);
  }
  let parameters: z.ZodType;
  try {
    parameters = z.fromJSONSchema(spec.parameters as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (error) {
    throw new TypeError(
      `The parameters of tool ${spec.name} are not a JSON Schema Cogitator reads: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const schema: ToolSchema = {
    name: spec.name,
    description: spec.description,
    parameters: toToolParameters(spec.parameters as Record<string, unknown>),
  };
  return {
    name: spec.name,
    description: spec.description,
    parameters: parameters as z.ZodType<unknown>,
    ...(spec.readOnly === true && { annotations: { readOnlyHint: true } }),
    ...(spec.requiresApproval !== undefined && { requiresApproval: spec.requiresApproval }),
    ...(spec.timeout !== undefined && { timeout: spec.timeout }),
    execute: (params, context) =>
      spec.execute((params ?? {}) as Record<string, unknown>, {
        signal: context.signal,
        runId: context.runId,
        ...(context.toolCallId !== undefined && { toolCallId: context.toolCallId }),
        ...(context.threadId !== undefined && { threadId: context.threadId }),
      }),
    toJSON: () => schema,
  };
}
