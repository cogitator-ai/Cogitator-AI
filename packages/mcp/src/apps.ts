import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from '@modelcontextprotocol/ext-apps/server';
import type {
  ToolApp,
  ToolAppCsp,
  ToolAppPermissions,
  ToolAppResource,
  ToolAppVisibility,
} from '@cogitator-ai/types';

/** The identifier of the MCP Apps extension, the key of its capability in `extensions` */
export const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui';

/** The MIME type of an MCP App's HTML */
export const MCP_APP_MIME_TYPE: string = RESOURCE_MIME_TYPE;

/** The flat `_meta` key older hosts read the app of a tool from, next to `_meta.ui.resourceUri` */
export const MCP_APP_LEGACY_META_KEY: string = RESOURCE_URI_META_KEY;

/** The app a tool of an MCP server points at, as its `_meta.ui` names it */
export interface MCPToolAppRef {
  /** The `ui://` resource of the app */
  resourceUri: string;
  /** Who may call the tool, `['model', 'app']` when the server names none */
  visibility?: ToolAppVisibility[];
}

/** What a server says of an app resource: `_meta.ui` of the resource or of its content */
export interface MCPAppMeta {
  csp?: ToolAppCsp;
  permissions?: ToolAppPermissions;
  /** A dedicated origin for the app, in the format its host documents */
  domain?: string;
  /** Whether the app wants a border and background from its host */
  prefersBorder?: boolean;
}

/** An app an `MCPServer` serves (`registerApp`), or a tool carries (`mcpApp`) */
export interface MCPAppConfig extends MCPAppMeta {
  /** The `ui://` URI of the app */
  uri: string;
  /** The name of the resource, for people */
  name?: string;
  description?: string;
  /** The app's HTML, a whole HTML5 document, or a function that builds it each time it is read */
  html: string | (() => string | Promise<string>);
}

/** A tool's app given by an `MCPAppConfig`, see `mcpApp()` */
export interface MCPToolAppConfig extends MCPAppConfig {
  /** Who may call the tool: `model`, the agent, and `app`, its app. Both by default */
  visibility?: ToolAppVisibility[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === 'string');
  return list.length > 0 ? list : undefined;
}

/** Throws unless `uri` is a `ui://` URI, as MCP Apps requires of an app */
export function assertAppUri(uri: string): void {
  if (!/^ui:\/\/[^\s]+$/.test(uri)) {
    throw new Error(`An MCP App's URI must start with ui:// (got "${uri}")`);
  }
}

/**
 * Who may call a tool, as its `_meta.ui.visibility` says: `model`, the agent, and `app`, the pages
 * of its server. Read on its own, since a tool without an app of its own may be for apps only.
 * Undefined when the tool names none, which opens it to both
 */
export function toolVisibilityOf(meta: unknown): ToolAppVisibility[] | undefined {
  if (!isRecord(meta) || !isRecord(meta.ui)) return undefined;
  const visibility = stringList(meta.ui.visibility)?.filter(
    (entry): entry is ToolAppVisibility => entry === 'model' || entry === 'app'
  );
  return visibility && visibility.length > 0 ? visibility : undefined;
}

/**
 * The app a tool points at in its `_meta`: `_meta.ui.resourceUri`, else the older flat
 * `_meta['ui/resourceUri']`, with the tool's `visibility`. Undefined for a tool without one, or
 * one that names something other than a `ui://` URI
 */
export function toolAppRefOf(meta: unknown): MCPToolAppRef | undefined {
  if (!isRecord(meta)) return undefined;
  const ui = isRecord(meta.ui) ? meta.ui : undefined;
  const uri = ui?.resourceUri ?? meta[MCP_APP_LEGACY_META_KEY];
  if (typeof uri !== 'string' || !uri.startsWith('ui://')) return undefined;
  const visibility = toolVisibilityOf(meta);
  return { resourceUri: uri, ...(visibility && { visibility }) };
}

