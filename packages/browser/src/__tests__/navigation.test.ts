import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserSession } from '../session';
import {
  createNavigateTool,
  createGoBackTool,
  createGoForwardTool,
  createReloadTool,
  createWaitForNavigationTool,
  createGetCurrentUrlTool,
  createWaitForSelectorTool,
  createNavigationTools,
} from '../tools/navigation';

function createMockSession() {
  let currentUrl = 'https://example.com';
  let currentTitle = 'Example';

  const mockPage = {
    goto: vi.fn().mockImplementation(async (url: string) => {
      currentUrl = url;
      currentTitle = 'New Page';
      return { status: () => 200 };
    }),
    goBack: vi.fn().mockImplementation(async () => {
      currentUrl = 'https://previous.com';
      currentTitle = 'Previous';
      return null;
    }),
    goForward: vi.fn().mockImplementation(async () => {
      currentUrl = 'https://next.com';
      currentTitle = 'Next';
      return null;
    }),
    reload: vi.fn().mockImplementation(async () => {
      currentTitle = 'Reloaded';
      return null;
    }),
    url: vi.fn().mockImplementation(() => currentUrl),
    title: vi.fn().mockImplementation(async () => currentTitle),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue({ isVisible: () => true }),
  };

  const session = { page: mockPage } as unknown as BrowserSession;
  return { session, mockPage };
}

const dummyContext = {
  agentId: 'test',
  runId: 'test-run',
  signal: new AbortController().signal,
};

