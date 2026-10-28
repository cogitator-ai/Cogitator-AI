import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import type { ToolApp } from '@cogitator-ai/types';
import { z } from 'zod';

export const cogitator = new Cogitator({ llm: { defaultModel: 'ollama/unused' } });

const CART_PAGE = '<!doctype html><html><body><p id="cart">cart</p></body></html>';

export const appCalls: string[] = [];

const cartApp: ToolApp = {
  resourceUri: 'ui://shop/cart',
  read: async () => ({
    uri: 'ui://shop/cart',
    mimeType: 'text/html;profile=mcp-app',
    html: CART_PAGE,
    csp: {
      connectDomains: ['https://api.shop.example', "'unsafe-eval'"],
      resourceDomains: ['https://cdn.shop.example'],
    },
    permissions: { clipboardWrite: {} },
    prefersBorder: false,
  }),
  callTool: async (name, args) => {
    appCalls.push(name);
    return {
      content: [{ type: 'text', text: `${name} ${JSON.stringify(args)}` }],
      structuredContent: { called: name },
    };
  },
  requiresApproval: async (name) => name === 'empty_cart',
};

const showCart = tool({
  name: 'show_cart',
  description: 'Shows the cart',
  parameters: z.object({}),
  app: cartApp,
  execute: async () => ({ items: 2 }),
});

const showReceipt = tool({
  name: 'show_receipt',
  description: 'Shows the receipt',
  parameters: z.object({}),
  app: {
    resourceUri: 'ui://shop/receipt',
    read: async () => ({
      uri: 'ui://shop/receipt',
      mimeType: 'text/html;profile=mcp-app',
      html: '<p>receipt</p>',
    }),
  },
  execute: async () => 'receipt',
});

const plain = tool({
  name: 'plain',
  description: 'A tool without an app',
  parameters: z.object({}),
  execute: async () => 'plain',
});

const shop = new Agent({
  name: 'shop',
  model: 'ollama/unused',
  instructions: 'Run the shop.',
  tools: [showCart, showReceipt, plain],
});

export const agents = { shop };
