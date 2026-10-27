import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  PluginActionResult,
  PluginPanelCallResult,
  PluginRecord,
  PluginsState,
  StudioEvent,
} from '../protocol.js';
import { StudioHost } from '../host/runner.js';
import { startStudio, type StudioHandle } from '../server/server.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PLUGINS_FIXTURE = join(FIXTURES, 'plugins-project');
const PLAIN_FIXTURE = join(FIXTURES, 'project');
const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-plugins-'));
  dirs.push(dir);
  return dir;
}

function pluginOf(state: PluginsState, id: string): PluginRecord {
  const plugin = state.plugins.find((candidate) => candidate.id === id);
  if (!plugin) throw new Error(`no plugin ${id} in ${state.plugins.map((p) => p.id).join(', ')}`);
  return plugin;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('studio host plugins', () => {
  it('reports the plugins of a project with plugins in code, their panels and changes', async () => {
    const pushed: PluginsState[] = [];
    const host = await StudioHost.create(
      PLUGINS_FIXTURE,
      scratch(),
      () => undefined,
      (state) => pushed.push(state)
    );
    try {
      const state = (await host.handle({ type: 'plugins.list', requestId: 'r1' })) as PluginsState;
      expect(state.available).toBe(true);
      expect(state.configured).toBe(true);
      expect(state.plugins.map((plugin) => plugin.id)).toEqual(
        expect.arrayContaining(['cogitator@builtin', 'board@code', 'flaky@code', 'dormant@code'])
      );

      const board = pluginOf(state, 'board@code');
      expect(board).toMatchObject({
        name: 'board',
        displayName: 'Board',
        version: '1.2.0',
        origin: 'code',
        format: 'code',
        status: 'active',
        enabled: true,
        enabledBy: 'default',
        generation: 1,
        isolated: false,
        permissions: { allow: ['Read(./docs/**)'], deny: ['Bash(rm *)'] },
      });
      expect(board.contributions.tools).toEqual(['board_note']);
      expect(board.contributions.panels).toEqual([
        { id: 'main', title: 'Board', description: 'What the board holds' },
      ]);
      expect(pluginOf(state, 'dormant@code')).toMatchObject({ status: 'disabled', enabled: false });
      expect(pluginOf(state, 'dormant@code').contributions.commands).toEqual([]);
      expect(pluginOf(state, 'cogitator@builtin').contributions.llmBackends.length).toBeGreaterThan(
        0
      );

      const page = (await host.handle({
        type: 'plugins.panel',
        requestId: 'r2',
        plugin: 'board@code',
        panel: 'main',
      })) as { html: string };
      expect(page.html).toContain("type: 'cogitator:request'");

      const echoed = (await host.handle({
        type: 'plugins.call',
        requestId: 'r3',
        plugin: 'board@code',
        panel: 'main',
        method: 'echo',
        params: { a: 1 },
      })) as PluginPanelCallResult;
      expect(echoed).toEqual({ result: { echoed: { a: 1 } } });

      await expect(
        host.handle({
          type: 'plugins.call',
          requestId: 'r4',
          plugin: 'board@code',
          panel: 'main',
          method: 'fail',
        })
      ).rejects.toThrow('the board is closed');

      const enabled = (await host.handle({
        type: 'plugins.enable',
        requestId: 'r5',
        plugin: 'dormant@code',
        enabled: true,
      })) as PluginActionResult;
      expect(enabled.results).toEqual([{ id: 'dormant@code', ok: true, generation: 1 }]);
      expect(pluginOf(enabled.plugins, 'dormant@code').status).toBe('active');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(pluginOf(pushed.at(-1)!, 'dormant@code').status).toBe('active');

      await expect(
        host.handle({ type: 'plugins.reload', requestId: 'r6', plugin: 'ghost@code' })
      ).rejects.toMatchObject({ code: 'PLUGIN_NOT_FOUND' });
      await expect(
        host.handle({
          type: 'plugins.enable',
          requestId: 'r7',
          plugin: 'cogitator@builtin',
          enabled: false,
        })
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    } finally {
      await host.close();
    }
  });

  it('shows only the core plugin of a project without plugins and changes nothing in it', async () => {
    const host = await StudioHost.create(PLAIN_FIXTURE, scratch(), () => undefined);
    try {
      const state = (await host.handle({ type: 'plugins.list', requestId: 'r1' })) as PluginsState;
      expect(state.available).toBe(true);
      expect(state.configured).toBe(false);
      expect(state.plugins.map((plugin) => plugin.origin)).toEqual(['core']);
      await expect(
        host.handle({ type: 'plugins.reload', requestId: 'r2', plugin: state.plugins[0].id })
      ).rejects.toMatchObject({ code: 'PLUGINS_NOT_CONFIGURED' });
    } finally {
      await host.close();
    }
  });
});

describe('studio server plugins', () => {
  let studio: StudioHandle;
  let base: string;

  async function call(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function ok<T>(path: string, body?: unknown): Promise<T> {
    const { status, json } = await call(path, { ...(body !== undefined && { body }) });
    if (status !== 200) throw new Error(`${status} ${String(json.error)}`);
    return json as T;
  }

  const plugin = (id: string) => `/api/plugins/${encodeURIComponent(id)}`;

  beforeAll(async () => {
    studio = await startStudio({
      projectDir: PLUGINS_FIXTURE,
      studioDir: scratch(),
      port: 0,
      watch: false,
      price: () => 0,
    });
    base = studio.url.replace(/\/$/, '').replace('localhost', '127.0.0.1');
    await studio.ready();
  }, 60_000);

  afterAll(async () => {
    await studio?.close();
  });

  it('lists the plugins of the project', async () => {
    const state = await ok<PluginsState>('/api/plugins');
    expect(state.configured).toBe(true);
    expect(pluginOf(state, 'board@code').contributions.panels.map((panel) => panel.id)).toEqual([
      'main',
    ]);
    expect(pluginOf(state, 'flaky@code')).toMatchObject({ status: 'active', generation: 1 });
  });

  it('serves a panel page sandboxed, with no network, and refuses an unknown panel', async () => {
    const response = await fetch(`${base}${plugin('board@code')}/panels/main`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).not.toMatch(/connect-src/);
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('x-dns-prefetch-control')).toBe('off');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const permissions = response.headers.get('permissions-policy') ?? '';
    for (const feature of ['camera=()', 'microphone=()', 'geolocation=()', 'clipboard-read=()']) {
      expect(permissions).toContain(feature);
    }
    expect(await response.text()).toContain('cogitator:request');

    const ui = await fetch(`${base}/`);
    expect(ui.headers.get('content-security-policy')).toContain("frame-src 'self'");

    const missing = await fetch(`${base}${plugin('board@code')}/panels/nope`);
    expect(missing.status).toBe(404);
  });

  it('calls a panel handler and answers its failures', async () => {
    expect(
      await ok<PluginPanelCallResult>(`${plugin('board@code')}/panels/main/call`, {
        method: 'echo',
        params: { text: 'hi' },
      })
    ).toEqual({ result: { echoed: { text: 'hi' } } });

    const failed = await call(`${plugin('board@code')}/panels/main/call`, {
      body: { method: 'fail' },
    });
    expect(failed.status).toBe(500);
    expect(failed.json.error).toBe('the board is closed');

    const unknown = await call(`${plugin('board@code')}/panels/main/call`, {
      body: { method: 'nothing' },
    });
    expect(unknown.status).toBe(400);

    const invalid = await call(`${plugin('board@code')}/panels/main/call`, {
      body: { method: 42 },
    });
    expect(invalid.status).toBe(400);
    expect(String(invalid.json.error)).toContain('method');

    const crossSite = await call(`${plugin('board@code')}/panels/main/call`, {
      body: { method: 'echo' },
      headers: { origin: 'null' },
    });
    expect(crossSite.status).toBe(403);
  });

  it('enables a plugin, pushes the change and validates the body', async () => {
    const events: StudioEvent[] = [];
    const controller = new AbortController();
    const stream = fetch(`${base}/api/events`, { signal: controller.signal })
      .then(async (response) => {
        const reader = response.body!.getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += new TextDecoder().decode(value);
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)) as StudioEvent);
          }
        }
      })
      .catch(() => undefined);

    const enabled = await ok<PluginActionResult>(`${plugin('dormant@code')}/enabled`, {
      enabled: true,
    });
    expect(enabled.results).toEqual([{ id: 'dormant@code', ok: true, generation: 1 }]);
    const dormant = pluginOf(enabled.plugins, 'dormant@code');
    expect(dormant).toMatchObject({ status: 'active', enabled: true });
    expect(dormant.contributions.commands).toHaveLength(1);

    const deadline = Date.now() + 5000;
    while (!events.some((event) => event.type === 'plugins') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    controller.abort();
    await stream;
    const pushed = events.filter((event) => event.type === 'plugins');
    expect(pushed.length).toBeGreaterThan(0);
    const last = pushed.at(-1);
    expect(last?.type === 'plugins' && pluginOf(last.plugins, 'dormant@code').status).toBe(
      'active'
    );

    const disabled = await ok<PluginActionResult>(`${plugin('dormant@code')}/enabled`, {
      enabled: false,
    });
    expect(pluginOf(disabled.plugins, 'dormant@code')).toMatchObject({
      status: 'disabled',
      enabled: false,
    });

    expect(
      (await call(`${plugin('dormant@code')}/enabled`, { body: { enabled: 'yes' } })).status
    ).toBe(400);
    expect(
      (await call(`${plugin('cogitator@builtin')}/enabled`, { body: { enabled: false } })).status
    ).toBe(400);
    expect(
      (await call(`${plugin('ghost@code')}/enabled`, { body: { enabled: true } })).status
    ).toBe(404);
  });

  it('reloads a plugin, and a failed reload keeps the generation that works', async () => {
    const board = await ok<PluginActionResult>(`${plugin('board@code')}/reload`, {});
    expect(board.results).toEqual([{ id: 'board@code', ok: true, generation: 2 }]);
    expect(pluginOf(board.plugins, 'board@code').generation).toBe(2);

    const flaky = await ok<PluginActionResult>(`${plugin('flaky@code')}/reload`, {});
    expect(flaky.results).toHaveLength(1);
    expect(flaky.results[0]).toMatchObject({ id: 'flaky@code', ok: false, generation: 1 });
    expect(flaky.results[0].error).toContain('flaky broke on load 2');
    expect(pluginOf(flaky.plugins, 'flaky@code')).toMatchObject({
      status: 'active',
      generation: 1,
    });

    expect((await call(`${plugin('ghost@code')}/reload`, { body: {} })).status).toBe(404);
    const noJson = await fetch(`${base}${plugin('board@code')}/reload`, { method: 'POST' });
    expect(noJson.status).toBe(415);
  });
});