/** Whether a tool is visible to `who`: every tool is, unless its `visibility` leaves it out */
export function isToolVisibleTo(
  tool: { visibility?: readonly ToolAppVisibility[] } | undefined,
  who: ToolAppVisibility
): boolean {
  return !tool?.visibility || tool.visibility.includes(who);
}

/** The `_meta` a tool with an app is listed with: `ui` and, for older hosts, the flat key */
export function toolAppMeta(app: Pick<ToolApp, 'resourceUri' | 'visibility'>): {
  ui: { resourceUri: string; visibility?: ToolAppVisibility[] };
  [key: string]: unknown;
} {
  assertAppUri(app.resourceUri);
  return {
    ui: {
      resourceUri: app.resourceUri,
      ...(app.visibility && { visibility: [...app.visibility] }),
    },
    [MCP_APP_LEGACY_META_KEY]: app.resourceUri,
  };
}

/** `_meta.ui` of an app resource: its CSP, permissions, domain and border, only what is set */
export function appResourceMeta(meta: MCPAppMeta): { ui: MCPAppMeta } | undefined {
  const ui: MCPAppMeta = {
    ...(meta.csp && { csp: meta.csp }),
    ...(meta.permissions && { permissions: meta.permissions }),
    ...(meta.domain !== undefined && { domain: meta.domain }),
    ...(meta.prefersBorder !== undefined && { prefersBorder: meta.prefersBorder }),
  };
  return Object.keys(ui).length > 0 ? { ui } : undefined;
}

/** What `_meta.ui` of a resource or its content says of an app, the fields it gets right */
export function appMetaOf(meta: unknown): MCPAppMeta {
  if (!isRecord(meta) || !isRecord(meta.ui)) return {};
  const { ui } = meta;
  const csp = isRecord(ui.csp) ? ui.csp : undefined;
  const cspOut: ToolAppCsp = {};
  for (const key of [
    'connectDomains',
    'resourceDomains',
    'frameDomains',
    'baseUriDomains',
  ] as const) {
    const list = stringList(csp?.[key]);
    if (list) cspOut[key] = list;
  }
  const permissions: ToolAppPermissions = {};
  if (isRecord(ui.permissions)) {
    for (const key of ['camera', 'microphone', 'geolocation', 'clipboardWrite'] as const) {
      if (isRecord(ui.permissions[key])) permissions[key] = {};
    }
  }
  return {
    ...(Object.keys(cspOut).length > 0 && { csp: cspOut }),
    ...(Object.keys(permissions).length > 0 && { permissions }),
    ...(typeof ui.domain === 'string' && { domain: ui.domain }),
    ...(typeof ui.prefersBorder === 'boolean' && { prefersBorder: ui.prefersBorder }),
  };
}

async function htmlOf(config: MCPAppConfig): Promise<string> {
  return typeof config.html === 'string' ? config.html : await config.html();
}

/**
 * The app of a tool this process serves: give it as the tool's `app`, and an `MCPServer` that
 * serves the tool lists it with `_meta.ui.resourceUri` and serves the app at `uri` itself
 *
 * @example
 * ```ts
 * const forecast = tool({
 *   name: 'forecast',
 *   description: 'Weather forecast for a city',
 *   parameters: z.object({ city: z.string() }),
 *   app: mcpApp({ uri: 'ui://weather/forecast', html: forecastHtml }),
 *   execute: async ({ city }) => fetchForecast(city),
 * });
 * ```
 */
export function mcpApp(config: MCPToolAppConfig): ToolApp {
  assertAppUri(config.uri);
  return {
    resourceUri: config.uri,
    ...(config.visibility && { visibility: [...config.visibility] }),
    read: async (): Promise<ToolAppResource> => ({
      uri: config.uri,
      mimeType: MCP_APP_MIME_TYPE,
      html: await htmlOf(config),
      ...appMetaOf(appResourceMeta(config)),
    }),
  };
}
