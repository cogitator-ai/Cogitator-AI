import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserSession } from '../session';
import {
  createScreenshotTool,
  createScreenshotElementTool,
  createFindByDescriptionTool,
  createClickByDescriptionTool,
  createVisionTools,
} from '../tools/vision';

const DEFAULT_ARIA = [
  '- document:',
  '  - button "Submit"',
  '  - link "Home"',
  '  - heading "Welcome" [level=1]',
].join('\n');

function createMockSession(ariaSnapshot: string | null = DEFAULT_ARIA) {
  const defaultLocator = {
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-element-data')),
    boundingBox: vi.fn().mockResolvedValue({ x: 10, y: 20, width: 100, height: 50 }),
    count: vi.fn().mockResolvedValue(1),
    nth: vi.fn().mockReturnValue({
      click: vi.fn().mockResolvedValue(undefined),
    }),
    ariaSnapshot: vi.fn().mockResolvedValue(ariaSnapshot),
    first: vi.fn(),
  };
  defaultLocator.first.mockReturnValue(defaultLocator);

  const mockPage = {
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png-data')),
    viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    locator: vi.fn().mockReturnValue(defaultLocator),
    getByRole: vi.fn().mockReturnValue({
      count: vi.fn().mockResolvedValue(1),
      nth: vi.fn().mockReturnValue({
        click: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    getByText: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
    getByLabel: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
    getByPlaceholder: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
  };
  return { session: { page: mockPage } as unknown as BrowserSession, mockPage, defaultLocator };
}

const dummyContext = {
  agentId: 'test',
  runId: 'test-run',
  signal: new AbortController().signal,
};

describe('vision tools', () => {
  let session: BrowserSession;
  let mockPage: ReturnType<typeof createMockSession>['mockPage'];

  beforeEach(() => {
    const mock = createMockSession();
    session = mock.session;
    mockPage = mock.mockPage;
  });

  describe('createScreenshotTool', () => {
    it('has correct shape', () => {
      const t = createScreenshotTool(session);

      expect(t.name).toBe('browser_screenshot');
      expect(t.description).toBeTruthy();
      expect(t.category).toBe('web');
      expect(t.tags).toContain('browser');
      expect(t.tags).toContain('vision');
      expect(typeof t.execute).toBe('function');
      expect(typeof t.toJSON).toBe('function');
    });

    it('takes basic screenshot', async () => {
      const t = createScreenshotTool(session);
      const result = await t.execute({}, dummyContext);

      expect(mockPage.screenshot).toHaveBeenCalledWith({ type: 'png' });
      expect(result).toEqual({
        image: Buffer.from('fake-png-data').toString('base64'),
        mimeType: 'image/png',
        width: 1280,
        height: 720,
      });
    });

    it('reports jpeg mime type and does not pass fullPage to element screenshots', async () => {
      const mock = createMockSession();
      const t = createScreenshotTool(mock.session);
      const result = await t.execute(
        { selector: '#hero', fullPage: true, quality: 50 },
        dummyContext
      );

      expect(mock.defaultLocator.first).toHaveBeenCalled();
      expect(mock.defaultLocator.screenshot).toHaveBeenCalledWith({ type: 'jpeg', quality: 50 });
      expect(result.mimeType).toBe('image/jpeg');
    });

    it('reads real PNG dimensions from the image header', async () => {
      const png = Buffer.alloc(24);
      png.writeUInt32BE(0x89504e47, 0);
      png.writeUInt32BE(640, 16);
      png.writeUInt32BE(480, 20);
      mockPage.screenshot.mockResolvedValueOnce(png);

      const result = await createScreenshotTool(session).execute({ fullPage: true }, dummyContext);
      expect(result.width).toBe(640);
      expect(result.height).toBe(480);
    });

    it('takes full page screenshot', async () => {
      const t = createScreenshotTool(session);
      await t.execute({ fullPage: true }, dummyContext);

      expect(mockPage.screenshot).toHaveBeenCalledWith({ type: 'png', fullPage: true });
    });

    it('takes jpeg screenshot with quality', async () => {
      const t = createScreenshotTool(session);
      await t.execute({ quality: 80 }, dummyContext);

      expect(mockPage.screenshot).toHaveBeenCalledWith({ type: 'jpeg', quality: 80 });
    });

    it('screenshots specific element by selector', async () => {
      const t = createScreenshotTool(session);
      const result = await t.execute({ selector: '#hero' }, dummyContext);

      expect(mockPage.locator).toHaveBeenCalledWith('#hero');
      expect(result).toEqual({
        image: Buffer.from('fake-element-data').toString('base64'),
        mimeType: 'image/png',
        width: 100,
        height: 50,
      });
    });

    it('quality=0 produces jpeg format', async () => {
      const t = createScreenshotTool(session);
      await t.execute({ quality: 0 }, dummyContext);

      expect(mockPage.screenshot).toHaveBeenCalledWith({ type: 'jpeg', quality: 0 });
    });
  });

  describe('createScreenshotElementTool', () => {
    it('has correct shape', () => {
      const t = createScreenshotElementTool(session);

      expect(t.name).toBe('browser_screenshot_element');
      expect(t.category).toBe('web');
      expect(t.tags).toContain('vision');
    });

    it('returns base64 image and bounding box', async () => {
      const t = createScreenshotElementTool(session);
      const result = await t.execute({ selector: '.card' }, dummyContext);

      expect(mockPage.locator).toHaveBeenCalledWith('.card');
      expect(result).toEqual({
        image: Buffer.from('fake-element-data').toString('base64'),
        boundingBox: { x: 10, y: 20, width: 100, height: 50 },
      });
    });

    it('returns null bounding box when element has no box', async () => {
      const hidden = {
        screenshot: vi.fn().mockResolvedValue(Buffer.from('data')),
        boundingBox: vi.fn().mockResolvedValue(null),
        first: vi.fn(),
      };
      hidden.first.mockReturnValue(hidden);
      mockPage.locator.mockReturnValueOnce(hidden);

      const t = createScreenshotElementTool(session);
      const result = await t.execute({ selector: '.hidden' }, dummyContext);

      expect(result.boundingBox).toBeNull();
    });
  });

  describe('createFindByDescriptionTool', () => {
    it('has correct shape', () => {
      const t = createFindByDescriptionTool(session);

      expect(t.name).toBe('browser_find_by_description');
      expect(t.category).toBe('web');
      expect(t.tags).toContain('vision');
    });

    it('finds matching elements from accessibility tree', async () => {
      const t = createFindByDescriptionTool(session);
      const result = await t.execute({ description: 'submit' }, dummyContext);

      expect(result.elements).toHaveLength(1);
      expect(result.elements[0]).toEqual({
        role: 'button',
        name: 'Submit',
        description: 'button: "Submit"',
      });
    });

    it('finds inline-text nodes and YAML-quoted names from real snapshots', async () => {
      const aria = [
        '- document:',
        '  - paragraph: Shipping is free over $50',
        `  - 'button "Checkout: 2 items"'`,
      ].join('\n');
      const mock = createMockSession(aria);
      const t = createFindByDescriptionTool(mock.session);

      const shipping = await t.execute({ description: 'shipping is free' }, dummyContext);
      expect(shipping.elements).toEqual([
        {
          role: 'paragraph',
          name: 'Shipping is free over $50',
          description: 'paragraph: "Shipping is free over $50"',
        },
      ]);

      const checkout = await t.execute({ description: 'checkout' }, dummyContext);
      expect(checkout.elements[0]).toMatchObject({ role: 'button', name: 'Checkout: 2 items' });
    });

    it('matches by role', async () => {
      const t = createFindByDescriptionTool(session);
      const result = await t.execute({ description: 'button' }, dummyContext);

      expect(result.elements).toHaveLength(1);
      expect(result.elements[0].name).toBe('Submit');
    });

    it('returns empty array when no matches', async () => {
      const t = createFindByDescriptionTool(session);
      const result = await t.execute({ description: 'nonexistent' }, dummyContext);

      expect(result.elements).toEqual([]);
    });

    it('returns empty array when accessibility tree is null', async () => {
      const { session: s } = createMockSession(null);

      const t = createFindByDescriptionTool(s);
      const result = await t.execute({ description: 'anything' }, dummyContext);

      expect(result.elements).toEqual([]);
    });

    it('filters out nodes with name shorter than 2 characters', async () => {
      const aria = ['- document:', '  - button "X"', '  - button "OK"', '  - button "Submit"'].join(
        '\n'
      );
      const { session: s } = createMockSession(aria);

      const t = createFindByDescriptionTool(s);
      const result = await t.execute({ description: 'button' }, dummyContext);

      const names = result.elements.map((e: { name: string }) => e.name);
      expect(names).not.toContain('X');
      expect(names).toContain('OK');
      expect(names).toContain('Submit');
    });
  });

  describe('createClickByDescriptionTool', () => {
    it('has correct shape', () => {
      const t = createClickByDescriptionTool(session);

      expect(t.name).toBe('browser_click_by_description');
      expect(t.category).toBe('web');
      expect(t.tags).toContain('vision');
    });

    it('clicks first matching element', async () => {
      const t = createClickByDescriptionTool(session);
      const result = await t.execute({ description: 'Submit' }, dummyContext);

      expect(mockPage.getByRole).toHaveBeenCalledWith('button', { name: 'Submit' });
      expect(result).toEqual({
        clicked: true,
        element: { description: 'Submit', index: 0 },
      });
    });

    it('respects index parameter', async () => {
      mockPage.getByRole.mockReturnValue({
        count: vi.fn().mockResolvedValue(3),
        nth: vi.fn().mockReturnValue({
          click: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const t = createClickByDescriptionTool(session);
      const result = await t.execute({ description: 'Submit', index: 2 }, dummyContext);

      expect(result).toEqual({
        clicked: true,
        element: { description: 'Submit', index: 2 },
      });
    });

    it('returns false when no element found', async () => {
      mockPage.getByRole.mockReturnValue({ count: vi.fn().mockResolvedValue(0) });
      mockPage.getByText.mockReturnValue({ count: vi.fn().mockResolvedValue(0) });
      mockPage.getByLabel.mockReturnValue({ count: vi.fn().mockResolvedValue(0) });
      mockPage.getByPlaceholder.mockReturnValue({ count: vi.fn().mockResolvedValue(0) });

      const t = createClickByDescriptionTool(session);
      const result = await t.execute({ description: 'Nonexistent' }, dummyContext);

      expect(result).toEqual({ clicked: false, element: null });
    });

    it('falls through to getByText when role does not match', async () => {
      mockPage.getByRole.mockReturnValue({ count: vi.fn().mockResolvedValue(0) });
      const mockNth = vi.fn().mockReturnValue({ click: vi.fn().mockResolvedValue(undefined) });
      mockPage.getByText.mockReturnValue({
        count: vi.fn().mockResolvedValue(1),
        nth: mockNth,
      });

      const t = createClickByDescriptionTool(session);
      const result = await t.execute({ description: 'Some text' }, dummyContext);

      expect(mockPage.getByText).toHaveBeenCalledWith('Some text', { exact: false });
      expect(result.clicked).toBe(true);
    });
  });

  describe('createVisionTools', () => {
    it('returns all 4 tools', () => {
      const tools = createVisionTools(session);
      expect(tools).toHaveLength(4);
    });

    it('all tools have unique names', () => {
      const tools = createVisionTools(session);
      const names = tools.map((t) => t.name);
      expect(new Set(names).size).toBe(4);
    });

    it('all tools have web category', () => {
      const tools = createVisionTools(session);
      for (const t of tools) {
        expect(t.category).toBe('web');
      }
    });

    it('all tools serialize to JSON', () => {
      const tools = createVisionTools(session);
      for (const t of tools) {
        const json = t.toJSON();
        expect(json.name).toBe(t.name);
        expect(json.parameters.type).toBe('object');
      }
    });
  });
});
