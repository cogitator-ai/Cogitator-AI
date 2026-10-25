/**
 * Reading the `hooks` of Claude Code compatible settings files: the same files, layers and trust
 * as the permission rules
 */

import { realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  HOOK_EVENTS,
  type HookEventName,
  type HookHandlerConfig,
  type HookSettings,
  type HookSettingsOptions,
  type HooksConfig,
  type PermissionLayer,
} from '@cogitator-ai/types';
import {
  defaultManagedDirs,
  listingOf,
  permissionSettingsPlaces,
  settingsChanged,
} from '../permissions/settings';
import { own } from '../utils/own';

/** A handler as a run's hooks hold it: what it runs, where it came from, what it matches */
export interface LoadedHook {
  event: HookEventName;
  handler: HookHandlerConfig;
  /** The settings file it came from, or `code` */
  source: string;
  layer: PermissionLayer;
  /** The `matcher` of its group, as written */
  matcher?: string;
}

/** The hooks a project's runs use, with the HTTP allowlists of every layer */
export interface LoadedHooks {
  hooks: LoadedHook[];
  /**
   * Lists of URL patterns an HTTP hook's URL must match each of, undefined while no layer sets
   * any: the managed list, the ceiling, and the other layers' together, which only narrow it
   */
  allowedHttpHookUrls?: string[][];
  /** Lists of environment variables a header may name, each of them, as `allowedHttpHookUrls` */
  httpHookAllowedEnvVars?: string[][];
  warnings: string[];
  files: Map<string, number>;
  dirs: Map<string, string>;
}

const common = {
  if: z.string().optional(),
  timeout: z.number().positive().optional(),
  statusMessage: z.string().optional(),
  onFailure: z.enum(['continue', 'block']).optional(),
};

const HandlerSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('command'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    shell: z.enum(['bash', 'powershell']).optional(),
    async: z.boolean().optional(),
    ...common,
  }),
  z.looseObject({
    type: z.literal('http'),
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
    allowedEnvVars: z.array(z.string()).optional(),
    ...common,
  }),
  z.looseObject({
    type: z.literal('prompt'),
    prompt: z.string().min(1),
    model: z.string().optional(),
    continueOnBlock: z.boolean().optional(),
    ...common,
  }),
  z.looseObject({
    type: z.literal('mcp_tool'),
    server: z.string().min(1),
    tool: z.string().min(1),
    input: z.record(z.string(), z.unknown()).optional(),
    ...common,
  }),
]);

const GroupSchema = z.looseObject({
  matcher: z.string().optional(),
  hooks: z.array(z.unknown()),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHookEvent(name: string): name is HookEventName {
  return (HOOK_EVENTS as readonly string[]).includes(name);
}

/** Claude Code events Cogitator has no point for: their hooks are skipped with a warning */
const UNSUPPORTED_EVENTS = new Set([
  'Setup',
  'InstructionsLoaded',
  'UserPromptExpansion',
  'MessageDisplay',
  'PermissionDenied',
  'TaskCreated',
  'TaskCompleted',
  'StopFailure',
  'TeammateIdle',
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'PostModelSwitch',
  'Elicitation',
  'ElicitationResult',
]);

/** Handler fields of Claude Code that Cogitator does not act on, warned about when set */
const UNSUPPORTED_FIELDS = ['asyncRewake', 'once'] as const;

/**
 * The handlers of a `hooks` value (a settings file's, or the one in code), each with where it came
 * from. Problems go to `warnings`, the handlers they concern are left out
 */
export function readHookSettings(
  value: unknown,
  layer: PermissionLayer,
  source: string,
  warnings: string[]
): LoadedHook[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    warnings.push(`${source}: hooks is not an object of events, it is ignored`);
    return [];
  }
  const loaded: LoadedHook[] = [];
  for (const [name, groups] of Object.entries(value)) {
    if (!isHookEvent(name)) {
      warnings.push(
        UNSUPPORTED_EVENTS.has(name)
          ? `${source}: Cogitator has no ${name} event, its hooks are ignored`
          : `${source}: ${name} is not a hook event, its hooks are ignored`
      );
      continue;
    }
    if (!Array.isArray(groups)) {
      warnings.push(`${source}: hooks.${name} is not a list of matcher groups, it is ignored`);
      continue;
    }
    for (const [index, raw] of groups.entries()) {
      const group = GroupSchema.safeParse(raw);
      if (!group.success) {
        warnings.push(`${source}: hooks.${name}[${index}] is not a matcher group, it is ignored`);
        continue;
      }
      for (const [at, entry] of group.data.hooks.entries()) {
        const handler = HandlerSchema.safeParse(entry);
        if (!handler.success) {
          const type = isRecord(entry) ? entry.type : undefined;
          warnings.push(
            type === 'agent'
              ? `${source}: hooks.${name}[${index}].hooks[${at}] is an agent hook, which Cogitator does not run, it is ignored`
              : `${source}: hooks.${name}[${index}].hooks[${at}] is not a valid hook handler (${handler.error.issues[0]?.message ?? 'invalid'}), it is ignored`
          );
          continue;
        }
        for (const field of UNSUPPORTED_FIELDS) {
          if (isRecord(entry) && Object.hasOwn(entry, field)) {
            warnings.push(
              `${source}: hooks.${name}[${index}].hooks[${at}] sets ${field}, which Cogitator does not support, it is ignored`
            );
          }
        }
        loaded.push({
          event: name,
          handler: handler.data as HookHandlerConfig,
          source,
          layer,
          ...(group.data.matcher !== undefined && { matcher: group.data.matcher }),
        });
      }
    }
  }
  return loaded;
}

function stringList(value: unknown, field: string, origin: string, warnings: string[]) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    warnings.push(`${origin}: ${field} is not a list, it is ignored`);
    return undefined;
  }
  return value.filter((entry): entry is string => {
    if (typeof entry === 'string') return true;
    warnings.push(`${origin}: an entry of ${field} is not a string, it is ignored`);
    return false;
  });
}

