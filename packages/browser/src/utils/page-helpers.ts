import type { Page, ElementHandle } from 'playwright';
import type { ElementInfo } from '@cogitator-ai/types';

export async function getReadableText(page: Page, selector?: string): Promise<string> {
  return page.evaluate((sel) => {
    const scope = sel ? document.querySelector(sel) : document.body;
    if (!scope) return '';
    const clone = scope.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll('script, style, noscript, svg, link[rel="stylesheet"]')
      .forEach((el) => el.remove());
    return clone.textContent?.trim() || clone.innerText?.trim() || '';
  }, selector);
}

export interface AccessibilityNode {
  role: string;
  name: string;
  children?: AccessibilityNode[];
}

export async function getAccessibilityTree(page: Page): Promise<AccessibilityNode | null> {
  const raw = await page.locator(':root').ariaSnapshot();
  if (!raw) return null;
  return parseAriaSnapshot(raw);
}

function parseAriaSnapshot(snapshot: string): AccessibilityNode {
  const lines = snapshot.split('\n');
  const root: AccessibilityNode = { role: 'WebArea', name: '', children: [] };
  const stack: Array<{ node: AccessibilityNode; indent: number }> = [{ node: root, indent: -1 }];

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('/')) continue;

    const indent = line.search(/\S/);
    const content = line.trim().replace(/^- /, '');

    const match = /^(\w[\w\s]*?)(?:\s+"(.*)")?(?:\s+\[.*])?:?$/.exec(content);
    if (!match) continue;

    const role = match[1].trim();
    const name = match[2] ?? '';

    const node: AccessibilityNode = { role, name };

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].node;
    if (!parent.children) parent.children = [];
    parent.children.push(node);
    stack.push({ node, indent });
  }

  if (root.children?.length === 1 && root.children[0].role === 'document') {
    return root.children[0];
  }
  return root;
}

export async function elementToInfo(handle: ElementHandle): Promise<ElementInfo> {
  return handle.evaluate((el: Element) => {
    const htmlEl = el as HTMLElement;
    const rect = el.getBoundingClientRect();
    const attrs: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) {
      attrs[attr.name] = attr.value;
    }

    const hasSize = rect.width > 0 && rect.height > 0;
    let visible = hasSize;
    if (hasSize) {
      const win = el.ownerDocument?.defaultView ?? window;
      let node: Element | null = el;
      while (visible && node) {
        const style = win.getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
          visible = false;
        }
        node = node.parentElement;
      }
    }

    return {
      tag: el.tagName.toLowerCase(),
      text: htmlEl.textContent?.trim().slice(0, 200) ?? '',
      attributes: attrs,
      boundingBox: hasSize
        ? {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          }
        : undefined,
      visible,
    };
  });
}
