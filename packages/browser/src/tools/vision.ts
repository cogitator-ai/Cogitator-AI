import { tool } from '@cogitator-ai/core';
import type { BrowserSession } from '../session';
import {
  screenshotSchema,
  screenshotElementSchema,
  findByDescriptionSchema,
  clickByDescriptionSchema,
  type ScreenshotInput,
  type ScreenshotElementInput,
  type FindByDescriptionInput,
  type ClickByDescriptionInput,
} from '../utils/schemas';
import { getAccessibilityTree, type AccessibilityNode } from '../utils/page-helpers';

function parseImageDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2;
        continue;
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
  }
  return { width: 0, height: 0 };
}

export function createScreenshotTool(session: BrowserSession) {
  return tool({
    name: 'browser_screenshot',
    description:
      'Take a screenshot of the current page or a specific element. Returns base64-encoded image data.',
    category: 'web' as const,
    tags: ['browser', 'vision'],
    parameters: screenshotSchema,
    execute: async (params: ScreenshotInput) => {
      const page = session.page;
      const options: Record<string, unknown> = { type: 'png' as const };
      if (params.fullPage) options.fullPage = true;
      if (params.quality != null) {
        options.type = 'jpeg';
        options.quality = params.quality;
      }

      let buffer: Buffer;
      if (params.selector) {
        buffer = await page.locator(params.selector).screenshot(options);
      } else {
        buffer = await page.screenshot(options);
      }

      const dims = parseImageDimensions(buffer);
      const viewport = page.viewportSize();
      return {
        image: buffer.toString('base64'),
        width: dims.width || (viewport?.width ?? 0),
        height: dims.height || (viewport?.height ?? 0),
      };
    },
  });
}

export function createScreenshotElementTool(session: BrowserSession) {
  return tool({
    name: 'browser_screenshot_element',
    description:
      'Screenshot a specific element and return its base64 image with bounding box coordinates.',
    category: 'web' as const,
    tags: ['browser', 'vision'],
    parameters: screenshotElementSchema,
    execute: async (params: ScreenshotElementInput) => {
      const page = session.page;
      const locator = page.locator(params.selector);
      const buffer = await locator.screenshot({ type: 'png' });
      const box = await locator.boundingBox();
      return {
        image: buffer.toString('base64'),
        boundingBox: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
      };
    },
  });
}

export function createFindByDescriptionTool(session: BrowserSession) {
  return tool({
    name: 'browser_find_by_description',
    description:
      'Find elements matching a natural language description using the accessibility tree.',
    category: 'web' as const,
    tags: ['browser', 'vision'],
    parameters: findByDescriptionSchema,
    execute: async (params: FindByDescriptionInput) => {
      const page = session.page;
      const snapshot = await getAccessibilityTree(page);
      if (!snapshot) return { elements: [], total: 0 };

      const description = params.description.toLowerCase();
      const matches: Array<{ role: string; name: string; description: string }> = [];
      const maxResults = 50;

      function walk(node: AccessibilityNode) {
        const name = (node.name ?? '').toLowerCase();
        const role = (node.role ?? '').toLowerCase();
        if (name.length >= 2) {
          const nameContainsDescription = name.includes(description);
          const descriptionContainsName =
            name.length >= 3 &&
            new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(description);
          const roleMatches = description.length >= 3 && role.includes(description);
          if (nameContainsDescription || descriptionContainsName || roleMatches) {
            matches.push({
              role: node.role ?? '',
              name: node.name ?? '',
              description: `${node.role}: "${node.name}"`,
            });
          }
        }
        if (node.children) {
          for (const child of node.children) walk(child);
        }
      }
      walk(snapshot);

      return { elements: matches.slice(0, maxResults), total: matches.length };
    },
  });
}

export function createClickByDescriptionTool(session: BrowserSession) {
  return tool({
    name: 'browser_click_by_description',
    description:
      'Find an element by natural language description and click it. Tries role, text, label, and placeholder strategies.',
    category: 'web' as const,
    tags: ['browser', 'vision'],
    parameters: clickByDescriptionSchema,
    execute: async (params: ClickByDescriptionInput) => {
      const page = session.page;
      const { description } = params;

      const strategies = [
        () => page.getByRole('button', { name: description }),
        () => page.getByRole('link', { name: description }),
        () => page.getByText(description, { exact: false }),
        () => page.getByLabel(description),
        () => page.getByPlaceholder(description),
      ];

      for (const getLocator of strategies) {
        const locator = getLocator();
        const count = await locator.count();
        if (count > 0) {
          const idx = params.index ?? 0;
          if (idx < 0 || idx >= count) {
            return { clicked: false, element: null };
          }
          await locator.nth(idx).click();
          return {
            clicked: true,
            element: { description: params.description, index: idx },
          };
        }
      }

      return { clicked: false, element: null };
    },
  });
}

export function createVisionTools(session: BrowserSession) {
  return [
    createScreenshotTool(session),
    createScreenshotElementTool(session),
    createFindByDescriptionTool(session),
    createClickByDescriptionTool(session),
  ];
}
