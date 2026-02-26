import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEvasionScripts } from '../stealth/evasions';
import { getRandomUserAgent, getAllUserAgents } from '../stealth/user-agents';
import { applyStealthToContext, getStealthLaunchOptions } from '../stealth';
import type { BrowserContext } from 'playwright';
import type { StealthConfig } from '@cogitator-ai/types';

function createMockContext() {
  return {
    addInitScript: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserContext;
}

describe('evasions', () => {
  it('returns an array of strings', () => {
    const scripts = getEvasionScripts();
    expect(Array.isArray(scripts)).toBe(true);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(typeof script).toBe('string');
    }
  });

  it('each script is a non-empty string that could be injected', () => {
    const scripts = getEvasionScripts();
    for (const script of scripts) {
      expect(script.length).toBeGreaterThan(10);
      expect(script).not.toMatch(/^\s*$/);
    }
  });

  it('includes webdriver evasion', () => {
    const scripts = getEvasionScripts();
    const hasWebdriver = scripts.some((s) => s.includes('webdriver'));
    expect(hasWebdriver).toBe(true);
  });

  it('includes plugins evasion', () => {
    const scripts = getEvasionScripts();
    const hasPlugins = scripts.some((s) => s.includes('plugins'));
    expect(hasPlugins).toBe(true);
  });

  it('includes canvas fingerprint evasion', () => {
    const scripts = getEvasionScripts();
    const hasCanvas = scripts.some((s) => s.includes('toDataURL'));
    expect(hasCanvas).toBe(true);
  });

  it('includes webgl evasion', () => {
    const scripts = getEvasionScripts();
    const hasWebgl = scripts.some((s) => s.includes('WebGLRenderingContext'));
    expect(hasWebgl).toBe(true);
  });
});

describe('user-agents', () => {
  it('getRandomUserAgent returns a string containing Mozilla', () => {
    const ua = getRandomUserAgent();
    expect(typeof ua).toBe('string');
    expect(ua).toContain('Mozilla');
  });

  it('getRandomUserAgent handles chromium', () => {
    const ua = getRandomUserAgent('chromium');
    expect(ua).toContain('Mozilla');
    expect(ua).toMatch(/Chrome|Edg/);
  });

  it('getRandomUserAgent handles firefox', () => {
    const ua = getRandomUserAgent('firefox');
    expect(ua).toContain('Firefox');
  });

  it('getRandomUserAgent handles webkit', () => {
    const ua = getRandomUserAgent('webkit');
    expect(ua).toContain('Safari');
  });

  it('getRandomUserAgent defaults to chromium', () => {
    const all = getAllUserAgents();
    const ua = getRandomUserAgent();
    expect(all.chromium).toContain(ua);
  });

  it('getAllUserAgents has entries for all browser types', () => {
    const all = getAllUserAgents();
    expect(Object.keys(all)).toContain('chromium');
    expect(Object.keys(all)).toContain('firefox');
    expect(Object.keys(all)).toContain('webkit');
    expect(all.chromium.length).toBeGreaterThanOrEqual(10);
    expect(all.firefox.length).toBeGreaterThanOrEqual(5);
    expect(all.webkit.length).toBeGreaterThanOrEqual(5);
  });

  it('getAllUserAgents returns copies that do not affect internal data', () => {
    const first = getAllUserAgents();
    const originalLength = first.chromium.length;

    first.chromium.push('MutatedAgent/1.0');
    first.chromium.length = 0;

    const second = getAllUserAgents();
    expect(second.chromium.length).toBe(originalLength);
    expect(second.chromium).not.toContain('MutatedAgent/1.0');
  });
});

describe('humanLikeType', () => {
  it('calls keyboard.type per character with delays', async () => {
    vi.useFakeTimers();
    const { humanLikeType } = await import('../stealth/human-like');

    const mockPage = {
      click: vi.fn().mockResolvedValue(undefined),
      keyboard: { type: vi.fn().mockResolvedValue(undefined) },
    };

    const promise = humanLikeType(mockPage as never, '#input', 'hi');

    for (let i = 0; i < 100; i++) {
      await vi.advanceTimersByTimeAsync(200);
    }
    await promise;

    expect(mockPage.click).toHaveBeenCalledWith('#input');
    expect(mockPage.keyboard.type).toHaveBeenCalledTimes(2);
    expect(mockPage.keyboard.type).toHaveBeenCalledWith('h');
    expect(mockPage.keyboard.type).toHaveBeenCalledWith('i');

    vi.useRealTimers();
  });
});

