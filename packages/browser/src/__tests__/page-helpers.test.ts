import { describe, it, expect, vi } from 'vitest';
import { getReadableText, getAccessibilityTree, elementToInfo } from '../utils/page-helpers';

function createMockPage(evaluateResult: unknown = '') {
  return {
    evaluate: vi.fn().mockResolvedValue(evaluateResult),
    accessibility: {
      snapshot: vi.fn().mockResolvedValue(null),
    },
  };
}

describe('getReadableText', () => {
  it('returns text from page.evaluate', async () => {
    const page = createMockPage('Hello World');
    const result = await getReadableText(page as never);

    expect(result).toBe('Hello World');
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), undefined);
  });

  it('passes selector to evaluate', async () => {
    const page = createMockPage('Section text');
    const result = await getReadableText(page as never, '#content');

    expect(result).toBe('Section text');
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), '#content');
  });

  it('returns empty string when evaluate returns empty', async () => {
    const page = createMockPage('');
    const result = await getReadableText(page as never);

    expect(result).toBe('');
  });

  it('evaluate function strips scripts and styles', async () => {
    const page = createMockPage();

    await getReadableText(page as never);

    const evalFn = page.evaluate.mock.calls[0][0] as (sel?: string) => string;

    const doc = {
      body: {
        cloneNode: vi.fn().mockReturnValue({
          querySelectorAll: vi.fn().mockReturnValue([{ remove: vi.fn() }, { remove: vi.fn() }]),
          innerText: '  Clean text  ',
        }),
      },
      querySelector: vi.fn(),
    };

    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      value: doc,
      writable: true,
      configurable: true,
    });

    try {
      const result = evalFn();
      expect(result).toBe('Clean text');
      expect(doc.body.cloneNode).toHaveBeenCalledWith(true);
    } finally {
      Object.defineProperty(globalThis, 'document', {
        value: originalDocument,
        writable: true,
        configurable: true,
      });
    }
  });

  it('evaluate function uses selector scope when provided', async () => {
    const page = createMockPage();

    await getReadableText(page as never, '.article');

    const evalFn = page.evaluate.mock.calls[0][0] as (sel?: string) => string;

    const scopeEl = {
      cloneNode: vi.fn().mockReturnValue({
        querySelectorAll: vi.fn().mockReturnValue([]),
        innerText: 'Scoped content',
      }),
    };

    const doc = {
      body: { cloneNode: vi.fn() },
      querySelector: vi.fn().mockReturnValue(scopeEl),
    };

    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      value: doc,
      writable: true,
      configurable: true,
    });

    try {
      const result = evalFn('.article');
      expect(doc.querySelector).toHaveBeenCalledWith('.article');
      expect(result).toBe('Scoped content');
    } finally {
      Object.defineProperty(globalThis, 'document', {
        value: originalDocument,
        writable: true,
        configurable: true,
      });
    }
  });

  it('evaluate function returns empty for missing scope', async () => {
    const page = createMockPage();

    await getReadableText(page as never, '.missing');

    const evalFn = page.evaluate.mock.calls[0][0] as (sel?: string) => string;

    const doc = {
      body: { cloneNode: vi.fn() },
      querySelector: vi.fn().mockReturnValue(null),
    };

    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      value: doc,
      writable: true,
      configurable: true,
    });

    try {
      const result = evalFn('.missing');
      expect(result).toBe('');
    } finally {
      Object.defineProperty(globalThis, 'document', {
        value: originalDocument,
        writable: true,
        configurable: true,
      });
    }
  });

  it('evaluate function falls back to textContent when innerText is undefined', async () => {
    const page = createMockPage();

    await getReadableText(page as never);

    const evalFn = page.evaluate.mock.calls[0][0] as (sel?: string) => string;

    const doc = {
      body: {
        cloneNode: vi.fn().mockReturnValue({
          querySelectorAll: vi.fn().mockReturnValue([]),
          innerText: undefined,
          textContent: '  Fallback text  ',
        }),
      },
      querySelector: vi.fn(),
    };

    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      value: doc,
      writable: true,
      configurable: true,
    });

    try {
      const result = evalFn();
      expect(result).toBe('Fallback text');
    } finally {
      Object.defineProperty(globalThis, 'document', {
        value: originalDocument,
        writable: true,
        configurable: true,
      });
    }
  });
});

