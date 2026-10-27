import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  CircleCheck,
  Info,
  PanelsTopLeft,
  Power,
  PowerOff,
  Puzzle,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  SquareArrowOutUpRight,
  TriangleAlert,
} from 'lucide-react';
import type {
  PluginActionResult,
  PluginRecord,
  PluginReloadRecord,
  PluginStatusRecord,
} from '../../protocol';
import { createPanelBridge, type PanelBridge } from '../../plugin-bridge';
import { api, panelUrl } from '../api';
import { Empty, ErrorText, messageOf, Topbar } from '../components/common';
import { href } from '../router';
import { useStudio } from '../store';

const STATUS_LABEL: Record<PluginStatusRecord, string> = {
  active: 'Active',
  disabled: 'Disabled',
  blocked: 'Blocked',
  failed: 'Failed',
  unloaded: 'Unloaded',
};

const ORIGIN_LABEL: Record<PluginRecord['origin'], string> = {
  core: 'Core',
  code: 'Code of the project',
  dir: 'Plugin folder',
  installed: 'Installed',
};

const FORMAT_LABEL: Record<PluginRecord['format'], string> = {
  claude: 'Claude Code plugin',
  cogitator: 'Cogitator plugin',
  code: 'Defined in code',
};

/** What the last reload, enable or disable of a plugin did, as its card tells it. */
type Outcome =
  | { action: 'reload'; result?: PluginReloadRecord; status: PluginStatusRecord }
  | { action: 'enable'; enabled: boolean; result?: PluginReloadRecord }
  | { action: 'error'; error: string };

function PluginStatusBadge({ status }: { status: PluginStatusRecord }) {
  return (
    <span className="status" data-status={status} data-testid="plugin-status">
      {STATUS_LABEL[status]}
    </span>
  );
}

function OutcomeText({ outcome }: { outcome: Outcome }) {
  if (outcome.action === 'error') return <ErrorText>{outcome.error}</ErrorText>;
  const { result } = outcome;
  if (result && !result.ok) {
    const goesOn =
      result.generation > 0
        ? `Generation ${result.generation} goes on.`
        : 'No earlier generation was loaded, nothing of it runs.';
    return (
      <ErrorText>
        {outcome.action === 'reload' ? 'The reload failed' : 'It was enabled but did not load'}:{' '}
        {result.error ?? 'unknown error'}. {goesOn}
      </ErrorText>
    );
  }
  let text: string;
  if (outcome.action === 'enable') {
    text = outcome.enabled
      ? result
        ? `Enabled, generation ${result.generation} loaded.`
        : 'Enabled.'
      : 'Disabled, what it added is unloaded.';
  } else {
    text = result
      ? `Reloaded, generation ${result.generation} serves now.`
      : `Nothing reloaded: the plugin is ${STATUS_LABEL[outcome.status].toLowerCase()}.`;
  }
  return (
    <div className="notice plugin-outcome" role="status">
      <CircleCheck size={14} />
      <span>{text}</span>
    </div>
  );
}

function Chips({ values }: { values: readonly string[] }) {
  return (
    <div className="plugin-chips">
      {values.map((value) => (
        <span key={value} className="chip">
          {value}
        </span>
      ))}
    </div>
  );
}

function Contributions({ plugin }: { plugin: PluginRecord }) {
  const c = plugin.contributions;
  const named: Array<[string, string[]]> = [
    ['Tools', c.tools],
    ['Skills', c.skills],
    ['Agents', c.agents],
    ['Commands', c.commands],
    ['MCP servers', c.mcpServers],
    ['LLM backends', c.llmBackends],
  ];
  const lists = named.filter(([, values]) => values.length > 0);
  const counts: Array<[string, number]> = [
    ['Hooks', c.hooks],
    ['Middleware', c.middleware],
  ];
  const counted = counts.filter(([, value]) => value > 0);
  if (lists.length === 0 && counted.length === 0 && c.panels.length === 0) {
    return (
      <div className="muted">
        {plugin.status === 'active' ? 'It adds nothing.' : 'Nothing while it is not active.'}
      </div>
    );
  }
  return (
    <dl className="kv">
      {lists.map(([label, values]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd>
            <Chips values={values} />
          </dd>
        </div>
      ))}
      {counted.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd className="num">{value}</dd>
        </div>
      ))}
      {c.panels.length > 0 && (
        <>
          <dt>Panels</dt>
          <dd className="plugin-panels">
            {c.panels.map((panel) => (
              <a
                key={panel.id}
                className="plugin-panel-link"
                href={href('plugins', plugin.id, 'panels', panel.id)}
                data-testid={`open-panel-${panel.id}`}
              >
                <PanelsTopLeft size={13} />
                <span className="truncate">{panel.title}</span>
                {panel.description && <span className="muted truncate">{panel.description}</span>}
              </a>
            ))}
          </dd>
        </>
      )}
    </dl>
  );
}