describe('humanLikeClick', () => {
  it('moves mouse along bezier curve then clicks', async () => {
    vi.useFakeTimers();
    const { humanLikeClick } = await import('../stealth/human-like');

    const mockPage = {
      locator: vi.fn().mockReturnValue({
        boundingBox: vi.fn().mockResolvedValue({ x: 100, y: 100, width: 50, height: 30 }),
        click: vi.fn().mockResolvedValue(undefined),
      }),
      mouse: {
        move: vi.fn().mockResolvedValue(undefined),
        click: vi.fn().mockResolvedValue(undefined),
      },
    };

    const promise = humanLikeClick(mockPage as never, '#btn');

    for (let i = 0; i < 200; i++) {
      await vi.advanceTimersByTimeAsync(50);
    }
    await promise;

    expect(mockPage.mouse.move).toHaveBeenCalled();
    expect(mockPage.mouse.click).toHaveBeenCalledTimes(1);
    const [clickX, clickY] = mockPage.mouse.click.mock.calls[0];
    expect(clickX).toBeGreaterThan(90);
    expect(clickX).toBeLessThan(160);
    expect(clickY).toBeGreaterThan(100);
    expect(clickY).toBeLessThan(140);

    vi.useRealTimers();
  });

  it('falls back to element.click when no bounding box', async () => {
    vi.useFakeTimers();
    const { humanLikeClick } = await import('../stealth/human-like');

    const mockElement = {
      boundingBox: vi.fn().mockResolvedValue(null),
      click: vi.fn().mockResolvedValue(undefined),
    };
    const mockPage = {
      locator: vi.fn().mockReturnValue(mockElement),
      mouse: { move: vi.fn(), click: vi.fn() },
    };

    const promise = humanLikeClick(mockPage as never, '#hidden');
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(mockElement.click).toHaveBeenCalled();
    expect(mockPage.mouse.move).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe('humanLikeScroll', () => {
  it('scrolls down in multiple steps', async () => {
    vi.useFakeTimers();
    const { humanLikeScroll } = await import('../stealth/human-like');

    const mockPage = {
      mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
    };

    const promise = humanLikeScroll(mockPage as never, 'down', 500);

    for (let i = 0; i < 50; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }
    await promise;

    expect(mockPage.mouse.wheel).toHaveBeenCalled();
    const calls = mockPage.mouse.wheel.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBeLessThanOrEqual(8);
    for (const [dx] of calls) {
      expect(dx).toBe(0);
    }

    vi.useRealTimers();
  });

  it('scrolls up with negative delta', async () => {
    vi.useFakeTimers();
    const { humanLikeScroll } = await import('../stealth/human-like');

    const mockPage = {
      mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
    };

    const promise = humanLikeScroll(mockPage as never, 'up', 300);

    for (let i = 0; i < 50; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }
    await promise;

    const calls = mockPage.mouse.wheel.mock.calls;
    const totalDy = calls.reduce((sum: number, [, dy]: [number, number]) => sum + dy, 0);
    expect(totalDy).toBeLessThan(0);

    vi.useRealTimers();
  });
});

describe('applyStealthToContext', () => {
  it('calls addInitScript for each evasion script', async () => {
    const ctx = createMockContext();
    const config: StealthConfig = {
      fingerprintRandomization: true,
      blockWebDriver: true,
    };

    await applyStealthToContext(ctx, config);

    const evasionCount = getEvasionScripts().length;
    expect(ctx.addInitScript).toHaveBeenCalledTimes(evasionCount);
  });

  it('adds custom evasion scripts after built-in ones', async () => {
    const ctx = createMockContext();
    const config: StealthConfig = {
      fingerprintRandomization: true,
      blockWebDriver: true,
      evasionScripts: ['console.log("custom1")', 'console.log("custom2")'],
    };

    await applyStealthToContext(ctx, config);

    const evasionCount = getEvasionScripts().length;
    expect(ctx.addInitScript).toHaveBeenCalledTimes(evasionCount + 2);
    const calls = (ctx.addInitScript as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[evasionCount][0]).toBe('console.log("custom1")');
    expect(calls[evasionCount + 1][0]).toBe('console.log("custom2")');
  });

  it('skips evasions when both fingerprint and webdriver are disabled', async () => {
    const ctx = createMockContext();
    const config: StealthConfig = {
      fingerprintRandomization: false,
      blockWebDriver: false,
    };

    await applyStealthToContext(ctx, config);

    expect(ctx.addInitScript).not.toHaveBeenCalled();
  });

  it('applies evasions when only fingerprintRandomization is true', async () => {
    const ctx = createMockContext();
    const config: StealthConfig = {
      fingerprintRandomization: true,
      blockWebDriver: false,
    };

    await applyStealthToContext(ctx, config);

    expect(ctx.addInitScript).toHaveBeenCalledTimes(getEvasionScripts().length);
  });

  it('applies evasions when only blockWebDriver is true', async () => {
    const ctx = createMockContext();
    const config: StealthConfig = {
      fingerprintRandomization: false,
      blockWebDriver: true,
    };

    await applyStealthToContext(ctx, config);

    expect(ctx.addInitScript).toHaveBeenCalledTimes(getEvasionScripts().length);
  });
});

describe('getStealthLaunchOptions', () => {
  it('returns object with userAgent string', () => {
    const opts = getStealthLaunchOptions({});
    expect(opts).toHaveProperty('userAgent');
    expect(typeof opts.userAgent).toBe('string');
    expect(opts.userAgent as string).toContain('Mozilla');
  });

  it('returns chromium UA by default', () => {
    const opts = getStealthLaunchOptions({});
    const all = getAllUserAgents();
    expect(all.chromium).toContain(opts.userAgent);
  });

  it('returns firefox UA when specified', () => {
    const opts = getStealthLaunchOptions({}, 'firefox');
    expect(opts.userAgent as string).toContain('Firefox');
  });

  it('returns webkit UA when specified', () => {
    const opts = getStealthLaunchOptions({}, 'webkit');
    expect(opts.userAgent as string).toContain('Safari');
  });

  it('returns empty object when fingerprintRandomization is false', () => {
    const opts = getStealthLaunchOptions({ fingerprintRandomization: false });
    expect(opts).toEqual({});
    expect(opts).not.toHaveProperty('userAgent');
  });
});

describe('BrowserSession stealth integration', () => {
  let pw: ReturnType<typeof createPlaywrightMock>;

  function createPlaywrightMock() {
    const mockPage = {
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      close: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('about:blank'),
      title: vi.fn().mockResolvedValue(''),
    };

    const mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      addCookies: vi.fn().mockResolvedValue(undefined),
      cookies: vi.fn().mockResolvedValue([]),
      addInitScript: vi.fn().mockResolvedValue(undefined),
    };

    const mockBrowser = {
      newContext: vi.fn().mockResolvedValue(mockContext),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const launcher = { launch: vi.fn().mockResolvedValue(mockBrowser) };

    return {
      module: { chromium: launcher, firefox: launcher, webkit: launcher },
      mockBrowser,
      mockContext,
      mockPage,
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    pw = createPlaywrightMock();

    vi.mock('playwright', () => ({
      default: {},
      chromium: { launch: vi.fn() },
      firefox: { launch: vi.fn() },
      webkit: { launch: vi.fn() },
    }));

    const playwright = await import('playwright');
    Object.assign(playwright, pw.module);
  });

  it('applies evasion scripts when stealth is enabled', async () => {
    const { BrowserSession } = await import('../session');
    const session = new BrowserSession({ stealth: true });
    await session.start();

    const evasionCount = getEvasionScripts().length;
    expect(pw.mockContext.addInitScript).toHaveBeenCalledTimes(evasionCount);
  });

  it('sets random userAgent when stealth is enabled and no custom UA', async () => {
    const { BrowserSession } = await import('../session');
    const session = new BrowserSession({ stealth: true });
    await session.start();

    const ctxCall = pw.mockBrowser.newContext.mock.calls[0][0];
    expect(ctxCall.userAgent).toBeDefined();
    expect(ctxCall.userAgent).toContain('Mozilla');
  });

  it('preserves custom userAgent even with stealth enabled', async () => {
    const { BrowserSession } = await import('../session');
    const session = new BrowserSession({
      stealth: true,
      userAgent: 'MyCustomAgent/1.0',
    });
    await session.start();

    const ctxCall = pw.mockBrowser.newContext.mock.calls[0][0];
    expect(ctxCall.userAgent).toBe('MyCustomAgent/1.0');
  });

  it('does not apply evasions when stealth is disabled', async () => {
    const { BrowserSession } = await import('../session');
    const session = new BrowserSession();
    await session.start();

    expect(pw.mockContext.addInitScript).not.toHaveBeenCalled();
  });

  it('does not set random UA when stealth is disabled', async () => {
    const { BrowserSession } = await import('../session');
    const session = new BrowserSession();
    await session.start();

    const ctxCall = pw.mockBrowser.newContext.mock.calls[0][0];
    expect(ctxCall.userAgent).toBeUndefined();
  });

  it('applies custom evasion scripts from stealth config', async () => {
    const { BrowserSession } = await import('../session');
    const session = new BrowserSession({
      stealth: {
        fingerprintRandomization: true,
        blockWebDriver: true,
        evasionScripts: ['window.__custom = true'],
      },
    });
    await session.start();

    const evasionCount = getEvasionScripts().length;
    expect(pw.mockContext.addInitScript).toHaveBeenCalledTimes(evasionCount + 1);
    const lastCall = pw.mockContext.addInitScript.mock.calls[evasionCount][0];
    expect(lastCall).toBe('window.__custom = true');
  });
});
