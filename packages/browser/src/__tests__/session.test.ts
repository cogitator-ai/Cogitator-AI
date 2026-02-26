import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserSessionConfig } from '@cogitator-ai/types';

function createPlaywrightMock() {
  let currentUrl = 'about:blank';
  let currentTitle = '';
  const cookieStore: Array<Record<string, unknown>> = [];

  const makePage = () => ({
    goto: vi.fn().mockImplementation(async (url: string) => {
      currentUrl = url;
      currentTitle = 'Test Page';
      return { status: () => 200 };
    }),
    close: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockImplementation(() => currentUrl),
    title: vi.fn().mockImplementation(async () => currentTitle),
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(null),
    goForward: vi.fn().mockResolvedValue(null),
    reload: vi.fn().mockResolvedValue(null),
  });

  const firstPage = makePage();

  const mockContext = {
    newPage: vi.fn().mockImplementation(async () => makePage()),
    addCookies: vi.fn().mockImplementation(async (cookies: Array<Record<string, unknown>>) => {
      cookieStore.push(...cookies);
    }),
    cookies: vi.fn().mockImplementation(async () => [...cookieStore]),
    close: vi.fn().mockResolvedValue(undefined),
  };

  mockContext.newPage.mockResolvedValueOnce(firstPage);

  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
  };

  const mockChromium = {
    launch: vi.fn().mockResolvedValue(mockBrowser),
  };

  const mockFirefox = {
    launch: vi.fn().mockResolvedValue(mockBrowser),
  };

  const mockWebkit = {
    launch: vi.fn().mockResolvedValue(mockBrowser),
  };

  return {
    module: {
      chromium: mockChromium,
      firefox: mockFirefox,
      webkit: mockWebkit,
    },
    mockBrowser,
    mockContext,
    firstPage,
    makePage,
    cookieStore,
  };
}

vi.mock('playwright', () => {
  return {
    default: {},
    chromium: { launch: vi.fn() },
    firefox: { launch: vi.fn() },
    webkit: { launch: vi.fn() },
  };
});

let pw: ReturnType<typeof createPlaywrightMock>;

beforeEach(async () => {
  vi.resetModules();
  pw = createPlaywrightMock();

  const playwright = await import('playwright');
  Object.assign(playwright, pw.module);
});

async function createAndStart(config?: BrowserSessionConfig) {
  const { BrowserSession } = await import('../session');
  const session = new BrowserSession(config);
  await session.start();
  return session;
}