describe('navigation tools', () => {
  let session: BrowserSession;
  let mockPage: ReturnType<typeof createMockSession>['mockPage'];

  beforeEach(() => {
    const mock = createMockSession();
    session = mock.session;
    mockPage = mock.mockPage;
  });

  describe('createNavigateTool', () => {
    it('has correct shape', () => {
      const t = createNavigateTool(session);

      expect(t.name).toBe('browser_navigate');
      expect(t.description).toBeTruthy();
      expect(t.category).toBe('web');
      expect(t.tags).toContain('browser');
      expect(t.tags).toContain('navigation');
      expect(typeof t.execute).toBe('function');
      expect(typeof t.toJSON).toBe('function');
    });

    it('serializes to JSON schema', () => {
      const t = createNavigateTool(session);
      const json = t.toJSON();

      expect(json.name).toBe('browser_navigate');
      expect(json.parameters.type).toBe('object');
      expect(json.parameters.properties).toHaveProperty('url');
    });

    it('navigates to url with default waitUntil', async () => {
      const t = createNavigateTool(session);
      const result = await t.execute({ url: 'https://test.com' }, dummyContext);

      expect(mockPage.goto).toHaveBeenCalledWith('https://test.com', { waitUntil: 'load' });
      expect(result).toEqual({
        url: 'https://test.com',
        title: 'New Page',
        status: 200,
      });
    });

    it('passes custom waitUntil', async () => {
      const t = createNavigateTool(session);
      await t.execute({ url: 'https://test.com', waitUntil: 'networkidle' }, dummyContext);

      expect(mockPage.goto).toHaveBeenCalledWith('https://test.com', {
        waitUntil: 'networkidle',
      });
    });

    it('returns status 0 when response is null', async () => {
      mockPage.goto.mockResolvedValueOnce(null);
      const t = createNavigateTool(session);
      const result = await t.execute({ url: 'https://test.com' }, dummyContext);

      expect(result.status).toBe(0);
    });
  });

  describe('createGoBackTool', () => {
    it('has correct shape', () => {
      const t = createGoBackTool(session);

      expect(t.name).toBe('browser_go_back');
      expect(t.category).toBe('web');
      expect(typeof t.execute).toBe('function');
    });

    it('calls page.goBack and returns url/title', async () => {
      const t = createGoBackTool(session);
      const result = await t.execute({}, dummyContext);

      expect(mockPage.goBack).toHaveBeenCalled();
      expect(result).toEqual({
        url: 'https://previous.com',
        title: 'Previous',
      });
    });
  });

  describe('createGoForwardTool', () => {
    it('has correct shape', () => {
      const t = createGoForwardTool(session);

      expect(t.name).toBe('browser_go_forward');
      expect(t.category).toBe('web');
    });

    it('calls page.goForward and returns url/title', async () => {
      const t = createGoForwardTool(session);
      const result = await t.execute({}, dummyContext);

      expect(mockPage.goForward).toHaveBeenCalled();
      expect(result).toEqual({
        url: 'https://next.com',
        title: 'Next',
      });
    });
  });

  describe('createReloadTool', () => {
    it('has correct shape', () => {
      const t = createReloadTool(session);

      expect(t.name).toBe('browser_reload');
      expect(t.category).toBe('web');
    });

    it('reloads with default waitUntil', async () => {
      const t = createReloadTool(session);
      const result = await t.execute({}, dummyContext);

      expect(mockPage.reload).toHaveBeenCalledWith({ waitUntil: 'load' });
      expect(result).toEqual({
        url: 'https://example.com',
        title: 'Reloaded',
      });
    });

    it('passes custom waitUntil', async () => {
      const t = createReloadTool(session);
      await t.execute({ waitUntil: 'domcontentloaded' }, dummyContext);

      expect(mockPage.reload).toHaveBeenCalledWith({ waitUntil: 'domcontentloaded' });
    });
  });

  describe('createWaitForNavigationTool', () => {
    it('has correct shape', () => {
      const t = createWaitForNavigationTool(session);

      expect(t.name).toBe('browser_wait_for_navigation');
      expect(t.category).toBe('web');
    });

    it('waits for any url by default', async () => {
      const t = createWaitForNavigationTool(session);
      const result = await t.execute({}, dummyContext);

      expect(mockPage.waitForURL).toHaveBeenCalledWith('**', { timeout: undefined });
      expect(result).toEqual({
        url: 'https://example.com',
        title: 'Example',
      });
    });

    it('waits for specific url pattern with timeout', async () => {
      const t = createWaitForNavigationTool(session);
      await t.execute({ url: '**/dashboard', timeout: 5000 }, dummyContext);

      expect(mockPage.waitForURL).toHaveBeenCalledWith('**/dashboard', { timeout: 5000 });
    });
  });

  describe('createGetCurrentUrlTool', () => {
    it('has correct shape', () => {
      const t = createGetCurrentUrlTool(session);

      expect(t.name).toBe('browser_get_current_url');
      expect(t.category).toBe('web');
    });

    it('returns current url and title', async () => {
      const t = createGetCurrentUrlTool(session);
      const result = await t.execute({}, dummyContext);

      expect(result).toEqual({
        url: 'https://example.com',
        title: 'Example',
      });
    });
  });

  describe('createWaitForSelectorTool', () => {
    it('has correct shape', () => {
      const t = createWaitForSelectorTool(session);

      expect(t.name).toBe('browser_wait_for_selector');
      expect(t.category).toBe('web');
    });

    it('waits for selector with defaults', async () => {
      const t = createWaitForSelectorTool(session);
      const result = await t.execute({ selector: '.content' }, dummyContext);

      expect(mockPage.waitForSelector).toHaveBeenCalledWith('.content', {
        state: undefined,
        timeout: undefined,
      });
      expect(result).toEqual({ found: true });
    });

    it('passes state and timeout options', async () => {
      const t = createWaitForSelectorTool(session);
      await t.execute({ selector: '#modal', state: 'visible', timeout: 3000 }, dummyContext);

      expect(mockPage.waitForSelector).toHaveBeenCalledWith('#modal', {
        state: 'visible',
        timeout: 3000,
      });
    });

    it('returns found: false on timeout error', async () => {
      mockPage.waitForSelector.mockRejectedValueOnce(new Error('Timeout 30000ms exceeded'));
      const t = createWaitForSelectorTool(session);
      const result = await t.execute({ selector: '.missing' }, dummyContext);

      expect(result).toEqual({ found: false });
    });
  });

  describe('createNavigationTools', () => {
    it('returns all 7 tools', () => {
      const tools = createNavigationTools(session);
      expect(tools).toHaveLength(7);
    });

    it('all tools have unique names', () => {
      const tools = createNavigationTools(session);
      const names = tools.map((t) => t.name);
      expect(new Set(names).size).toBe(7);
    });

    it('all tools have web category', () => {
      const tools = createNavigationTools(session);
      for (const t of tools) {
        expect(t.category).toBe('web');
      }
    });

    it('all tools serialize to JSON', () => {
      const tools = createNavigationTools(session);
      for (const t of tools) {
        const json = t.toJSON();
        expect(json.name).toBe(t.name);
        expect(json.parameters.type).toBe('object');
      }
    });
  });
});
