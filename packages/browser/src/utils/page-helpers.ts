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
  const snapshot = await page.accessibility.snapshot();
  if (!snapshot) return null;

  function simplify(node: Record<string, unknown>): AccessibilityNode {
    const result: AccessibilityNode = {
      role: (node.role as string) ?? '',
      name: (node.name as string) ?? '',
    };
    const children = node.children as Record<string, unknown>[] | undefined;
    if (children?.length) {
      result.children = children.map(simplify);
    }
    return result;
  }

  return simplify(snapshot as unknown as Record<string, unknown>);
}

export async function elementToInfo(handle: ElementHandle): Promise<ElementInfo> {
  return handle.evaluate((el: Element) => {
    const htmlEl = el as HTMLElement;
    const rect = el.getBoundingClientRect();
    const attrs: Record<string, string> = {};
    for (const attr of el.attributes) {
      attrs[attr.name] = attr.value;
    }
    return {
      tag: el.tagName.toLowerCase(),
      text: htmlEl.textContent?.trim().slice(0, 200) ?? '',
      attributes: attrs,
      boundingBox:
        rect.width > 0
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
