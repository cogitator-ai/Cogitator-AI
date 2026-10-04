import type {
  BrowserSessionConfig,
  BrowserCookie,
  StealthConfig,
  ProxyConfig,
} from '@cogitator-ai/types';
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  LaunchOptions,
  Page,
} from 'playwright';
import { applyStealthToContext, getStealthLaunchOptions } from './stealth';

declare global {
  interface SymbolConstructor {
    readonly asyncDispose: unique symbol;
  }
}

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_ACTION_TIMEOUT = 10_000;

const DEFAULT_STEALTH_CONFIG: StealthConfig = {
  humanLikeTyping: true,
  humanLikeMouse: true,
  fingerprintRandomization: true,
  blockWebDriver: true,
  evasionScripts: [],
};

type PlaywrightCookie = Parameters<BrowserContext['addCookies']>[0][number];

export type BrowserStartListener = (context: BrowserContext) => void;

function toPlaywrightCookies(cookies: BrowserCookie[]): PlaywrightCookie[] {
  return cookies.map((cookie) =>
    cookie.domain && !cookie.path ? { ...cookie, path: '/' } : cookie
  ) as PlaywrightCookie[];
}

function isCookieRecord(value: unknown): value is BrowserCookie {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string' || typeof record.value !== 'string') return false;
  return typeof record.url === 'string' || typeof record.domain === 'string';
}

export class BrowserSession {
  private _config: Required<
    Pick<BrowserSessionConfig, 'headless' | 'browser' | 'viewport' | 'timeout' | 'actionTimeout'>
  > &
    BrowserSessionConfig;
  private _browser: Browser | null = null;
  private _context: BrowserContext | null = null;
  private _pages: Page[] = [];
  private _activePageIndex = 0;
  private _starting: Promise<void> | null = null;
  private _startListeners = new Set<BrowserStartListener>();

