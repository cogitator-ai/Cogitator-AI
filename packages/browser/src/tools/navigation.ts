import { tool } from '@cogitator-ai/core';
import type { BrowserSession } from '../session';
import {
  navigateSchema,
  goBackSchema,
  goForwardSchema,
  reloadSchema,
  waitForNavigationSchema,
  getCurrentUrlSchema,
  waitForSelectorSchema,
  type NavigateInput,
  type ReloadInput,
  type WaitForNavigationInput,
  type WaitForSelectorInput,
} from '../utils/schemas';

export function createNavigateTool(session: BrowserSession) {
  return tool({
    name: 'browser_navigate',
    description:
      'Navigate to a URL in the browser. Returns the final URL, page title, and HTTP status.',
    category: 'web' as const,
    tags: ['browser', 'navigation'],
    parameters: navigateSchema,
    execute: async (params: NavigateInput) => {
      const page = session.page;
      const response = await page.goto(params.url, {
        waitUntil: params.waitUntil ?? 'load',
      });
      return {
        url: page.url(),
        title: await page.title(),
        status: response?.status() ?? 0,
      };
    },
  });
}

export function createGoBackTool(session: BrowserSession) {
  return tool({
    name: 'browser_go_back',
    description: 'Go back to the previous page in browser history.',
    category: 'web' as const,
    tags: ['browser', 'navigation'],
    parameters: goBackSchema,
    execute: async () => {
      const page = session.page;
      await page.goBack();
      return {
        url: page.url(),
        title: await page.title(),
      };
    },
  });
}

export function createGoForwardTool(session: BrowserSession) {
  return tool({
    name: 'browser_go_forward',
    description: 'Go forward to the next page in browser history.',
    category: 'web' as const,
    tags: ['browser', 'navigation'],
    parameters: goForwardSchema,
    execute: async () => {
      const page = session.page;
      await page.goForward();
      return {
        url: page.url(),
        title: await page.title(),
      };
    },
  });
}

export function createReloadTool(session: BrowserSession) {
  return tool({
    name: 'browser_reload',
    description: 'Reload the current page.',
    category: 'web' as const,
    tags: ['browser', 'navigation'],
    parameters: reloadSchema,
    execute: async (params: ReloadInput) => {
      const page = session.page;
      await page.reload({ waitUntil: params.waitUntil ?? 'load' });
      return {
        url: page.url(),
        title: await page.title(),
      };
    },
  });
}

export function createWaitForNavigationTool(session: BrowserSession) {
  return tool({
    name: 'browser_wait_for_navigation',
    description: 'Wait for the page to navigate to a URL matching the given pattern.',
    category: 'web' as const,
    tags: ['browser', 'navigation'],
    parameters: waitForNavigationSchema,
    execute: async (params: WaitForNavigationInput) => {
      const page = session.page;
      await page.waitForURL(params.url ?? '**', { timeout: params.timeout });
      return {
        url: page.url(),
        title: await page.title(),
      };
    },
  });
}

export function createGetCurrentUrlTool(session: BrowserSession) {
  return tool({
    name: 'browser_get_current_url',
    description: 'Get the current page URL and title.',
    category: 'web' as const,
    tags: ['browser', 'navigation'],
    parameters: getCurrentUrlSchema,
    execute: async () => {
      const page = session.page;
      return {
        url: page.url(),
        title: await page.title(),
      };
    },
  });
}

export function createWaitForSelectorTool(session: BrowserSession) {
  return tool({
    name: 'browser_wait_for_selector',
    description:
      'Wait for a CSS selector to appear on the page. Returns whether the element was found.',
    category: 'web' as const,
    tags: ['browser', 'navigation'],
    parameters: waitForSelectorSchema,
    execute: async (params: WaitForSelectorInput) => {
      const page = session.page;
      try {
        await page.waitForSelector(params.selector, {
          state: params.state,
          timeout: params.timeout,
        });
        return { found: true };
      } catch {
        return { found: false };
      }
    },
  });
}

export function createNavigationTools(session: BrowserSession) {
  return [
    createNavigateTool(session),
    createGoBackTool(session),
    createGoForwardTool(session),
    createReloadTool(session),
    createWaitForNavigationTool(session),
    createGetCurrentUrlTool(session),
    createWaitForSelectorTool(session),
  ];
}
