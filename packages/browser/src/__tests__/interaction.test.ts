import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserSession } from '../session';
import {
  createClickTool,
  createTypeTool,
  createSelectOptionTool,
  createHoverTool,
  createScrollTool,
  createPressKeyTool,
  createDragAndDropTool,
  createFillFormTool,
  createUploadFileTool,
  createInteractionTools,
} from '../tools/interaction';

function createMockSession(stealthEnabled = false) {
  const mockLocatorFirst = {
    isVisible: vi.fn().mockResolvedValue(true),
    fill: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockResolvedValue(undefined),
    uncheck: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
  };

  const mockLocator = {
    evaluate: vi.fn().mockResolvedValue(undefined),
    first: vi.fn().mockReturnValue(mockLocatorFirst),
    count: vi.fn().mockResolvedValue(1),
  };

  const mockPage = {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(['option1']),
    hover: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockResolvedValue(undefined),
    uncheck: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    dragAndDrop: vi.fn().mockResolvedValue(undefined),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue(mockLocator),
  };

  const session = {
    page: mockPage,
    stealthEnabled,
    stealthConfig: stealthEnabled ? { humanLikeTyping: true } : null,
  } as unknown as BrowserSession;

  return { session, mockPage, mockLocator, mockLocatorFirst };
}

const dummyContext = {
  agentId: 'test',
  runId: 'test-run',
  signal: new AbortController().signal,
};

