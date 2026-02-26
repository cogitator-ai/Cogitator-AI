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
    return clone.innerText?.trim() ?? clone.textContent?.trim() ?? '';
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

    const stripped = line.replace(/^- /, '');
    const indent = stripped.search(/\S/);
    const content = stripped.trim().replace(/^- /, '');

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
    return {
      tag: el.tagName.toLowerCase(),
      text: htmlEl.textContent?.trim().slice(0, 200) ?? '',
      attributes: attrs,
      boundingBox:
        rect.width > 0 && rect.height > 0
          ? {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            }
          : undefined,
      visible: rect.width > 0 && rect.height > 0,
    };
  });
}
