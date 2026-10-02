import { describe, it, expect, vi } from 'vitest';
import { getReadableText, getAccessibilityTree, elementToInfo } from '../utils/page-helpers';

function createMockPage(evaluateResult: unknown = '', ariaResult: string | null = null) {
  return {
    evaluate: vi.fn().mockResolvedValue(evaluateResult),
    locator: vi.fn().mockReturnValue({
      ariaSnapshot: vi.fn().mockResolvedValue(ariaResult),
    }),
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

  class FakeHTMLElement {
    constructor(
      public innerText: string,
      public textContent: string | null = innerText
    ) {}
  }

  function withDom<T>(doc: unknown, run: () => T): T {
    const g = globalThis as Record<string, unknown>;
    const originalDocument = g.document;
    const originalHTMLElement = g.HTMLElement;
    g.document = doc;
    g.HTMLElement = FakeHTMLElement;
    try {
      return run();
    } finally {
      g.document = originalDocument;
      g.HTMLElement = originalHTMLElement;
    }
  }

  async function captureEvaluateFn(selector?: string) {
    const page = createMockPage();
    await getReadableText(page as never, selector);
    return page.evaluate.mock.calls[0][0] as (sel?: string) => string;
  }

  it('evaluate function reads rendered innerText of the live body without cloning', async () => {
    const evalFn = await captureEvaluateFn();
    const body = new FakeHTMLElement('  Visible text  ', 'Visible text plus script source');
    const doc = { body, querySelector: vi.fn() };

    const result = withDom(doc, () => evalFn());

    expect(result).toBe('Visible text');
    expect(doc.querySelector).not.toHaveBeenCalled();
  });

  it('evaluate function collapses runs of blank lines and trailing spaces', async () => {
    const evalFn = await captureEvaluateFn();
    const doc = {
      body: new FakeHTMLElement('Title  \n\n\n\nParagraph\t\nEnd'),
      querySelector: vi.fn(),
    };

    expect(withDom(doc, () => evalFn())).toBe('Title\n\nParagraph\nEnd');
  });

  it('evaluate function uses selector scope when provided', async () => {
    const evalFn = await captureEvaluateFn('.article');
    const doc = {
      body: new FakeHTMLElement('Whole page'),
      querySelector: vi.fn().mockReturnValue(new FakeHTMLElement('Scoped content')),
    };

    const result = withDom(doc, () => evalFn('.article'));

    expect(doc.querySelector).toHaveBeenCalledWith('.article');
    expect(result).toBe('Scoped content');
  });

  it('evaluate function returns empty for missing scope', async () => {
    const evalFn = await captureEvaluateFn('.missing');
    const doc = { body: new FakeHTMLElement('x'), querySelector: vi.fn().mockReturnValue(null) };

    expect(withDom(doc, () => evalFn('.missing'))).toBe('');
  });

  it('evaluate function falls back to textContent for non-HTML elements', async () => {
    const evalFn = await captureEvaluateFn('svg');
    const doc = {
      body: new FakeHTMLElement('x'),
      querySelector: vi.fn().mockReturnValue({ textContent: '  Svg label  ' }),
    };

    expect(withDom(doc, () => evalFn('svg'))).toBe('Svg label');
  });
});

describe('getAccessibilityTree', () => {
  it('returns null when ariaSnapshot is null', async () => {
    const page = createMockPage('', null);

    const result = await getAccessibilityTree(page as never);

    expect(result).toBeNull();
  });

  it('parses flat document snapshot', async () => {
    const aria = '- document:\n  - heading "Title" [level=1]';
    const page = createMockPage('', aria);

    const result = await getAccessibilityTree(page as never);

    expect(result).not.toBeNull();
    expect(result!.role).toBe('document');
    expect(result!.children).toHaveLength(1);
    expect(result!.children![0]).toEqual({ role: 'heading', name: 'Title' });
  });

  it('parses nested snapshot with children', async () => {
    const aria = ['- document:', '  - heading "Title" [level=1]', '  - button "Submit"'].join('\n');
    const page = createMockPage('', aria);

    const result = await getAccessibilityTree(page as never);

    expect(result!.children).toHaveLength(2);
    expect(result!.children![0]).toEqual({ role: 'heading', name: 'Title' });
    expect(result!.children![1]).toEqual({ role: 'button', name: 'Submit' });
  });

  it('handles deeply nested tree', async () => {
    const aria = [
      '- document:',
      '  - navigation "Main":',
      '    - list:',
      '      - listitem "Home"',
      '      - listitem "About"',
    ].join('\n');
    const page = createMockPage('', aria);

    const result = await getAccessibilityTree(page as never);

    const nav = result!.children![0];
    expect(nav.role).toBe('navigation');
    expect(nav.children![0].role).toBe('list');
    expect(nav.children![0].children).toHaveLength(2);
    expect(nav.children![0].children![0]).toEqual({ role: 'listitem', name: 'Home' });
  });

  it('only extracts role and name from snapshot lines', async () => {
    const aria = '- document:\n  - textbox "Email"';
    const page = createMockPage('', aria);

    const result = await getAccessibilityTree(page as never);

    const node = result!.children![0];
    expect(node).toEqual({ role: 'textbox', name: 'Email' });
    expect(node).not.toHaveProperty('value');
    expect(node).not.toHaveProperty('focused');
  });

  it('keeps inline text of nodes such as paragraphs and list items', async () => {
    const aria = [
      '- document:',
      '  - paragraph: Hello world para',
      '  - list:',
      '    - listitem: Item one',
      '    - listitem:',
      '      - text: plain text',
    ].join('\n');
    const result = await getAccessibilityTree(createMockPage('', aria) as never);

    expect(result!.children![0]).toEqual({ role: 'paragraph', name: 'Hello world para' });
    const list = result!.children![1];
    expect(list.children![0]).toEqual({ role: 'listitem', name: 'Item one' });
    expect(list.children![1].children![0]).toEqual({ role: 'text', name: 'plain text' });
  });

  it('parses YAML-quoted entries and escaped names', async () => {
    const aria = [
      '- document:',
      `  - 'button "Sub: mit"'`,
      '  - link "Link \\"q\\"":',
      '    - /url: /x',
      `  - paragraph: "quoted: value"`,
      `  - 'heading "It''s here" [level=2]'`,
    ].join('\n');
    const result = await getAccessibilityTree(createMockPage('', aria) as never);

    expect(result!.children).toEqual([
      { role: 'button', name: 'Sub: mit' },
      { role: 'link', name: 'Link "q"' },
      { role: 'paragraph', name: 'quoted: value' },
      { role: 'heading', name: "It's here" },
    ]);
  });

  it('skips property lines and keeps attributes out of names', async () => {
    const aria = [
      '- document:',
      '  - textbox "Email addr":',
      '    - /placeholder: Email',
      '  - checkbox "Agree" [checked] [disabled]',
    ].join('\n');
    const result = await getAccessibilityTree(createMockPage('', aria) as never);

    expect(result!.children).toEqual([
      { role: 'textbox', name: 'Email addr' },
      { role: 'checkbox', name: 'Agree' },
    ]);
  });

  it('handles nodes without names', async () => {
    const aria = '- document:\n  - navigation:';
    const page = createMockPage('', aria);

    const result = await getAccessibilityTree(page as never);

    expect(result!.children![0]).toEqual({ role: 'navigation', name: '' });
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
