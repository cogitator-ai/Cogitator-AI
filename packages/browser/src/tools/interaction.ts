import { tool } from '@cogitator-ai/core';
import type { BrowserSession } from '../session';
import {
  clickSchema,
  typeSchema,
  selectOptionSchema,
  hoverSchema,
  scrollSchema,
  pressKeySchema,
  dragAndDropSchema,
  fillFormSchema,
  uploadFileSchema,
  type ClickInput,
  type TypeInput,
  type SelectOptionInput,
  type HoverInput,
  type ScrollInput,
  type PressKeyInput,
  type DragAndDropInput,
  type FillFormInput,
  type UploadFileInput,
} from '../utils/schemas';

export function createClickTool(session: BrowserSession) {
  return tool({
    name: 'browser_click',
    description: 'Click an element on the page by CSS selector.',
    category: 'web' as const,
    tags: ['browser', 'interaction'],
    parameters: clickSchema,
    execute: async (params: ClickInput) => {
      const page = session.page;
      await page.click(params.selector, {
        button: params.button,
        clickCount: params.clickCount,
        position: params.position,
      });
      return { clicked: true };
    },
  });
}

export function createTypeTool(session: BrowserSession) {
  return tool({
    name: 'browser_type',
    description:
      'Type text into an input element. Uses fill() for instant input or type() for keystroke simulation.',
    category: 'web' as const,
    tags: ['browser', 'interaction'],
    parameters: typeSchema,
    execute: async (params: TypeInput) => {
      const page = session.page;
      if (params.clearFirst) {
        await page.fill(params.selector, '');
      }

      const useStealthDelay =
        !params.delay && session.stealthEnabled && session.stealthConfig?.humanLikeTyping;

      if (params.delay) {
        await page.type(params.selector, params.text, { delay: params.delay });
      } else if (useStealthDelay) {
        const delay = Math.floor(Math.random() * 101) + 50;
        await page.type(params.selector, params.text, { delay });
      } else {
        await page.fill(params.selector, params.text);
      }
      return { typed: true };
    },
  });
}

export function createSelectOptionTool(session: BrowserSession) {
  return tool({
    name: 'browser_select_option',
    description: 'Select an option from a <select> element by value, label, or index.',
    category: 'web' as const,
    tags: ['browser', 'interaction'],
    parameters: selectOptionSchema,
    execute: async (params: SelectOptionInput) => {
      const page = session.page;
      const opts: Record<string, unknown> = {};
      if (params.value !== undefined) opts.value = params.value;
      if (params.label !== undefined) opts.label = params.label;
      if (params.index !== undefined) opts.index = params.index;
      const selected = await page.selectOption(params.selector, opts);
      return { selected };
    },
  });
}

export function createHoverTool(session: BrowserSession) {
  return tool({
    name: 'browser_hover',
    description: 'Hover over an element on the page.',
    category: 'web' as const,
    tags: ['browser', 'interaction'],
    parameters: hoverSchema,
    execute: async (params: HoverInput) => {
      await session.page.hover(params.selector, { position: params.position });
      return { hovered: true };
    },
  });
}

export function createScrollTool(session: BrowserSession) {
  return tool({
    name: 'browser_scroll',
    description: 'Scroll the page or a specific element in any direction.',
    category: 'web' as const,
    tags: ['browser', 'interaction'],
    parameters: scrollSchema,
    execute: async (params: ScrollInput) => {
      const page = session.page;
      const amount = params.amount ?? 500;
      const deltas = {
        up: { x: 0, y: -amount },
        down: { x: 0, y: amount },
        left: { x: -amount, y: 0 },
        right: { x: amount, y: 0 },
      };
      const { x, y } = deltas[params.direction];

      if (params.selector) {
        await page
          .locator(params.selector)
          .evaluate((el: Element, d: { x: number; y: number }) => el.scrollBy(d.x, d.y), { x, y });
      } else {
        await page.evaluate((d: { x: number; y: number }) => window.scrollBy(d.x, d.y), { x, y });
      }
      return { scrolled: true };
    },
  });
}

export function createPressKeyTool(session: BrowserSession) {
  return tool({
    name: 'browser_press_key',
    description: 'Press a keyboard key, optionally with modifier keys.',
    category: 'web' as const,
    tags: ['browser', 'interaction'],
    parameters: pressKeySchema,
    execute: async (params: PressKeyInput) => {
      const page = session.page;
      let keyCombo = params.key;
      if (params.modifiers?.length) {
        keyCombo = [...params.modifiers, params.key].join('+');
      }
      await page.keyboard.press(keyCombo);
      return { pressed: true };
    },
  });
}

export function createDragAndDropTool(session: BrowserSession) {
  return tool({
    name: 'browser_drag_and_drop',
    description: 'Drag an element and drop it onto another element.',
    category: 'web' as const,
    tags: ['browser', 'interaction'],
    parameters: dragAndDropSchema,
    execute: async (params: DragAndDropInput) => {
      await session.page.dragAndDrop(params.source, params.target);
      return { dropped: true };
    },
  });
}

function buildFieldSelectors(key: string): string[] {
  return [
    `input[name="${key}"]`,
    `input[placeholder="${key}"]`,
    `input[aria-label="${key}"]`,
    `textarea[name="${key}"]`,
    `select[name="${key}"]`,
    `label:has-text("${key}") input`,
    `label:has-text("${key}") textarea`,
    `label:has-text("${key}") select`,
  ];
}

export function createFillFormTool(session: BrowserSession) {
  return tool({
    name: 'browser_fill_form',
    description:
      'Smart form filler. Finds inputs by name, placeholder, aria-label, or associated label text and fills them.',
    category: 'web' as const,
    tags: ['browser', 'interaction'],
    parameters: fillFormSchema,
    execute: async (params: FillFormInput) => {
      const page = session.page;
      const filled: string[] = [];

      for (const [key, value] of Object.entries(params.fields)) {
        const selectors = buildFieldSelectors(key);
        let found = false;

        for (const sel of selectors) {
          const loc = page.locator(sel);
          const count = await loc.count();
          if (count === 0) continue;

          const el = loc.first();

          if (typeof value === 'string') {
            if (session.stealthEnabled && session.stealthConfig?.humanLikeTyping) {
              const delay = Math.floor(Math.random() * 101) + 50;
              await el.type(value, { delay });
            } else {
              await el.fill(value);
            }
          } else if (typeof value === 'boolean') {
            if (value) {
              await el.check();
            } else {
              await el.uncheck();
            }
          } else if (Array.isArray(value)) {
            await el.selectOption(value);
          }

          filled.push(key);
          found = true;
          break;
        }

        void found;
      }

      return { filled };
    },
  });
}

export function createUploadFileTool(session: BrowserSession) {
  return tool({
    name: 'browser_upload_file',
    description: 'Upload files to a file input element.',
    category: 'web' as const,
    tags: ['browser', 'interaction'],
    parameters: uploadFileSchema,
    execute: async (params: UploadFileInput) => {
      await session.page.setInputFiles(params.selector, params.filePaths);
      return { uploaded: true };
    },
  });
}

export function createInteractionTools(session: BrowserSession) {
  return [
    createClickTool(session),
    createTypeTool(session),
    createSelectOptionTool(session),
    createHoverTool(session),
    createScrollTool(session),
    createPressKeyTool(session),
    createDragAndDropTool(session),
    createFillFormTool(session),
    createUploadFileTool(session),
  ];
}