describe('BrowserSession', () => {
  it('creates session with default config', async () => {
    const { BrowserSession } = await import('../session');
    const session = new BrowserSession();

    expect(session.config.headless).toBe(true);
    expect(session.config.browser).toBe('chromium');
    expect(session.config.viewport).toEqual({ width: 1280, height: 720 });
    expect(session.config.timeout).toBe(30_000);
    expect(session.config.actionTimeout).toBe(10_000);
  });

  it('creates session with custom config', async () => {
    const { BrowserSession } = await import('../session');
    const session = new BrowserSession({
      headless: false,
      browser: 'firefox',
      viewport: { width: 1920, height: 1080 },
      timeout: 60_000,
    });

    expect(session.config.headless).toBe(false);
    expect(session.config.browser).toBe('firefox');
    expect(session.config.viewport).toEqual({ width: 1920, height: 1080 });
    expect(session.config.timeout).toBe(60_000);
    expect(session.config.actionTimeout).toBe(10_000);
  });

  it('starts and closes browser successfully', async () => {
    const session = await createAndStart();

    expect(pw.module.chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true })
    );
    expect(pw.mockBrowser.newContext).toHaveBeenCalled();
    expect(session.browser).toBe(pw.mockBrowser);
    expect(session.context).toBe(pw.mockContext);

    await session.close();

    expect(pw.mockBrowser.close).toHaveBeenCalled();
    expect(session.browser).toBeNull();
    expect(session.context).toBeNull();
  });

  it('throws when accessing page before start', async () => {
    const { BrowserSession } = await import('../session');
    const session = new BrowserSession();

    expect(() => session.page).toThrow('BrowserSession not started');
  });

  it('launches firefox when configured', async () => {
    const { BrowserSession } = await import('../session');
    const session = new BrowserSession({ browser: 'firefox' });
    await session.start();

    expect(pw.module.firefox.launch).toHaveBeenCalled();
  });

  it('launches webkit when configured', async () => {
    const { BrowserSession } = await import('../session');
    const session = new BrowserSession({ browser: 'webkit' });
    await session.start();

    expect(pw.module.webkit.launch).toHaveBeenCalled();
  });

  it('creates context with locale/timezone/geolocation/userAgent', async () => {
    const { BrowserSession } = await import('../session');
    const session = new BrowserSession({
      locale: 'en-US',
      timezone: 'America/New_York',
      geolocation: { latitude: 40.7128, longitude: -74.006 },
      userAgent: 'CustomAgent/1.0',
    });
    await session.start();

    expect(pw.mockBrowser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: 'en-US',
        timezoneId: 'America/New_York',
        geolocation: { latitude: 40.7128, longitude: -74.006 },
        userAgent: 'CustomAgent/1.0',
      })
    );
  });

  describe('tabs', () => {
    it('starts with one tab', async () => {
      const session = await createAndStart();
      expect(session.tabs).toHaveLength(1);
    });

    it('returns a defensive copy of tabs', async () => {
      const session = await createAndStart();
      const tabs1 = session.tabs;
      const tabs2 = session.tabs;
      expect(tabs1).not.toBe(tabs2);
      expect(tabs1).toEqual(tabs2);
    });

    it('creates new tab', async () => {
      const session = await createAndStart();
      await session.newTab();

      expect(session.tabs).toHaveLength(2);
      expect(pw.mockContext.newPage).toHaveBeenCalledTimes(2);
    });

    it('creates new tab with url', async () => {
      const session = await createAndStart();
      const page = await session.newTab('https://example.com');

      expect(page.goto).toHaveBeenCalledWith('https://example.com', expect.any(Object));
    });

    it('new tab becomes active', async () => {
      const session = await createAndStart();
      const newPage = await session.newTab();
      expect(session.page).toBe(newPage);
    });

    it('switches active tab', async () => {
      const session = await createAndStart();
      const firstPage = session.page;
      await session.newTab();

      session.switchTab(0);
      expect(session.page).toBe(firstPage);
    });

    it('throws on invalid tab index', async () => {
      const session = await createAndStart();

      expect(() => session.switchTab(-1)).toThrow('Tab index -1 out of range');
      expect(() => session.switchTab(5)).toThrow('Tab index 5 out of range');
    });

    it('closes a tab', async () => {
      const session = await createAndStart();
      await session.newTab();
      expect(session.tabs).toHaveLength(2);

      await session.closeTab(1);
      expect(session.tabs).toHaveLength(1);
    });

    it('closes current tab and adjusts active index', async () => {
      const session = await createAndStart();
      const page1 = session.page;
      await session.newTab();

      await session.closeTab(1);
      expect(session.page).toBe(page1);
    });

    it('closes active tab and falls back to previous', async () => {
      const session = await createAndStart();
      await session.newTab();
      await session.newTab();

      session.switchTab(1);
      await session.closeTab(1);
      expect(session.tabs).toHaveLength(2);
    });

    it('throws when closing last tab', async () => {
      const session = await createAndStart();
      await expect(session.closeTab(0)).rejects.toThrow('Cannot close the last tab');
    });
  });

  describe('stealth', () => {
    it('reports stealth disabled by default', async () => {
      const { BrowserSession } = await import('../session');
      const session = new BrowserSession();

      expect(session.stealthEnabled).toBe(false);
      expect(session.stealthConfig).toBeNull();
    });

    it('handles stealth: true with default config', async () => {
      const { BrowserSession } = await import('../session');
      const session = new BrowserSession({ stealth: true });

      expect(session.stealthEnabled).toBe(true);
      expect(session.stealthConfig).toEqual({
        humanLikeTyping: true,
        humanLikeMouse: true,
        fingerprintRandomization: true,
        blockWebDriver: true,
        evasionScripts: [],
      });
    });

    it('handles stealth object config', async () => {
      const { BrowserSession } = await import('../session');
      const stealthCfg = {
        humanLikeTyping: true,
        humanLikeMouse: false,
        fingerprintRandomization: true,
        blockWebDriver: false,
        evasionScripts: ['custom.js'],
      };
      const session = new BrowserSession({ stealth: stealthCfg });

      expect(session.stealthEnabled).toBe(true);
      expect(session.stealthConfig).toEqual(stealthCfg);
    });
  });

  describe('proxy', () => {
    it('handles string proxy config', async () => {
      const { BrowserSession } = await import('../session');
      const session = new BrowserSession({ proxy: 'http://proxy.example.com:8080' });
      await session.start();

      expect(pw.module.chromium.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          proxy: { server: 'http://proxy.example.com:8080' },
        })
      );
    });

    it('handles object proxy config', async () => {
      const { BrowserSession } = await import('../session');
      const session = new BrowserSession({
        proxy: {
          server: 'http://proxy.example.com:8080',
          username: 'user',
          password: 'pass',
        },
      });
      await session.start();

      expect(pw.module.chromium.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          proxy: {
            server: 'http://proxy.example.com:8080',
            username: 'user',
            password: 'pass',
          },
        })
      );
    });
  });

  describe('cookies', () => {
    it('gets cookies from context', async () => {
      const session = await createAndStart();
      const cookies = await session.getCookies();

      expect(pw.mockContext.cookies).toHaveBeenCalled();
      expect(cookies).toEqual([]);
    });

    it('sets cookies on context', async () => {
      const session = await createAndStart();
      const cookies = [{ name: 'session', value: 'abc123', domain: '.example.com', path: '/' }];

      await session.setCookies(cookies);
      expect(pw.mockContext.addCookies).toHaveBeenCalledWith(cookies);
    });

    it('applies initial cookies on start', async () => {
      const cookies = [{ name: 'token', value: 'xyz', domain: '.example.com', path: '/' }];

      const { BrowserSession } = await import('../session');
      const session = new BrowserSession({ cookies });
      await session.start();

      expect(pw.mockContext.addCookies).toHaveBeenCalledWith(cookies);
    });

    it('saves and loads cookies to/from file', async () => {
      const { join } = await import('node:path');
      const { mkdtemp, readFile, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');

      const tmpDir = await mkdtemp(join(tmpdir(), 'cogitator-test-'));
      const filePath = join(tmpDir, 'cookies.json');

      try {
        const session = await createAndStart();

        await session.setCookies([
          { name: 'test', value: 'val', domain: '.example.com', path: '/' },
        ]);

        await session.saveCookies(filePath);

        const saved = JSON.parse(await readFile(filePath, 'utf-8'));
        expect(saved).toHaveLength(1);
        expect(saved[0].name).toBe('test');

        pw.cookieStore.length = 0;

        await session.loadCookies(filePath);
        expect(pw.mockContext.addCookies).toHaveBeenCalledWith(
          expect.arrayContaining([expect.objectContaining({ name: 'test', value: 'val' })])
        );
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });
  });

  it('close is safe to call multiple times', async () => {
    const session = await createAndStart();
    await session.close();
    await session.close();

    expect(pw.mockBrowser.close).toHaveBeenCalledTimes(1);
  });
});
