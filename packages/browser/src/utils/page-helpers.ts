import type { Page, ElementHandle } from 'playwright';
import type { ElementInfo } from '@cogitator-ai/types';

function readableTextInPage(selector: string | undefined): string {
  const scope = selector ? document.querySelector(selector) : document.body;
  if (!scope) return '';
  const text = scope instanceof HTMLElement ? scope.innerText : (scope.textContent ?? '');
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function getReadableText(page: Page, selector?: string): Promise<string> {
  return page.evaluate(readableTextInPage, selector);
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

const ARIA_KEY_PATTERN = /^([A-Za-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+\[[^\]]*\])*$/;

function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

function unquoteYamlScalar(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unescapeDoubleQuoted(value.slice(1, -1));
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function splitAriaEntry(entry: string): { key: string; value: string } {
  if (entry.startsWith("'")) {
    let i = 1;
    while (i < entry.length) {
      if (entry[i] === "'") {
        if (entry[i + 1] === "'") {
          i += 2;
          continue;
        }
        break;
      }
      i++;
    }
    const key = entry.slice(1, i).replace(/''/g, "'");
    const rest = entry.slice(i + 1).trim();
    return { key, value: rest.startsWith(':') ? rest.slice(1).trim() : '' };
  }

  let inQuotes = false;
  for (let i = 0; i < entry.length; i++) {
    const ch = entry[i];
    if (ch === '\\' && inQuotes) {
      i++;
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ':' && !inQuotes && (i === entry.length - 1 || entry[i + 1] === ' ')) {
      return { key: entry.slice(0, i).trim(), value: entry.slice(i + 1).trim() };
    }
  }
  return { key: entry.trim(), value: '' };
}

export function parseAriaSnapshot(snapshot: string): AccessibilityNode {
  const root: AccessibilityNode = { role: 'WebArea', name: '', children: [] };
  const stack: Array<{ node: AccessibilityNode; indent: number }> = [{ node: root, indent: -1 }];

  for (const line of snapshot.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) continue;

    const indent = line.search(/\S/);
    const { key, value } = splitAriaEntry(trimmed.slice(2).trim());
    if (key.startsWith('/')) continue;

    const match = ARIA_KEY_PATTERN.exec(key);
    if (!match) continue;

    const role = match[1];
    const name = match[2] !== undefined ? unescapeDoubleQuoted(match[2]) : unquoteYamlScalar(value);
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
