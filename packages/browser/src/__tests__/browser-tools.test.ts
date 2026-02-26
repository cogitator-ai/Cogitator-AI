import { describe, it, expect, vi } from 'vitest';
import { browserTools } from '../tools/index';
import type { BrowserSession } from '../session';

vi.mock('playwright', () => ({
  chromium: { launch: vi.fn() },
}));

function createMockSession(): BrowserSession {
  const mockPage = {
    goto: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    url: vi.fn().mockReturnValue('about:blank'),
    title: vi.fn().mockResolvedValue(''),
    waitForURL: vi.fn(),
    waitForSelector: vi.fn(),
    click: vi.fn(),
    fill: vi.fn(),
    type: vi.fn(),
    selectOption: vi.fn(),
    hover: vi.fn(),
    evaluate: vi.fn(),
    keyboard: { press: vi.fn(), type: vi.fn() },
    dragAndDrop: vi.fn(),
    setInputFiles: vi.fn(),
    textContent: vi.fn(),
    innerHTML: vi.fn(),
    content: vi.fn(),
    getAttribute: vi.fn(),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
    viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    accessibility: { snapshot: vi.fn().mockResolvedValue(null) },
    locator: vi.fn().mockReturnValue({
      screenshot: vi.fn(),
      boundingBox: vi.fn(),
      evaluate: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      nth: vi.fn(),
      first: vi.fn(),
    }),
    getByRole: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
    getByText: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
    getByLabel: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
    getByPlaceholder: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
    route: vi.fn(),
    unroute: vi.fn(),
    waitForResponse: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    mouse: { move: vi.fn(), click: vi.fn(), wheel: vi.fn() },
  };

  return {
    page: mockPage,
    stealthEnabled: false,
    stealthConfig: null,
  } as unknown as BrowserSession;
}

describe('browserTools', () => {
  const session = createMockSession();

  it('returns all 32 tools with no options', () => {
    const tools = browserTools(session);
    expect(tools).toHaveLength(32);
  });

  it('all tools have unique names', () => {
    const tools = browserTools(session);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all tool names start with browser_', () => {
    const tools = browserTools(session);
    for (const t of tools) {
      expect(t.name).toMatch(/^browser_/);
    }
  });

  it('returns 7 navigation tools', () => {
    const tools = browserTools(session, { modules: ['navigation'] });
    expect(tools).toHaveLength(7);
  });

  it('returns 9 interaction tools', () => {
    const tools = browserTools(session, { modules: ['interaction'] });
    expect(tools).toHaveLength(9);
  });

  it('returns 7 extraction tools', () => {
    const tools = browserTools(session, { modules: ['extraction'] });
    expect(tools).toHaveLength(7);
  });

  it('returns 4 vision tools', () => {
    const tools = browserTools(session, { modules: ['vision'] });
    expect(tools).toHaveLength(4);
  });

  it('returns 5 network tools', () => {
    const tools = browserTools(session, { modules: ['network'] });
    expect(tools).toHaveLength(5);
  });

  it('combines modules correctly', () => {
    const tools = browserTools(session, { modules: ['navigation', 'extraction'] });
    expect(tools).toHaveLength(14);
  });

  it('all tools have valid toJSON()', () => {
    const tools = browserTools(session);
    for (const t of tools) {
      const json = t.toJSON();
      expect(json).toHaveProperty('name');
      expect(json).toHaveProperty('description');
      expect(json).toHaveProperty('parameters');
      expect(typeof json.name).toBe('string');
      expect(typeof json.description).toBe('string');
    }
  });

  it('all tools have category web', () => {
    const tools = browserTools(session);
    for (const t of tools) {
      expect(t.category).toBe('web');
    }
  });

  it('returns 0 tools for empty modules array', () => {
    const tools = browserTools(session, { modules: [] });
    expect(tools).toHaveLength(0);
  });
});