function PluginCard({
  plugin,
  changeable,
  focused,
}: {
  plugin: PluginRecord;
  changeable: boolean;
  focused: boolean;
}) {
  const [busy, setBusy] = useState<'reload' | 'enable'>();
  const [outcome, setOutcome] = useState<Outcome>();
  const card = useRef<HTMLElement>(null);
  const core = plugin.origin === 'core';

  useEffect(() => {
    if (focused) card.current?.scrollIntoView({ block: 'start' });
  }, [focused]);

  const resultOf = (response: PluginActionResult) =>
    response.results.find((result) => result.id === plugin.id);

  const reload = async () => {
    setBusy('reload');
    try {
      const response = await api.reloadPlugin(plugin.id);
      const after = response.plugins.plugins.find((entry) => entry.id === plugin.id);
      const result = resultOf(response);
      setOutcome({
        action: 'reload',
        ...(result && { result }),
        status: after?.status ?? plugin.status,
      });
    } catch (failure) {
      setOutcome({ action: 'error', error: messageOf(failure) });
    } finally {
      setBusy(undefined);
    }
  };

  const toggle = async () => {
    const enabled = !plugin.enabled;
    setBusy('enable');
    try {
      const result = resultOf(await api.setPluginEnabled(plugin.id, enabled));
      setOutcome({ action: 'enable', enabled, ...(result && { result }) });
    } catch (failure) {
      setOutcome({ action: 'error', error: messageOf(failure) });
    } finally {
      setBusy(undefined);
    }
  };

  const permissions = plugin.permissions;
  return (
    <section
      ref={card}
      className={`panel plugin-card ${focused ? 'is-focused' : ''}`}
      data-testid={`plugin-${plugin.id}`}
    >
      <div className="panel-head">
        <div className="panel-title plugin-title">
          <Puzzle size={14} />
          <span className="truncate">{plugin.displayName ?? plugin.name}</span>
          {plugin.version && <span className="chip">v{plugin.version}</span>}
          {plugin.isolated && (
            <span className="chip" data-tip="Runs in a process of its own">
              isolated
            </span>
          )}
        </div>
        <div className="plugin-actions">
          <PluginStatusBadge status={plugin.status} />
          {changeable && !core && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy !== undefined || !plugin.enabled}
              onClick={() => void reload()}
              data-testid="reload-plugin"
            >
              {busy === 'reload' ? <span className="spinner" /> : <RotateCw size={12} />}
              Reload
            </button>
          )}
          {changeable && !core && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy !== undefined}
              onClick={() => void toggle()}
              data-testid="toggle-plugin"
            >
              {busy === 'enable' ? (
                <span className="spinner" />
              ) : plugin.enabled ? (
                <PowerOff size={12} />
              ) : (
                <Power size={12} />
              )}
              {plugin.enabled ? 'Disable' : 'Enable'}
            </button>
          )}
        </div>
      </div>
      <div className="panel-body plugin-body">
        {plugin.description && <p className="panel-desc">{plugin.description}</p>}
        {plugin.error && (
          <ErrorText>
            {plugin.status === 'blocked' ? 'Blocked' : 'Failed'}: {plugin.error}
          </ErrorText>
        )}
        {outcome && <OutcomeText outcome={outcome} />}
        <dl className="kv">
          <dt>Id</dt>
          <dd className="mono">{plugin.id}</dd>
          <dt>Origin</dt>
          <dd>{ORIGIN_LABEL[plugin.origin]}</dd>
          <dt>Format</dt>
          <dd>{FORMAT_LABEL[plugin.format]}</dd>
          <dt>Enabled</dt>
          <dd>
            {plugin.enabled ? 'Yes' : 'No'}, by{' '}
            {plugin.enabledBy === 'default' ? 'its default' : `${plugin.enabledBy} settings`}
          </dd>
          <dt>Generation</dt>
          <dd className="num">{plugin.generation}</dd>
          <dt>Process</dt>
          <dd>{plugin.isolated ? 'Its own, isolated' : 'The runtime process'}</dd>
          {plugin.root && (
            <>
              <dt>Folder</dt>
              <dd className="mono truncate" title={plugin.root}>
                {plugin.root}
              </dd>
            </>
          )}
          {plugin.dependencies.length > 0 && (
            <>
              <dt>Needs</dt>
              <dd>
                <Chips
                  values={plugin.dependencies.map(
                    (dependency) =>
                      `${dependency.name}${dependency.marketplace ? `@${dependency.marketplace}` : ''}${dependency.version ? ` ${dependency.version}` : ''}`
                  )}
                />
              </dd>
            </>
          )}
        </dl>
        <div className="plugin-section">
          <div className="props-title">Adds</div>
          <Contributions plugin={plugin} />
        </div>
        {permissions && (permissions.allow.length > 0 || permissions.deny.length > 0) && (
          <div className="plugin-section">
            <div className="props-title plugin-section-title">
              <ShieldCheck size={12} />
              Permissions
            </div>
            <dl className="kv">
              {permissions.allow.length > 0 && (
                <>
                  <dt>Allow</dt>
                  <dd>
                    <Chips values={permissions.allow} />
                  </dd>
                </>
              )}
              {permissions.deny.length > 0 && (
                <>
                  <dt>Deny</dt>
                  <dd>
                    <Chips values={permissions.deny} />
                  </dd>
                </>
              )}
            </dl>
          </div>
        )}
        {plugin.diagnostics.length > 0 && (
          <div className="plugin-section">
            <div className="props-title">Diagnostics</div>
            <ul className="plugin-diagnostics">
              {plugin.diagnostics.map((diagnostic, index) => (
                <li key={index} data-level={diagnostic.level}>
                  {diagnostic.level === 'error' ? <TriangleAlert size={13} /> : <Info size={13} />}
                  <span>
                    {diagnostic.message}
                    {diagnostic.path && <span className="mono muted"> {diagnostic.path}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The plugins of the project's runtime: what each is, whether it works, what it adds, its
 * permissions and diagnostics, with reload and enable buttons.
 */
export function PluginsView({ focus }: { focus?: string }) {
  const host = useStudio((state) => state.host);
  const plugins = useStudio((state) => state.plugins);
  const crumbs = [{ label: 'Plugins' }];

  if (!plugins)
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="scroll">
          <Empty icon={Puzzle} title="Waiting for the project">
            {host.state === 'failed' ? 'The project does not load.' : undefined}
          </Empty>
        </div>
      </>
    );
  if (!plugins.available)
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="scroll">
          <Empty icon={Puzzle} title="No plugins in this runtime">
            The project runs a @cogitator-ai/core from before plugins. Update it to load plugins.
          </Empty>
        </div>
      </>
    );

  const active = plugins.plugins.filter((plugin) => plugin.status === 'active').length;
  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="scroll">
        <div className="page">
          <div className="page-head">
            <div>
              <h1 className="page-title">Plugins</h1>
              <div className="page-sub">
                {plugins.plugins.length} {plugins.plugins.length === 1 ? 'plugin' : 'plugins'},{' '}
                {active} active
              </div>
            </div>
          </div>
          {!plugins.configured && (
            <div className="notice" style={{ marginBottom: 16 }} data-testid="plugins-unconfigured">
              <Info size={14} />
              <span>
                The project configures no <code>experimental_plugins</code>, so its runtime has only
                the core's own plugin. Give the Cogitator config plugins in code, plugin folders or
                installed plugins to see them here.
              </span>
            </div>
          )}
          <div className="plugin-list">
            {plugins.plugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                changeable={plugins.configured}
                focused={plugin.id === focus}
              />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * A panel of a plugin: its page in a frame sandboxed with scripts only, never the studio's origin,
 * whose requests go to the panel's handlers through the message bridge.
 */
export function PluginPanelView({ pluginId, panelId }: { pluginId: string; panelId: string }) {
  const plugins = useStudio((state) => state.plugins);
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<PanelBridge>(undefined);
  const [nonce, setNonce] = useState(0);
  const [closedFrame, setClosedFrame] = useState<string>();
  const plugin = plugins?.plugins.find((candidate) => candidate.id === pluginId);
  const panel = plugin?.contributions.panels.find((candidate) => candidate.id === panelId);
  const live = plugin?.status === 'active' && panel !== undefined;
  const frameKey = `${plugin?.generation ?? 0}:${nonce}`;
  const closed = closedFrame === frameKey;

  useLayoutEffect(() => {
    if (!live || closed) return;
    const current = createPanelBridge({
      frame: () => frame.current?.contentWindow,
      call: async (method, params) =>
        (await api.callPanel(pluginId, panelId, method, params)).result,
      onNavigatedAway: () => setClosedFrame(frameKey),
    });
    bridge.current = current;
    const listener = (event: MessageEvent) => {
      const data: unknown = event.data;
      current.handle({ source: event.source, origin: event.origin, data });
    };
    window.addEventListener('message', listener);
    return () => {
      window.removeEventListener('message', listener);
      current.dispose();
      if (bridge.current === current) bridge.current = undefined;
    };
  }, [live, closed, frameKey, pluginId, panelId]);

  const crumbs = [
    { label: 'Plugins', to: ['plugins'] },
    { label: plugin?.displayName ?? plugin?.name ?? pluginId, to: ['plugins', pluginId] },
    { label: panel?.title ?? panelId },
  ];

  if (!plugins)
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="scroll">
          <Empty icon={PanelsTopLeft} title="Waiting for the project" />
        </div>
      </>
    );
  if (!plugin || !panel || !live)
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="scroll">
          <Empty
            icon={PanelsTopLeft}
            title={`No panel ${panelId} is loaded`}
            action={
              <a className="btn btn-secondary btn-sm" href={href('plugins', pluginId)}>
                <Puzzle size={12} />
                See the plugin
              </a>
            }
          >
            {plugin
              ? `${plugin.displayName ?? plugin.name} is ${STATUS_LABEL[plugin.status].toLowerCase()}${plugin.error ? `: ${plugin.error}` : ''}.`
              : `The runtime has no plugin ${pluginId}.`}
          </Empty>
        </div>
      </>
    );

  return (
    <>
      <Topbar
        crumbs={crumbs}
        actions={
          <>
            {!closed && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setNonce((value) => value + 1)}
                data-testid="reload-panel"
              >
                <RotateCw size={12} />
                Reload page
              </button>
            )}
            <a className="btn btn-ghost btn-sm" href={href('plugins', pluginId)}>
              <SquareArrowOutUpRight size={12} />
              Plugin
            </a>
          </>
        }
      />
      {closed ? (
        <div className="scroll" data-testid="panel-closed">
          <Empty
            icon={ShieldAlert}
            title="The panel navigated away and was closed"
            action={
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setNonce((value) => value + 1)}
                data-testid="reopen-panel"
              >
                <RotateCw size={12} />
                Open again
              </button>
            }
          >
            Its page left the panel for another address, and that address may have carried what the
            plugin's handlers gave the page. The plugin answers this page no more.
          </Empty>
        </div>
      ) : (
        <div className="plugin-frame-wrap">
          <iframe
            key={frameKey}
            ref={frame}
            className="plugin-frame"
            title={panel.title}
            src={panelUrl(pluginId, panelId)}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            onLoad={() => bridge.current?.frameLoaded()}
            data-testid="plugin-frame"
          />
        </div>
      )}
    </>
  );
}
