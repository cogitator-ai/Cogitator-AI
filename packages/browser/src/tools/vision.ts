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
      if (params.quality) {
        options.type = 'jpeg';
        options.quality = params.quality;
      }

      let buffer: Buffer;
      if (params.selector) {
        buffer = await page.locator(params.selector).screenshot(options);
      } else {
        buffer = await page.screenshot(options);
      }

      const viewport = page.viewportSize();
      return {
        image: buffer.toString('base64'),
        width: viewport?.width ?? 0,
        height: viewport?.height ?? 0,
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

interface AccessibilityNode {
  role?: string;
  name?: string;
  children?: AccessibilityNode[];
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
      const snapshot = await (
        page as unknown as { accessibility: { snapshot(): Promise<AccessibilityNode | null> } }
      ).accessibility.snapshot();
      if (!snapshot) return { elements: [] };

      const description = params.description.toLowerCase();
      const matches: Array<{ role: string; name: string; description: string }> = [];

      function walk(node: AccessibilityNode) {
        const name = (node.name ?? '').toLowerCase();
        const role = (node.role ?? '').toLowerCase();
        if (
          name.includes(description) ||
          description.includes(name) ||
          role.includes(description)
        ) {
          if (name) {
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

      return { elements: matches };
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
