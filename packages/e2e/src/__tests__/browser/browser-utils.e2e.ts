import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BrowserSession,
  smartSelect,
  findFormField,
  getReadableText,
  getAccessibilityTree,
} from '@cogitator-ai/browser';
import type { AccessibilityNode } from '@cogitator-ai/browser';

const describeIfBrowser = process.env.TEST_BROWSER ? describe : describe.skip;

const TEST_HTML = `<!DOCTYPE html>
<html>
<head><title>Utils Test</title>
<style>.hidden { display: none; }</style>
</head>
<body>
  <h1 id="heading">Hello Utils</h1>
  <form>
    <label for="email-field">Email</label>
    <input id="email-field" name="email" placeholder="Enter email" />
    <input name="username" placeholder="Username" />
    <button type="submit">Submit</button>
  </form>
  <nav>
    <a href="/page1">Link One</a>
    <a href="/page2">Link Two</a>
  </nav>
  <script>var internalVar = 42;</script>
  <style>.internal { color: red; }</style>
</body>
</html>`;

function createTestServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(TEST_HTML);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function flattenTree(node: AccessibilityNode): AccessibilityNode[] {
  const result: AccessibilityNode[] = [node];
  if (node.children) {
    for (const child of node.children) {
      result.push(...flattenTree(child));
    }
  }
  return result;
}

describeIfBrowser('Browser Utils E2E', () => {
  let server: http.Server;
  let session: BrowserSession;

  beforeAll(async () => {
    server = await createTestServer();
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    session = new BrowserSession({ headless: true });
    await session.start();
    await session.page.goto(baseUrl);
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  it('getReadableText strips scripts/styles and returns visible text', async () => {
    const text = await getReadableText(session.page);

    expect(text).toContain('Hello Utils');
    expect(text).toContain('Submit');
    expect(text).not.toContain('internalVar');
    expect(text).not.toContain('.internal');
  }, 30_000);

  it('getAccessibilityTree returns tree with heading and link roles', async () => {
    const tree = await getAccessibilityTree(session.page);

    expect(tree).not.toBeNull();
    const nodes = flattenTree(tree!);

    expect(nodes.every((n) => typeof n.role === 'string')).toBe(true);
    expect(nodes.some((n) => n.role === 'heading')).toBe(true);
    expect(nodes.some((n) => n.role === 'link')).toBe(true);
  }, 30_000);

  it('smartSelect resolves by CSS selector and by text', async () => {
    const byId = await smartSelect(session.page, '#heading');
    expect(byId).not.toBeNull();
    await expect(byId!.textContent()).resolves.toBe('Hello Utils');

    const byText = await smartSelect(session.page, 'Submit');
    expect(byText).not.toBeNull();
    expect(await byText!.count()).toBeGreaterThan(0);
  }, 30_000);

  it('findFormField locates inputs by placeholder and label', async () => {
    const usernameField = await findFormField(session.page, 'Username');
    expect(usernameField).not.toBeNull();
    expect(await usernameField!.count()).toBeGreaterThan(0);

    const emailField = await findFormField(session.page, 'Email');
    expect(emailField).not.toBeNull();
    expect(await emailField!.count()).toBeGreaterThan(0);
  }, 30_000);
});