describe('getAccessibilityTree', () => {
  it('returns null when snapshot is null', async () => {
    const page = createMockPage();
    page.accessibility.snapshot.mockResolvedValue(null);

    const result = await getAccessibilityTree(page as never);

    expect(result).toBeNull();
  });

  it('simplifies flat snapshot', async () => {
    const page = createMockPage();
    page.accessibility.snapshot.mockResolvedValue({
      role: 'WebArea',
      name: 'Test Page',
    });

    const result = await getAccessibilityTree(page as never);

    expect(result).toEqual({
      role: 'WebArea',
      name: 'Test Page',
    });
  });

  it('simplifies nested snapshot with children', async () => {
    const page = createMockPage();
    page.accessibility.snapshot.mockResolvedValue({
      role: 'WebArea',
      name: 'Page',
      children: [
        {
          role: 'heading',
          name: 'Title',
          level: 1,
          children: [],
        },
        {
          role: 'button',
          name: 'Submit',
          disabled: false,
        },
      ],
    });

    const result = await getAccessibilityTree(page as never);

    expect(result).toEqual({
      role: 'WebArea',
      name: 'Page',
      children: [
        { role: 'heading', name: 'Title' },
        { role: 'button', name: 'Submit' },
      ],
    });
  });

  it('handles deeply nested tree', async () => {
    const page = createMockPage();
    page.accessibility.snapshot.mockResolvedValue({
      role: 'WebArea',
      name: '',
      children: [
        {
          role: 'navigation',
          name: 'Main',
          children: [
            {
              role: 'list',
              name: '',
              children: [
                { role: 'listitem', name: 'Home' },
                { role: 'listitem', name: 'About' },
              ],
            },
          ],
        },
      ],
    });

    const result = await getAccessibilityTree(page as never);

    expect(result!.children![0].children![0].children).toHaveLength(2);
    expect(result!.children![0].children![0].children![0]).toEqual({
      role: 'listitem',
      name: 'Home',
    });
  });

  it('strips extra properties from snapshot nodes', async () => {
    const page = createMockPage();
    page.accessibility.snapshot.mockResolvedValue({
      role: 'textbox',
      name: 'Email',
      value: 'test@test.com',
      focused: true,
      description: 'Enter your email',
    });

    const result = await getAccessibilityTree(page as never);

    expect(result).toEqual({
      role: 'textbox',
      name: 'Email',
    });
    expect(result).not.toHaveProperty('value');
    expect(result).not.toHaveProperty('focused');
  });

  it('handles missing role and name gracefully', async () => {
    const page = createMockPage();
    page.accessibility.snapshot.mockResolvedValue({});

    const result = await getAccessibilityTree(page as never);

    expect(result).toEqual({ role: '', name: '' });
  });
});

describe('elementToInfo', () => {
  function createMockHandle(info: Record<string, unknown>) {
    return {
      evaluate: vi.fn().mockResolvedValue(info),
    };
  }

  it('maps all fields correctly', async () => {
    const handle = createMockHandle({
      tag: 'button',
      text: 'Click me',
      attributes: { id: 'btn', class: 'primary' },
      boundingBox: { x: 10, y: 20, width: 100, height: 40 },
      visible: true,
    });

    const result = await elementToInfo(handle as never);

    expect(result).toEqual({
      tag: 'button',
      text: 'Click me',
      attributes: { id: 'btn', class: 'primary' },
      boundingBox: { x: 10, y: 20, width: 100, height: 40 },
      visible: true,
    });
  });

  it('handles invisible elements with no bounding box', async () => {
    const handle = createMockHandle({
      tag: 'div',
      text: '',
      attributes: { style: 'display:none' },
      boundingBox: undefined,
      visible: false,
    });

    const result = await elementToInfo(handle as never);

    expect(result.visible).toBe(false);
    expect(result.boundingBox).toBeUndefined();
  });

  it('handles elements with empty attributes', async () => {
    const handle = createMockHandle({
      tag: 'span',
      text: 'Plain text',
      attributes: {},
      visible: true,
    });

    const result = await elementToInfo(handle as never);

    expect(result.attributes).toEqual({});
    expect(result.tag).toBe('span');
  });

  it('truncates long text to 200 chars in evaluate', async () => {
    const handle = createMockHandle({
      tag: 'p',
      text: 'A'.repeat(200),
      attributes: {},
      visible: true,
    });

    const result = await elementToInfo(handle as never);

    expect(result.text).toHaveLength(200);
  });

  it('passes evaluate function to handle', async () => {
    const handle = createMockHandle({
      tag: 'a',
      text: 'Link',
      attributes: { href: '/page' },
      visible: true,
    });

    await elementToInfo(handle as never);

    expect(handle.evaluate).toHaveBeenCalledWith(expect.any(Function));
  });

  it('returns no boundingBox when width>0 but height=0', async () => {
    const handle = createMockHandle({
      tag: 'hr',
      text: '',
      attributes: {},
      boundingBox: undefined,
      visible: false,
    });

    const result = await elementToInfo(handle as never);

    expect(result.boundingBox).toBeUndefined();
    expect(result.visible).toBe(false);
  });
});
