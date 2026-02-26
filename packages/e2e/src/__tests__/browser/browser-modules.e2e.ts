import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  BrowserSession,
  browserTools,
  createNavigationTools,
  createScreenshotTool,
  createClickTool,
} from '@cogitator-ai/browser';

const describeIfBrowser = process.env.TEST_BROWSER ? describe : describe.skip;

describeIfBrowser('Browser Module Selection E2E', () => {
  let session: BrowserSession;

  beforeAll(async () => {
    session = new BrowserSession({ headless: true });
    await session.start();
  }, 30_000);

  afterAll(async () => {
    await session?.close();
  });

  it('returns only navigation + extraction tools when modules are specified', () => {
    const tools = browserTools(session, { modules: ['navigation', 'extraction'] });

    expect(tools).toHaveLength(14);

    const names = tools.map((t) => t.name);
    expect(names).toContain('browser_navigate');
    expect(names).toContain('browser_get_text');
    expect(names).not.toContain('browser_click');
    expect(names).not.toContain('browser_screenshot');
  });

  it('returns all 32 tools when no modules option is given', () => {
    const tools = browserTools(session);

    expect(tools).toHaveLength(32);

    const names = tools.map((t) => t.name);
    expect(names).toContain('browser_navigate');
    expect(names).toContain('browser_get_text');
    expect(names).toContain('browser_click');
    expect(names).toContain('browser_screenshot');
    expect(names).toContain('browser_intercept_request');
  });

  it('individual factory functions return correct tools', () => {
    const navTools = createNavigationTools(session);
    expect(navTools).toHaveLength(7);

    const screenshotTool: Tool = createScreenshotTool(session);
    expect(screenshotTool.name).toBe('browser_screenshot');

    const clickTool: Tool = createClickTool(session);
    expect(clickTool.name).toBe('browser_click');
  });
});