/** What one settings file says about hooks */
interface FileHooks {
  layer: Exclude<PermissionLayer, 'session'>;
  origin: string;
  hooks: LoadedHook[];
  disableAllHooks?: boolean;
  allowManagedHooksOnly?: boolean;
  allowedHttpHookUrls?: string[];
  httpHookAllowedEnvVars?: string[];
}

/**
 * Reads the hooks of the settings files for the project at `root`, layer by layer as the
 * permission rules are read (managed, local, project, user, the `.claude/` and `.cogitator/` files),
 * with `code` (the hooks given in code) on top. `disableAllHooks` takes the value of the highest
 * layer that sets it, and only a managed one turns managed hooks off. `allowManagedHooksOnly` in
 * a managed file leaves out the user, project and local hooks. The project's own files count
 * only for a trusted project (see {@link trustsProject}), an untrusted one's give nothing
 */
export async function loadHookSettings(
  root: string,
  options: HookSettingsOptions | undefined,
  code: CodeHooks | undefined,
  scoped?: ScopedHooks
): Promise<LoadedHooks> {
  const trusted = options !== undefined && trustsProject(options, root);
  const warnings: string[] = [];
  const files = new Map<string, number>();
  const dirs = new Map<string, string>();
  const fromFiles: FileHooks[] = [];
  if (options) {
    const places = await permissionSettingsPlaces(root, options);
    const wanted = new Set(options.layers ?? ['managed', 'user', 'project', 'local']);
    for (const layer of ['managed', 'local', 'project', 'user'] as const) {
      if (!wanted.has(layer)) continue;
      for (const file of places[layer]) {
        const read = await readSettingsFile(file, files, warnings);
        if (read === undefined) continue;
        const project = layer === 'project' || layer === 'local';
        const mentions =
          read.hooks !== undefined ||
          read.disableAllHooks !== undefined ||
          read.allowedHttpHookUrls !== undefined;
        if (project && !trusted) {
          if (mentions) {
            warnings.push(
              `${file}: the project ${root} is not trusted, its hooks are ignored (trust it with hooks.settings.trusted and root, or trustedRoots)`
            );
          }
          continue;
        }
        fromFiles.push({
          layer,
          origin: file,
          hooks: readHookSettings(read.hooks, layer, file, warnings),
          ...(typeof read.disableAllHooks === 'boolean' && {
            disableAllHooks: read.disableAllHooks,
          }),
          ...(layer === 'managed' &&
            read.allowManagedHooksOnly === true && { allowManagedHooksOnly: true }),
          ...listField(read, 'allowedHttpHookUrls', file, warnings),
          ...listField(read, 'httpHookAllowedEnvVars', file, warnings),
        });
      }
    }
    if (wanted.has('managed')) {
      for (const dir of options.managedDirs ?? defaultManagedDirs()) {
        const dropIns = join(dir, 'managed-settings.d');
        dirs.set(dropIns, await listingOf(dropIns));
      }
    }
  }
  const disabledBy = fromFiles.find((file) => file.disableAllHooks !== undefined);
  const managedOnly = fromFiles.some((file) => file.allowManagedHooksOnly === true);
  const allowed = (layer: PermissionLayer): boolean => {
    if (disabledBy?.disableAllHooks === true) {
      if (disabledBy.layer === 'managed' || layer !== 'managed') return false;
    }
    return !managedOnly || layer === 'managed';
  };
  const hooks: LoadedHook[] = scoped
    ? allowed(scoped.layer)
      ? readHookSettings(scoped.hooks, scoped.layer, scoped.source, warnings)
      : []
    : readHookSettings(code?.hooks, 'session', 'code', warnings);
  if (scoped && !allowed(scoped.layer) && Object.keys(scoped.hooks).length > 0) {
    warnings.push(
      `${scoped.source}: the managed settings turn off hooks (disableAllHooks or allowManagedHooksOnly), its hooks are ignored`
    );
  }
  for (const file of fromFiles) {
    if (scoped || !allowed(file.layer)) continue;
    hooks.push(...file.hooks);
  }
  const urls = layeredLists(fromFiles, code?.allowedHttpHookUrls, 'allowedHttpHookUrls');
  const envs = layeredLists(fromFiles, code?.httpHookAllowedEnvVars, 'httpHookAllowedEnvVars');
  return {
    hooks: dedupe(hooks),
    ...(urls && { allowedHttpHookUrls: urls }),
    ...(envs && { httpHookAllowedEnvVars: envs }),
    warnings,
    files,
    dirs,
  };
}

