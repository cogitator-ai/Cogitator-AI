import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserSession } from '../session';
import {
  createScreenshotTool,
  createScreenshotElementTool,
  createFindByDescriptionTool,
  createClickByDescriptionTool,
  createVisionTools,
} from '../tools/vision';

function createMockSession() {
  const mockPage = {
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png-data')),
    viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    locator: vi.fn().mockReturnValue({
      screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-element-data')),
      boundingBox: vi.fn().mockResolvedValue({ x: 10, y: 20, width: 100, height: 50 }),
      count: vi.fn().mockResolvedValue(1),
      nth: vi.fn().mockReturnValue({
        click: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    accessibility: {
      snapshot: vi.fn().mockResolvedValue({
        role: 'WebArea',
        name: '',
        children: [
          { role: 'button', name: 'Submit' },
          { role: 'link', name: 'Home' },
          { role: 'heading', name: 'Welcome' },
        ],
      }),
    },
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
  return { session: { page: mockPage } as unknown as BrowserSession, mockPage };
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
        width: 1280,
        height: 720,
      });
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
        width: 1280,
        height: 720,
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
      mockPage.locator.mockReturnValueOnce({
        screenshot: vi.fn().mockResolvedValue(Buffer.from('data')),
        boundingBox: vi.fn().mockResolvedValue(null),
      });

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
      mockPage.accessibility.snapshot.mockResolvedValueOnce(null);

      const t = createFindByDescriptionTool(session);
      const result = await t.execute({ description: 'anything' }, dummyContext);

      expect(result.elements).toEqual([]);
    });

    it('filters out nodes with name shorter than 2 characters', async () => {
      mockPage.accessibility.snapshot.mockResolvedValueOnce({
        role: 'WebArea',
        name: '',
        children: [
          { role: 'button', name: 'X' },
          { role: 'button', name: 'OK' },
          { role: 'button', name: 'Submit' },
        ],
      });

      const t = createFindByDescriptionTool(session);
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