  constructor(config?: BrowserSessionConfig) {
    const maxPages = config?.pool?.maxPages;
    if (maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages < 1)) {
      throw new Error(`pool.maxPages must be a positive integer, got ${maxPages}`);
    }
    this._config = {
      headless: true,
      browser: 'chromium',
      viewport: { ...DEFAULT_VIEWPORT },
      timeout: DEFAULT_TIMEOUT,
      actionTimeout: DEFAULT_ACTION_TIMEOUT,
      ...config,
    };
  }

  get config(): BrowserSessionConfig {
    return this._config;
  }

  get started(): boolean {
    return this._context !== null;
  }

  get stealthEnabled(): boolean {
    return !!this._config.stealth;
  }

  get stealthConfig(): StealthConfig | null {
    if (!this._config.stealth) return null;
    if (this._config.stealth === true) return { ...DEFAULT_STEALTH_CONFIG };
    return { ...DEFAULT_STEALTH_CONFIG, ...this._config.stealth };
  }

  async ensureStarted(): Promise<void> {
    if (this._context) return;
    if (this._starting) {
      await this._starting;
      return;
    }
    await this.start();
  }

  get page(): Page {
    this._pruneClosedPages();
    if (!this._pages.length) {
      throw new Error(this._context ? 'All pages are closed' : 'BrowserSession not started');
    }
    return this._pages[this._activePageIndex];
  }

  get tabs(): Page[] {
    this._pruneClosedPages();
    return [...this._pages];
  }

  get activeTabIndex(): number {
    this._pruneClosedPages();
    return this._activePageIndex;
  }

  get browser(): Browser | null {
    return this._browser;
  }

  get context(): BrowserContext | null {
    return this._context;
  }

  onStart(listener: BrowserStartListener): () => void {
    this._startListeners.add(listener);
    if (this._context) listener(this._context);
    return () => {
      this._startListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this._context || this._starting) {
      throw new Error('Session already started. Call close() first.');
    }

    this._starting = this._launch();
    try {
      await this._starting;
    } finally {
      this._starting = null;
    }
  }

  async newTab(url?: string): Promise<Page> {
    if (!this._context) {
      throw new Error('BrowserSession not started');
    }

    const maxPages = this._config.pool?.maxPages;
    if (maxPages !== undefined && this.tabs.length >= maxPages) {
      throw new Error(`Tab limit reached: pool.maxPages is ${maxPages}`);
    }

    const page = await this._context.newPage();
    this._trackPage(page);
    this._activePageIndex = this._pages.indexOf(page);

    if (url) {
      try {
        await this.assertRobotsAllow(url);
        await page.goto(url, { timeout: this._config.timeout });
      } catch (error) {
        this._untrackPage(page);
        await page.close().catch(() => undefined);
        throw error;
      }
    }

    return page;
  }

  /**
   * Throws when the session has a robots checker and the site's robots.txt disallows the URL, so
   * a caller learns why instead of seeing a blocked navigation.
   */
  async assertRobotsAllow(url: string): Promise<void> {
    if (this._config.robots && !(await this._config.robots.allows(url))) {
      throw new Error(`robots.txt does not allow visiting ${url}`);
    }
  }

  switchTab(index: number): void {
    this._pruneClosedPages();
    this._assertTabIndex(index);
    this._activePageIndex = index;
  }

  async closeTab(index?: number): Promise<void> {
    this._pruneClosedPages();
    const idx = index ?? this._activePageIndex;

    if (this._pages.length <= 1) {
      throw new Error('Cannot close the last tab');
    }

    this._assertTabIndex(idx);

    const page = this._pages[idx];
    await page.close();
    this._untrackPage(page);
  }

  async getCookies(): Promise<BrowserCookie[]> {
    if (!this._context) {
      throw new Error('BrowserSession not started');
    }
    return this._context.cookies() as Promise<BrowserCookie[]>;
  }

  async setCookies(cookies: BrowserCookie[]): Promise<void> {
    if (!this._context) {
      throw new Error('BrowserSession not started');
    }
    await this._context.addCookies(toPlaywrightCookies(cookies));
  }

  async saveCookies(filePath: string): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    const cookies = await this.getCookies();
    await writeFile(filePath, JSON.stringify(cookies, null, 2), 'utf-8');
  }

  async loadCookies(filePath: string): Promise<void> {
    const { readFile } = await import('node:fs/promises');
    const data = await readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(data);
    if (!Array.isArray(parsed)) {
      throw new Error(`Cookie file ${filePath} must contain a JSON array of cookies`);
    }
    await this.setCookies(parsed.filter(isCookieRecord));
  }

  async close(): Promise<void> {
    if (this._starting) {
      await this._starting.catch(() => undefined);
    }

    const browser = this._browser;
    const context = this._context;
    if (!browser && !context) return;

    this._reset();

    if (browser) {
      await browser.close();
    } else if (context) {
      await context.close();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private async _launch(): Promise<void> {
    const pw = await import('playwright');
    const browserType = this._config.browser;
    const launcher = pw[browserType];
    const stealth = this.stealthConfig;

    const launchOptions: LaunchOptions = { headless: this._config.headless };
    if (this._config.proxy) {
      launchOptions.proxy = this._resolveProxy(this._config.proxy);
    }

    const contextOptions: BrowserContextOptions = { viewport: this._config.viewport };
    if (this._config.locale) contextOptions.locale = this._config.locale;
    if (this._config.timezone) contextOptions.timezoneId = this._config.timezone;
    if (this._config.geolocation) {
      contextOptions.geolocation = this._config.geolocation;
      contextOptions.permissions = ['geolocation'];
    }
    if (this._config.userAgent) {
      contextOptions.userAgent = this._config.userAgent;
    } else if (stealth) {
      Object.assign(contextOptions, getStealthLaunchOptions(stealth, browserType));
    }

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      if (this._config.persistentContext) {
        context = await launcher.launchPersistentContext(this._config.persistentContext, {
          ...launchOptions,
          ...contextOptions,
        });
      } else {
        browser = await launcher.launch(launchOptions);
        context = await browser.newContext(contextOptions);
      }

      if (stealth) {
        await applyStealthToContext(context, stealth, {
          userAgent: contextOptions.userAgent,
          locale: contextOptions.locale,
        });
      }

      context.setDefaultNavigationTimeout(this._config.timeout);
      context.setDefaultTimeout(this._config.actionTimeout);

      if (this._config.cookies?.length) {
        await context.addCookies(toPlaywrightCookies(this._config.cookies));
      }

      const robots = this._config.robots;
      if (robots) {
        await context.route('**/*', async (route) => {
          const request = route.request();
          if (!request.isNavigationRequest() || (await robots.allows(request.url()))) {
            await route.fallback();
            return;
          }
          await route.abort('blockedbyclient');
        });
      }

      const existingPages = context.pages();
      const initialPages = existingPages.length ? existingPages : [await context.newPage()];

      this._browser = browser;
      this._context = context;
      this._pages = [...initialPages];
      this._activePageIndex = 0;

      const activeContext = context;
      activeContext.on('page', (page) => {
        if (this._context === activeContext) this._trackPage(page);
      });
      activeContext.on('close', () => {
        if (this._context === activeContext) this._reset();
      });

      for (const listener of this._startListeners) {
        listener(activeContext);
      }
    } catch (error) {
      this._reset();
      if (browser) {
        await browser.close().catch(() => undefined);
      } else if (context) {
        await context.close().catch(() => undefined);
      }
      throw error;
    }
  }

  private _reset(): void {
    this._browser = null;
    this._context = null;
    this._pages = [];
    this._activePageIndex = 0;
  }

  private _trackPage(page: Page): void {
    if (!this._pages.includes(page)) {
      this._pages.push(page);
    }
  }

  private _untrackPage(page: Page): void {
    const idx = this._pages.indexOf(page);
    if (idx === -1) return;

    this._pages.splice(idx, 1);
    if (this._activePageIndex > idx || this._activePageIndex >= this._pages.length) {
      this._activePageIndex = Math.max(0, this._activePageIndex - 1);
    }
  }

  private _assertTabIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this._pages.length) {
      throw new Error(`Tab index ${index} out of range [0..${this._pages.length - 1}]`);
    }
  }

  private _pruneClosedPages(): void {
    if (!this._pages.some((p) => p.isClosed())) return;

    const active = this._pages[this._activePageIndex];
    this._pages = this._pages.filter((p) => !p.isClosed());
    this._activePageIndex =
      active && !active.isClosed()
        ? this._pages.indexOf(active)
        : Math.min(this._activePageIndex, Math.max(0, this._pages.length - 1));
  }

  private _resolveProxy(proxy: string | ProxyConfig): NonNullable<LaunchOptions['proxy']> {
    if (typeof proxy === 'string') {
      return { server: proxy };
    }
    return {
      server: proxy.server,
      username: proxy.username,
      password: proxy.password,
    };
  }
}