/**
 * Hooks of one definition instead of the settings files' and the code's, such as a subagent's
 * frontmatter: the settings files still decide whether they run (`disableAllHooks`,
 * `allowManagedHooksOnly`) and what HTTP hooks may reach, as for hooks of their `layer`
 */
export interface ScopedHooks {
  hooks: HookSettings;
  layer: PermissionLayer;
  /** The file they come from */
  source: string;
}

/** The hooks and HTTP allowlists given in code, see `HooksConfig` */
export type CodeHooks = Pick<
  HooksConfig,
  'hooks' | 'allowedHttpHookUrls' | 'httpHookAllowedEnvVars'
>;

/**
 * Whether the project at `root` is trusted: it is one of `trustedRoots`, or `trusted` is true and
 * it is the `root` the options name (the working directory of the process without one). Paths
 * are compared once symlinks are followed
 */
export function trustsProject(options: HookSettingsOptions, root: string): boolean {
  const real = realOf(root);
  const roots = [
    ...(options.trustedRoots ?? []),
    ...(options.trusted === true ? [options.root ?? process.cwd()] : []),
  ];
  return roots.some((trusted) => realOf(trusted) === real);
}

function realOf(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/**
 * The allowlists an HTTP hook must pass each of: the managed files' list is the ceiling, the
 * lists of the other layers and the code together narrow it. Without a managed list the others
 * together are the one list, as Claude Code merges them. Undefined while nobody sets one
 */
function layeredLists(
  files: readonly FileHooks[],
  code: readonly string[] | undefined,
  field: 'allowedHttpHookUrls' | 'httpHookAllowedEnvVars'
): string[][] | undefined {
  const managed = files.filter((file) => file.layer === 'managed' && file[field] !== undefined);
  const lower = files.filter((file) => file.layer !== 'managed' && file[field] !== undefined);
  const lists: string[][] = [];
  if (managed.length > 0) lists.push(managed.flatMap((file) => file[field] ?? []));
  if (lower.length > 0 || code !== undefined) {
    lists.push([...lower.flatMap((file) => file[field] ?? []), ...(code ?? [])]);
  }
  return lists.length > 0 ? lists : undefined;
}

function listField(
  read: Record<string, unknown>,
  field: 'allowedHttpHookUrls' | 'httpHookAllowedEnvVars',
  origin: string,
  warnings: string[]
): Partial<Record<typeof field, string[]>> {
  const list = stringList(own(read, field), field, origin, warnings);
  return list ? { [field]: list } : {};
}

async function readSettingsFile(
  file: string,
  files: Map<string, number>,
  warnings: string[]
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    files.set(file, 0);
    return undefined;
  }
  files.set(file, await changedAt(file));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    warnings.push(
      `${file}: not valid JSON (${error instanceof Error ? error.message : String(error)}), its hooks are ignored`
    );
    return undefined;
  }
  if (!isRecord(json)) {
    warnings.push(`${file}: the file does not hold a JSON object, its hooks are ignored`);
    return undefined;
  }
  return json;
}

async function changedAt(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The hooks with each handler of an event and matcher once: the same handler in several files
 * runs once, from the highest layer
 */
function dedupe(hooks: readonly LoadedHook[]): LoadedHook[] {
  const seen = new Set<string>();
  return hooks.filter((hook) => {
    const key = JSON.stringify([hook.event, hook.matcher ?? '', sortedJson(hook.handler)]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedJson(value[key])])
  );
}

/** The hooks of a project, read again once a settings file changed */
export class HookSettingsCache {
  private readonly loads = new Map<string, Promise<LoadedHooks>>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly options: HookSettingsOptions | undefined,
    private readonly code: CodeHooks | undefined,
    private readonly warn: (warning: string) => void,
    private readonly scoped?: ScopedHooks
  ) {}

  async load(root: string): Promise<LoadedHooks> {
    let loading = this.loads.get(root);
    if (loading) {
      const loaded = await loading.catch(() => undefined);
      if (!loaded || (await settingsChanged(loaded.files, loaded.dirs))) loading = undefined;
    }
    if (!loading) {
      loading = loadHookSettings(root, this.options, this.code, this.scoped);
      this.loads.set(root, loading);
    }
    const loaded = await loading;
    for (const warning of loaded.warnings) {
      if (this.warned.has(warning)) continue;
      this.warned.add(warning);
      this.warn(warning);
    }
    return loaded;
  }
}
