import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserSessionConfig } from '@cogitator-ai/types';

function createPlaywrightMock() {
  let currentUrl = 'about:blank';
  let currentTitle = '';
  const cookieStore: Array<Record<string, unknown>> = [];

  const makePage = () => {
    let closed = false;
    return {
      goto: vi.fn().mockImplementation(async (url: string) => {
        currentUrl = url;
        currentTitle = 'Test Page';
        return { status: () => 200 };
      }),
      close: vi.fn().mockImplementation(async () => {
        closed = true;
      }),
      isClosed: vi.fn().mockImplementation(() => closed),
      url: vi.fn().mockImplementation(() => currentUrl),
      title: vi.fn().mockImplementation(async () => currentTitle),
      setViewportSize: vi.fn().mockResolvedValue(undefined),
      goBack: vi.fn().mockResolvedValue(null),
      goForward: vi.fn().mockResolvedValue(null),
      reload: vi.fn().mockResolvedValue(null),
    };
  };

  const firstPage = makePage();

  const contextListeners = new Map<string, Array<(arg?: unknown) => void>>();
  const mockContext = {
    pages: vi.fn().mockReturnValue([]),
    on: vi.fn().mockImplementation((event: string, listener: (arg?: unknown) => void) => {
      const list = contextListeners.get(event) ?? [];
      list.push(listener);
      contextListeners.set(event, list);
    }),
    emit: (event: string, arg?: unknown) => {
      for (const listener of contextListeners.get(event) ?? []) listener(arg);
    },
    newPage: vi.fn().mockImplementation(async () => makePage()),
    addCookies: vi.fn().mockImplementation(async (cookies: Array<Record<string, unknown>>) => {
      cookieStore.push(...cookies);
    }),
    cookies: vi.fn().mockImplementation(async () => [...cookieStore]),
    close: vi.fn().mockResolvedValue(undefined),
    setDefaultNavigationTimeout: vi.fn(),
    setDefaultTimeout: vi.fn(),
    route: vi.fn().mockResolvedValue(undefined),
  };

  mockContext.newPage.mockResolvedValueOnce(firstPage);

  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
  };

  const mockChromium = {
    launch: vi.fn().mockResolvedValue(mockBrowser),
    launchPersistentContext: vi.fn().mockResolvedValue(mockContext),
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

    it('fills omitted stealth options with documented defaults', async () => {
      const { BrowserSession } = await import('../session');
      const session = new BrowserSession({ stealth: { humanLikeMouse: false } });

      expect(session.stealthConfig).toEqual({
        humanLikeTyping: true,
        humanLikeMouse: false,
        fingerprintRandomization: true,
        blockWebDriver: true,
        evasionScripts: [],
      });
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

  describe('robots', () => {
    const robots = {
      allows: vi.fn(async (url: string) => !new URL(url).pathname.startsWith('/private')),
    };

    function routeHandler() {
      const call = pw.mockContext.route.mock.calls[0] as unknown as
        [string, (route: unknown) => Promise<void>] | undefined;
      if (!call) throw new Error('no route registered');
      return call;
    }

    function fakeRoute(url: string, navigation: boolean) {
      return {
        request: () => ({ url: () => url, isNavigationRequest: () => navigation }),
        fallback: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn().mockResolvedValue(undefined),
      };
    }

    it('blocks navigations the site disallows and passes everything else on', async () => {
      await createAndStart({ robots });
      const [pattern, handler] = routeHandler();
      expect(pattern).toBe('**/*');

      const blocked = fakeRoute('https://site.test/private/x', true);
      await handler(blocked);
      expect(blocked.abort).toHaveBeenCalledWith('blockedbyclient');

      const allowed = fakeRoute('https://site.test/news', true);
      await handler(allowed);
      expect(allowed.fallback).toHaveBeenCalled();

      const image = fakeRoute('https://site.test/private/logo.png', false);
      await handler(image);
      expect(image.fallback).toHaveBeenCalled();
    });

    it('explains a disallowed tab instead of opening it', async () => {
      const session = await createAndStart({ robots });
      await expect(session.newTab('https://site.test/private/x')).rejects.toThrow(
        'robots.txt does not allow visiting https://site.test/private/x'
      );
      expect(session.tabs).toHaveLength(1);
    });

    it('registers no route without a checker', async () => {
      await createAndStart();
      expect(pw.mockContext.route).not.toHaveBeenCalled();
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

  it('throws when start() is called twice without close()', async () => {
    const session = await createAndStart();

    await expect(session.start()).rejects.toThrow('Session already started');
  });

  it('recovers to an open page when active page is closed', async () => {
    const session = await createAndStart();
    const secondPage = await session.newTab();

    const firstPage = session.tabs[0];
    (firstPage.isClosed as ReturnType<typeof vi.fn>).mockReturnValue(true);

    session.switchTab(0);
    expect(session.page).toBe(secondPage);
  });

  it('throws when all pages are closed', async () => {
    const session = await createAndStart();
    const firstPage = session.tabs[0];
    (firstPage.isClosed as ReturnType<typeof vi.fn>).mockReturnValue(true);

    expect(() => session.page).toThrow('All pages are closed');
  });

  describe('loadCookies validation', () => {
    it('filters out invalid entries from cookie file', async () => {
      const { join } = await import('node:path');
      const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');

      const tmpDir = await mkdtemp(join(tmpdir(), 'cogitator-test-'));
      const filePath = join(tmpDir, 'cookies.json');

      try {
        const session = await createAndStart();

        const mixedData = [
          { name: 'valid', value: 'cookie', domain: '.example.com', path: '/' },
          { garbage: true },
          42,
          null,
          'string-entry',
          { name: 'also-valid', value: 'v2', domain: '.test.com', path: '/' },
        ];
        await writeFile(filePath, JSON.stringify(mixedData), 'utf-8');

        await session.loadCookies(filePath);

        expect(pw.mockContext.addCookies).toHaveBeenCalledWith([
          expect.objectContaining({ name: 'valid', value: 'cookie' }),
          expect.objectContaining({ name: 'also-valid', value: 'v2' }),
        ]);
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });
  });

  describe('lifecycle hardening', () => {
    it('launches a single browser when ensureStarted is called concurrently', async () => {
      const { BrowserSession } = await import('../session');
      const session = new BrowserSession();

      await Promise.all([
        session.ensureStarted(),
        session.ensureStarted(),
        session.ensureStarted(),
      ]);

      expect(pw.module.chromium.launch).toHaveBeenCalledTimes(1);
      expect(session.started).toBe(true);
    });

    it('closes the launched browser and resets state when context creation fails', async () => {
      const { BrowserSession } = await import('../session');
      const session = new BrowserSession();
      pw.mockBrowser.newContext.mockRejectedValueOnce(new Error('context boom'));

      await expect(session.start()).rejects.toThrow('context boom');

      expect(pw.mockBrowser.close).toHaveBeenCalledTimes(1);
      expect(session.started).toBe(false);
      expect(session.browser).toBeNull();

      await session.start();
      expect(session.started).toBe(true);
    });

    it('resets when the context closes unexpectedly so ensureStarted relaunches', async () => {
      const session = await createAndStart();

      pw.mockContext.emit('close');
      expect(session.started).toBe(false);
      expect(() => session.page).toThrow('BrowserSession not started');

      await session.ensureStarted();
      expect(pw.module.chromium.launch).toHaveBeenCalledTimes(2);
    });

    it('notifies onStart listeners on start and immediately when already started', async () => {
      const { BrowserSession } = await import('../session');
      const session = new BrowserSession();
      const before = vi.fn();
      const unsubscribe = session.onStart(before);

      await session.start();
      expect(before).toHaveBeenCalledWith(pw.mockContext);

      const after = vi.fn();
      session.onStart(after);
      expect(after).toHaveBeenCalledWith(pw.mockContext);

      unsubscribe();
      await session.close();
      await session.start();
      expect(before).toHaveBeenCalledTimes(1);
      expect(after).toHaveBeenCalledTimes(2);
    });
  });

  describe('persistentContext', () => {
    it('launches a persistent context and reuses its initial page', async () => {
      const existingPage = pw.makePage();
      pw.mockContext.pages.mockReturnValue([existingPage]);

      const { BrowserSession } = await import('../session');
      const session = new BrowserSession({
        persistentContext: '/tmp/profile',
        locale: 'de-DE',
        proxy: 'http://proxy:8080',
      });
      await session.start();

      expect(pw.module.chromium.launch).not.toHaveBeenCalled();
      expect(pw.module.chromium.launchPersistentContext).toHaveBeenCalledWith(
        '/tmp/profile',
        expect.objectContaining({
          headless: true,
          locale: 'de-DE',
          proxy: { server: 'http://proxy:8080' },
          viewport: { width: 1280, height: 720 },
        })
      );
      expect(session.browser).toBeNull();
      expect(session.page).toBe(existingPage);
      expect(pw.mockContext.newPage).not.toHaveBeenCalled();

      await session.close();
      expect(pw.mockContext.close).toHaveBeenCalledTimes(1);
      expect(session.started).toBe(false);
    });
  });

  describe('pool.maxPages', () => {
    it('rejects invalid maxPages', async () => {
      const { BrowserSession } = await import('../session');
      expect(() => new BrowserSession({ pool: { maxPages: 0 } })).toThrow('pool.maxPages');
      expect(() => new BrowserSession({ pool: { maxPages: 1.5 } })).toThrow('pool.maxPages');
    });

    it('refuses to open more tabs than maxPages', async () => {
      const session = await createAndStart({ pool: { maxPages: 2 } });
      await session.newTab();

      await expect(session.newTab()).rejects.toThrow('Tab limit reached: pool.maxPages is 2');
      expect(session.tabs).toHaveLength(2);
    });
  });

  describe('tab tracking', () => {
    it('tracks pages opened by the site (popups, target=_blank)', async () => {
      const session = await createAndStart();
      const popup = pw.makePage();

      pw.mockContext.emit('page', popup);

      expect(session.tabs).toHaveLength(2);
      expect(session.tabs[1]).toBe(popup);
      expect(session.activeTabIndex).toBe(0);
    });

    it('does not duplicate pages created through newTab', async () => {
      const session = await createAndStart();
      const page = pw.makePage();
      pw.mockContext.newPage.mockImplementationOnce(async () => {
        pw.mockContext.emit('page', page);
        return page;
      });

      await session.newTab();
      expect(session.tabs).toHaveLength(2);
      expect(session.page).toBe(page);
    });

    it('switchTab indexes the pruned tab list after a tab closed externally', async () => {
      const session = await createAndStart();
      const second = await session.newTab();
      const third = await session.newTab();

      await second.close();
      session.switchTab(1);

      expect(session.page).toBe(third);
    });

    it('closeTab keeps the active page when closing a tab before it', async () => {
      const session = await createAndStart();
      await session.newTab();
      const third = await session.newTab();

      await session.closeTab(0);
      expect(session.page).toBe(third);
      expect(session.activeTabIndex).toBe(1);
    });
  });

  describe('cookie normalization', () => {
    it('defaults path to / for domain cookies without a path', async () => {
      const session = await createAndStart();
      await session.setCookies([{ name: 'a', value: 'b', domain: '.example.com' }]);

      expect(pw.mockContext.addCookies).toHaveBeenLastCalledWith([
        { name: 'a', value: 'b', domain: '.example.com', path: '/' },
      ]);
    });

    it('rejects cookie files that do not contain an array', async () => {
      const { join } = await import('node:path');
      const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const tmpDir = await mkdtemp(join(tmpdir(), 'cogitator-test-'));
      const filePath = join(tmpDir, 'cookies.json');

      try {
        const session = await createAndStart();
        await writeFile(filePath, JSON.stringify({ name: 'x', value: 'y' }), 'utf-8');
        await expect(session.loadCookies(filePath)).rejects.toThrow('must contain a JSON array');
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });
  });
});