describe('interaction tools', () => {
  let session: BrowserSession;
  let mockPage: ReturnType<typeof createMockSession>['mockPage'];
  let mockLocator: ReturnType<typeof createMockSession>['mockLocator'];
  let mockLocatorFirst: ReturnType<typeof createMockSession>['mockLocatorFirst'];

  beforeEach(() => {
    const mock = createMockSession();
    session = mock.session;
    mockPage = mock.mockPage;
    mockLocator = mock.mockLocator;
    mockLocatorFirst = mock.mockLocatorFirst;
  });

  describe('createClickTool', () => {
    it('has correct shape', () => {
      const t = createClickTool(session);

      expect(t.name).toBe('browser_click');
      expect(t.description).toBeTruthy();
      expect(t.category).toBe('web');
      expect(t.tags).toContain('browser');
      expect(t.tags).toContain('interaction');
      expect(typeof t.execute).toBe('function');
      expect(typeof t.toJSON).toBe('function');
    });

    it('serializes to JSON schema', () => {
      const t = createClickTool(session);
      const json = t.toJSON();

      expect(json.name).toBe('browser_click');
      expect(json.parameters.type).toBe('object');
      expect(json.parameters.properties).toHaveProperty('selector');
    });

    it('clicks element with defaults', async () => {
      const t = createClickTool(session);
      const result = await t.execute({ selector: '#btn' }, dummyContext);

      expect(mockPage.click).toHaveBeenCalledWith('#btn', {
        button: undefined,
        clickCount: undefined,
        position: undefined,
      });
      expect(result).toEqual({ clicked: true });
    });

    it('passes button, clickCount, position', async () => {
      const t = createClickTool(session);
      await t.execute(
        { selector: '.link', button: 'right', clickCount: 2, position: { x: 10, y: 20 } },
        dummyContext
      );

      expect(mockPage.click).toHaveBeenCalledWith('.link', {
        button: 'right',
        clickCount: 2,
        position: { x: 10, y: 20 },
      });
    });
  });

  describe('createTypeTool', () => {
    it('has correct shape', () => {
      const t = createTypeTool(session);

      expect(t.name).toBe('browser_type');
      expect(t.category).toBe('web');
      expect(t.tags).toContain('interaction');
    });

    it('fills text without delay', async () => {
      const t = createTypeTool(session);
      const result = await t.execute({ selector: '#input', text: 'hello' }, dummyContext);

      expect(mockPage.fill).toHaveBeenCalledWith('#input', 'hello');
      expect(mockPage.type).not.toHaveBeenCalled();
      expect(result).toEqual({ typed: true });
    });

    it('clears field first when clearFirst is true', async () => {
      const t = createTypeTool(session);
      await t.execute({ selector: '#input', text: 'new', clearFirst: true }, dummyContext);

      expect(mockPage.fill).toHaveBeenCalledWith('#input', '');
      expect(mockPage.fill).toHaveBeenCalledWith('#input', 'new');
    });

    it('types with delay instead of fill', async () => {
      const t = createTypeTool(session);
      await t.execute({ selector: '#input', text: 'slow', delay: 100 }, dummyContext);

      expect(mockPage.type).toHaveBeenCalledWith('#input', 'slow', { delay: 100 });
      expect(mockPage.fill).not.toHaveBeenCalledWith('#input', 'slow');
    });

    it('uses random delay in stealth mode without explicit delay', async () => {
      const stealthMock = createMockSession(true);
      const t = createTypeTool(stealthMock.session);
      await t.execute({ selector: '#input', text: 'stealth' }, dummyContext);

      expect(stealthMock.mockPage.type).toHaveBeenCalledWith(
        '#input',
        'stealth',
        expect.objectContaining({ delay: expect.any(Number) })
      );
      const delay = stealthMock.mockPage.type.mock.calls[0][2].delay;
      expect(delay).toBeGreaterThanOrEqual(50);
      expect(delay).toBeLessThanOrEqual(150);
    });
  });

  describe('createSelectOptionTool', () => {
    it('has correct shape', () => {
      const t = createSelectOptionTool(session);

      expect(t.name).toBe('browser_select_option');
      expect(t.category).toBe('web');
      expect(t.tags).toContain('interaction');
    });

    it('selects by value', async () => {
      const t = createSelectOptionTool(session);
      const result = await t.execute({ selector: '#dropdown', value: 'opt1' }, dummyContext);

      expect(mockPage.selectOption).toHaveBeenCalledWith('#dropdown', { value: 'opt1' });
      expect(result).toEqual({ selected: ['option1'] });
    });

    it('selects by label', async () => {
      const t = createSelectOptionTool(session);
      await t.execute({ selector: '#dropdown', label: 'Option One' }, dummyContext);

      expect(mockPage.selectOption).toHaveBeenCalledWith('#dropdown', { label: 'Option One' });
    });

    it('selects by index', async () => {
      const t = createSelectOptionTool(session);
      await t.execute({ selector: '#dropdown', index: 2 }, dummyContext);

      expect(mockPage.selectOption).toHaveBeenCalledWith('#dropdown', { index: 2 });
    });
  });

  describe('createHoverTool', () => {
    it('has correct shape', () => {
      const t = createHoverTool(session);

      expect(t.name).toBe('browser_hover');
      expect(t.category).toBe('web');
      expect(t.tags).toContain('interaction');
    });

    it('hovers element', async () => {
      const t = createHoverTool(session);
      const result = await t.execute({ selector: '.menu' }, dummyContext);

      expect(mockPage.hover).toHaveBeenCalledWith('.menu', { position: undefined });
      expect(result).toEqual({ hovered: true });
    });

    it('hovers with position', async () => {
      const t = createHoverTool(session);
      await t.execute({ selector: '.menu', position: { x: 5, y: 5 } }, dummyContext);

      expect(mockPage.hover).toHaveBeenCalledWith('.menu', { position: { x: 5, y: 5 } });
    });
  });

  describe('createScrollTool', () => {
    it('has correct shape', () => {
      const t = createScrollTool(session);

      expect(t.name).toBe('browser_scroll');
      expect(t.category).toBe('web');
      expect(t.tags).toContain('interaction');
    });

    it('scrolls down on page', async () => {
      const t = createScrollTool(session);
      const result = await t.execute({ direction: 'down' }, dummyContext);

      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function), { x: 0, y: 500 });
      expect(result).toEqual({ scrolled: true });
    });

    it('scrolls up on page', async () => {
      const t = createScrollTool(session);
      await t.execute({ direction: 'up' }, dummyContext);

      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function), { x: 0, y: -500 });
    });

    it('scrolls left on page', async () => {
      const t = createScrollTool(session);
      await t.execute({ direction: 'left' }, dummyContext);

      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function), { x: -500, y: 0 });
    });

    it('scrolls right on page', async () => {
      const t = createScrollTool(session);
      await t.execute({ direction: 'right' }, dummyContext);

      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function), { x: 500, y: 0 });
    });

    it('scrolls with custom amount', async () => {
      const t = createScrollTool(session);
      await t.execute({ direction: 'down', amount: 1000 }, dummyContext);

      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function), { x: 0, y: 1000 });
    });

    it('scrolls inside a specific element', async () => {
      const t = createScrollTool(session);
      await t.execute({ direction: 'down', selector: '.scroll-container' }, dummyContext);

      expect(mockPage.locator).toHaveBeenCalledWith('.scroll-container');
      expect(mockLocator.evaluate).toHaveBeenCalledWith(expect.any(Function), { x: 0, y: 500 });
      expect(mockPage.evaluate).not.toHaveBeenCalled();
    });
  });

  describe('createPressKeyTool', () => {
    it('has correct shape', () => {
      const t = createPressKeyTool(session);

      expect(t.name).toBe('browser_press_key');
      expect(t.category).toBe('web');
      expect(t.tags).toContain('interaction');
    });

    it('presses a single key', async () => {
      const t = createPressKeyTool(session);
      const result = await t.execute({ key: 'Enter' }, dummyContext);

      expect(mockPage.keyboard.press).toHaveBeenCalledWith('Enter');
      expect(result).toEqual({ pressed: true });
    });

    it('presses key with modifiers', async () => {
      const t = createPressKeyTool(session);
      await t.execute({ key: 'a', modifiers: ['Control', 'Shift'] }, dummyContext);

      expect(mockPage.keyboard.press).toHaveBeenCalledWith('Control+Shift+a');
    });

    it('presses key with empty modifiers array', async () => {
      const t = createPressKeyTool(session);
      await t.execute({ key: 'Tab', modifiers: [] }, dummyContext);

      expect(mockPage.keyboard.press).toHaveBeenCalledWith('Tab');
    });
  });

  describe('createDragAndDropTool', () => {
    it('has correct shape', () => {
      const t = createDragAndDropTool(session);

      expect(t.name).toBe('browser_drag_and_drop');
      expect(t.category).toBe('web');
      expect(t.tags).toContain('interaction');
    });

    it('drags from source to target', async () => {
      const t = createDragAndDropTool(session);
      const result = await t.execute({ source: '#drag', target: '#drop' }, dummyContext);

      expect(mockPage.dragAndDrop).toHaveBeenCalledWith('#drag', '#drop');
      expect(result).toEqual({ dropped: true });
    });
  });

  describe('createFillFormTool', () => {
    it('has correct shape', () => {
      const t = createFillFormTool(session);

      expect(t.name).toBe('browser_fill_form');
      expect(t.category).toBe('web');
      expect(t.tags).toContain('interaction');
    });

    it('fills string fields', async () => {
      mockLocator.count.mockResolvedValue(1);
      const t = createFillFormTool(session);
      const result = await t.execute({ fields: { username: 'john' } }, dummyContext);

      expect(mockPage.locator).toHaveBeenCalled();
      expect(mockLocatorFirst.fill).toHaveBeenCalledWith('john');
      expect(result).toEqual({ filled: ['username'] });
    });

    it('checks boolean true fields', async () => {
      mockLocator.count.mockResolvedValue(1);
      const t = createFillFormTool(session);
      const result = await t.execute({ fields: { agree: true } }, dummyContext);

      expect(mockLocatorFirst.check).toHaveBeenCalled();
      expect(result).toEqual({ filled: ['agree'] });
    });

    it('unchecks boolean false fields', async () => {
      mockLocator.count.mockResolvedValue(1);
      const t = createFillFormTool(session);
      const result = await t.execute({ fields: { newsletter: false } }, dummyContext);

      expect(mockLocatorFirst.uncheck).toHaveBeenCalled();
      expect(result).toEqual({ filled: ['newsletter'] });
    });

    it('selects option for array fields', async () => {
      mockLocator.count.mockResolvedValue(1);
      const t = createFillFormTool(session);
      const result = await t.execute({ fields: { colors: ['red', 'blue'] } }, dummyContext);

      expect(mockLocatorFirst.selectOption).toHaveBeenCalledWith(['red', 'blue']);
      expect(result).toEqual({ filled: ['colors'] });
    });

    it('tries multiple selectors to find input', async () => {
      mockLocator.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1);

      const t = createFillFormTool(session);
      const result = await t.execute({ fields: { email: 'test@test.com' } }, dummyContext);

      expect(mockPage.locator).toHaveBeenCalledTimes(6);
      expect(result).toEqual({ filled: ['email'] });
    });

    it('skips fields where no selector matches', async () => {
      mockLocator.count.mockResolvedValue(0);
      const t = createFillFormTool(session);
      const result = await t.execute({ fields: { missing: 'value' } }, dummyContext);

      expect(result).toEqual({ filled: [] });
    });

    it('fills multiple fields', async () => {
      mockLocator.count.mockResolvedValue(1);
      const t = createFillFormTool(session);
      const result = await t.execute(
        { fields: { name: 'John', agree: true, tags: ['a', 'b'] } },
        dummyContext
      );

      expect(result.filled).toHaveLength(3);
      expect(result.filled).toContain('name');
      expect(result.filled).toContain('agree');
      expect(result.filled).toContain('tags');
    });

    it('uses type instead of fill in stealth mode', async () => {
      const stealthMock = createMockSession(true);
      const stealthLocator = stealthMock.mockPage.locator();
      stealthLocator.count.mockResolvedValue(1);
      stealthMock.mockPage.locator.mockReturnValue(stealthLocator);

      const t = createFillFormTool(stealthMock.session);
      await t.execute({ fields: { username: 'john' } }, dummyContext);

      expect(stealthLocator.first().type).toHaveBeenCalledWith(
        'john',
        expect.objectContaining({ delay: expect.any(Number) })
      );
    });
  });

  describe('createUploadFileTool', () => {
    it('has correct shape', () => {
      const t = createUploadFileTool(session);

      expect(t.name).toBe('browser_upload_file');
      expect(t.category).toBe('web');
      expect(t.tags).toContain('interaction');
    });

    it('uploads files', async () => {
      const t = createUploadFileTool(session);
      const result = await t.execute(
        { selector: '#file', filePaths: ['/tmp/doc.pdf'] },
        dummyContext
      );

      expect(mockPage.setInputFiles).toHaveBeenCalledWith('#file', ['/tmp/doc.pdf']);
      expect(result).toEqual({ uploaded: true });
    });

    it('uploads multiple files', async () => {
      const t = createUploadFileTool(session);
      await t.execute({ selector: '#file', filePaths: ['/tmp/a.pdf', '/tmp/b.png'] }, dummyContext);

      expect(mockPage.setInputFiles).toHaveBeenCalledWith('#file', ['/tmp/a.pdf', '/tmp/b.png']);
    });
  });

  describe('createInteractionTools', () => {
    it('returns all 9 tools', () => {
      const tools = createInteractionTools(session);
      expect(tools).toHaveLength(9);
    });

    it('all tools have unique names', () => {
      const tools = createInteractionTools(session);
      const names = tools.map((t) => t.name);
      expect(new Set(names).size).toBe(9);
    });

    it('all tools have web category', () => {
      const tools = createInteractionTools(session);
      for (const t of tools) {
        expect(t.category).toBe('web');
      }
    });

    it('all tools have interaction tag', () => {
      const tools = createInteractionTools(session);
      for (const t of tools) {
        expect(t.tags).toContain('interaction');
      }
    });

    it('all tools serialize to JSON', () => {
      const tools = createInteractionTools(session);
      for (const t of tools) {
        const json = t.toJSON();
        expect(json.name).toBe(t.name);
        expect(json.parameters.type).toBe('object');
      }
    });
  });
});
