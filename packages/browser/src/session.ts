import type {
  BrowserSessionConfig,
  BrowserCookie,
  BrowserType,
  StealthConfig,
  ProxyConfig,
} from '@cogitator-ai/types';
import type { Browser, BrowserContext, Page } from 'playwright';
import { applyStealthToContext, getRandomUserAgent } from './stealth';

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

export class BrowserSession {
  private _config: Required<
    Pick<BrowserSessionConfig, 'headless' | 'browser' | 'viewport' | 'timeout' | 'actionTimeout'>
  > &
    BrowserSessionConfig;
  private _browser: Browser | null = null;
  private _context: BrowserContext | null = null;
  private _pages: Page[] = [];
  private _activePageIndex = 0;

  constructor(config?: BrowserSessionConfig) {
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

  get stealthEnabled(): boolean {
    return !!this._config.stealth;
  }

  get stealthConfig(): StealthConfig | null {
    if (!this._config.stealth) return null;
    if (this._config.stealth === true) return { ...DEFAULT_STEALTH_CONFIG };
    return this._config.stealth;
  }

  get page(): Page {
    if (!this._pages.length) {
      throw new Error('BrowserSession not started');
    }
    if (this._pages[this._activePageIndex].isClosed()) {
      const openIdx = this._pages.findIndex((p) => !p.isClosed());
      if (openIdx === -1) {
        throw new Error('All pages are closed');
      }
      this._activePageIndex = openIdx;
    }
    return this._pages[this._activePageIndex];
  }

  get tabs(): Page[] {
    return [...this._pages];
  }

  get browser(): Browser | null {
    return this._browser;
  }

  get context(): BrowserContext | null {
    return this._context;
  }

  async start(): Promise<void> {
    if (this._browser) {
      throw new Error('Session already started. Call close() first.');
    }

    const pw = await import('playwright');

    const launchOptions: Record<string, unknown> = {
      headless: this._config.headless,
    };

    if (this._config.proxy) {
      launchOptions.proxy = this._resolveProxy(this._config.proxy);
    }

    const browserType = this._config.browser ?? 'chromium';
    this._browser = await pw[browserType].launch(launchOptions);

    const contextOptions: Record<string, unknown> = {
      viewport: this._config.viewport,
    };

    if (this._config.locale) contextOptions.locale = this._config.locale;
    if (this._config.timezone) contextOptions.timezoneId = this._config.timezone;
    if (this._config.geolocation) contextOptions.geolocation = this._config.geolocation;
    if (this._config.userAgent) {
      contextOptions.userAgent = this._config.userAgent;
    } else if (this.stealthEnabled) {
      contextOptions.userAgent = getRandomUserAgent(browserType as BrowserType);
    }

    this._context = await this._browser.newContext(contextOptions);

    if (this.stealthEnabled) {
      await applyStealthToContext(this._context, this.stealthConfig!);
    }

    this._context.setDefaultNavigationTimeout(this._config.timeout);
    this._context.setDefaultTimeout(this._config.actionTimeout);

    const firstPage = await this._context.newPage();
    this._pages = [firstPage];
    this._activePageIndex = 0;

    if (this._config.cookies?.length) {
      await this._context.addCookies(
        this._config.cookies as Parameters<BrowserContext['addCookies']>[0]
      );
    }
  }

  async newTab(url?: string): Promise<Page> {
    if (!this._context) {
      throw new Error('BrowserSession not started');
    }

    const page = await this._context.newPage();

    if (url) {
      await page.goto(url, { timeout: this._config.timeout });
    }

    this._pages.push(page);
    this._activePageIndex = this._pages.length - 1;

    return page;
  }

  switchTab(index: number): void {
    if (index < 0 || index >= this._pages.length) {
      throw new Error(`Tab index ${index} out of range [0..${this._pages.length - 1}]`);
    }
    this._activePageIndex = index;
  }

  async closeTab(index?: number): Promise<void> {
    const idx = index ?? this._activePageIndex;

    if (this._pages.length <= 1) {
      throw new Error('Cannot close the last tab');
    }

    if (idx < 0 || idx >= this._pages.length) {
      throw new Error(`Tab index ${idx} out of range [0..${this._pages.length - 1}]`);
    }

    await this._pages[idx].close();
    this._pages.splice(idx, 1);

    if (this._activePageIndex >= this._pages.length) {
      this._activePageIndex = this._pages.length - 1;
    } else if (this._activePageIndex > idx) {
      this._activePageIndex--;
    }
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
    await this._context.addCookies(cookies as Parameters<BrowserContext['addCookies']>[0]);
  }

  async saveCookies(filePath: string): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    const cookies = await this.getCookies();
    await writeFile(filePath, JSON.stringify(cookies, null, 2), 'utf-8');
  }

  async loadCookies(filePath: string): Promise<void> {
    const { readFile } = await import('node:fs/promises');
    const data = await readFile(filePath, 'utf-8');
    const parsed: unknown[] = JSON.parse(data);
    const cookies = parsed.filter(
      (c): c is BrowserCookie =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as Record<string, unknown>).name === 'string' &&
        typeof (c as Record<string, unknown>).value === 'string'
    );
    await this.setCookies(cookies);
  }

  async close(): Promise<void> {
    if (!this._browser) return;

    await this._browser.close();
    this._browser = null;
    this._context = null;
    this._pages = [];
    this._activePageIndex = 0;
  }

  private _resolveProxy(proxy: string | ProxyConfig): Record<string, string | undefined> {
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
