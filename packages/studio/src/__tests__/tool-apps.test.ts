import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStudio, type StudioHandle } from '../server/server.js';
import type { HostStatus, ToolAppCallOutcome, ToolAppFrameInfo } from '../protocol.js';
import {
  appAllowAttribute,
  appContentSecurityPolicy,
  appPermissionsPolicy,
  appSources,
} from '../tool-app-policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'apps-project');

describe('the policy of an MCP App', () => {
  it('reaches nothing beyond inline code without declared origins', () => {
    const csp = appContentSecurityPolicy(undefined);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).not.toContain("'self' ");
    expect(csp).not.toContain('allow-same-origin');
  });

  it('opens exactly the declared origins, leaving out what is no origin', () => {
    const csp = appContentSecurityPolicy({
      connectDomains: ['https://api.example.com', 'wss://live.example.com'],
      resourceDomains: [
        'https://*.cdn.example.com',
        "'unsafe-eval'",
        'https://x.com; script-src *',
      ],
      frameDomains: ['https://www.youtube.com'],
    });
    expect(csp).toContain('connect-src https://api.example.com wss://live.example.com');
    expect(csp).toContain("script-src 'unsafe-inline' https://*.cdn.example.com;");
    expect(csp).toContain('img-src data: blob: https://*.cdn.example.com');
    expect(csp).toContain('frame-src https://www.youtube.com');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('script-src *');
    expect(appSources(['http://localhost:3000', 'javascript:alert(1)', '*'])).toEqual([
      'http://localhost:3000',
    ]);
  });

  it('grants the features an app asks for, and nothing else', () => {
    expect(appAllowAttribute({ microphone: {}, clipboardWrite: {} })).toBe(
      'microphone; clipboard-write'
    );
    expect(appAllowAttribute(undefined)).toBe('');
    const policy = appPermissionsPolicy({ camera: {} });
    expect(policy).toContain('camera=(self)');
    expect(policy).toContain('microphone=()');
    expect(policy).toContain('payment=()');
  });
});

describe('the studio serving MCP Apps', () => {
  let studio: StudioHandle;
  let base = '';
  const app = '/api/agents/shop/tools/show_cart/app';

  beforeAll(async () => {
    studio = await startStudio({
      projectDir: FIXTURE,
      studioDir: mkdtempSync(join(tmpdir(), 'cogitator-studio-apps-')),
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

  async function json<T>(path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
    return { status: response.status, body: (await response.json()) as T };
  }

  it('describes the apps of the tools in the registry', async () => {
    const { body } = await json<{ host: HostStatus }>('/api/state');
    if (body.host.state !== 'ready') throw new Error('the project did not load');
    const tools = body.host.registry.agents.find((agent) => agent.key === 'shop')?.tools ?? [];
    expect(tools.find((entry) => entry.name === 'show_cart')?.app).toEqual({
      resourceUri: 'ui://shop/cart',
    });
    expect(tools.find((entry) => entry.name === 'plain')?.app).toBeUndefined();
  });

  it('tells the UI what the app asks of its frame, without its HTML', async () => {
    const { status, body } = await json<ToolAppFrameInfo & { html?: string }>(app);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      uri: 'ui://shop/cart',
      permissions: { clipboardWrite: {} },
      prefersBorder: false,
    });
    expect(body.html).toBeUndefined();
  });

  it('serves the page sandboxed, with the CSP it declared and no more', async () => {
    const response = await fetch(`${base}${app}/view`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<p id="cart">cart</p>');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('connect-src https://api.shop.example;');
    expect(csp).toContain('https://cdn.shop.example');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain('sandbox allow-scripts');
    expect(response.headers.get('permissions-policy')).toContain('clipboard-write=(self)');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('runs the calls an app makes, the ones that need approval once allowed', async () => {
    const refresh = await json<ToolAppCallOutcome>(`${app}/call`, {
      name: 'refresh_cart',
      arguments: { id: 1 },
    });
    expect(refresh.body).toEqual({
      status: 'done',
      result: {
        content: [{ type: 'text', text: 'refresh_cart {"id":1}' }],
        structuredContent: { called: 'refresh_cart' },
      },
    });

    const asked = await json<ToolAppCallOutcome>(`${app}/call`, { name: 'empty_cart' });
    expect(asked.body).toEqual({ status: 'approval', tool: 'empty_cart' });
    const allowed = await json<ToolAppCallOutcome>(`${app}/call`, {
      name: 'empty_cart',
      approved: true,
    });
    expect(allowed.body).toMatchObject({
      status: 'done',
      result: { structuredContent: { called: 'empty_cart' } },
    });
  });

  it("holds the app's calls to the agent's permission rules", async () => {
    const denied = await json<ToolAppCallOutcome>(`${app}/call`, { name: 'drop_tables' });
    expect(denied.body).toMatchObject({ status: 'done', result: { isError: true } });
    const allowedAnyway = await json<ToolAppCallOutcome>(`${app}/call`, {
      name: 'drop_tables',
      approved: true,
    });
    expect(allowedAnyway.body).toMatchObject({ status: 'done', result: { isError: true } });

    const asked = await json<ToolAppCallOutcome>(`${app}/call`, { name: 'checkout' });
    expect(asked.body).toEqual({ status: 'approval', tool: 'checkout' });
    const allowed = await json<ToolAppCallOutcome>(`${app}/call`, {
      name: 'checkout',
      approved: true,
    });
    expect(allowed.body).toMatchObject({
      status: 'done',
      result: { structuredContent: { called: 'checkout' } },
    });
  });

  it('refuses an unknown app, and calls from an app that may call none', async () => {
    expect((await json('/api/agents/shop/tools/plain/app')).status).toBe(404);
    expect((await json('/api/agents/nobody/tools/show_cart/app')).status).toBe(404);
    expect((await fetch(`${base}${app}/other`)).status).toBe(404);
    const refused = await json('/api/agents/shop/tools/show_receipt/app/call', { name: 'x' });
    expect(refused.status).toBe(403);
    expect((await json(`${app}/call`, { arguments: {} })).status).toBe(400);
  });
});
