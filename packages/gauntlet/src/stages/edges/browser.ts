import { BrowserSession, browserTools } from '@cogitator-ai/browser';
import { Agent } from '@cogitator-ai/core';
import { z } from 'zod';
import type { StageDefinition } from '../../runner/types.js';
import { excerpt, serveHttp } from './shared.js';

const BROWSER = '@cogitator-ai/browser';
const CORE = '@cogitator-ai/core';

interface Product {
  slug: string;
  name: string;
  price: string;
  sku: string;
  warranty: string;
  blurb: string;
}

/** The fact the agent must find sits only on its detail page, so a right answer proves it browsed there. */
const TARGET: Product = {
  slug: 'brass-astrolabe',
  name: 'Brass Astrolabe',
  price: '$389',
  sku: 'BA-9055',
  warranty: '37 months',
  blurb: 'Hand-engraved planispheric astrolabe.',
};

const PRODUCTS: readonly Product[] = [
  {
    slug: 'copper-sextant',
    name: 'Copper Sextant',
    price: '$214',
    sku: 'CS-1180',
    warranty: '18 months',
    blurb: 'Navigational sextant with a copper frame.',
  },
  TARGET,
  {
    slug: 'oak-orrery',
    name: 'Oak Orrery',
    price: '$1,240',
    sku: 'OO-3302',
    warranty: '24 months',
    blurb: 'Clockwork model of the inner planets.',
  },
];

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function catalogue(): string {
  const rows = PRODUCTS.map(
    (product) =>
      `<tr><td><a href="/product/${product.slug}">${product.name}</a></td><td>${product.price}</td></tr>`
  ).join('');
  return page(
    'Gauntlet Instruments - Catalogue',
    `<h1>Gauntlet Instruments</h1><p>Antique scientific instruments. Warranty terms are on each product page.</p>
     <table id="catalogue"><thead><tr><th>Product</th><th>Price</th></tr></thead><tbody>${rows}</tbody></table>`
  );
}

function detail(product: Product): string {
  return page(
    `${product.name} - Gauntlet Instruments`,
    `<h1>${product.name}</h1><p>${product.blurb}</p>
     <dl><dt>Price</dt><dd>${product.price}</dd><dt>SKU</dt><dd id="sku">${product.sku}</dd>
     <dt>Warranty</dt><dd id="warranty">${product.warranty}</dd></dl><a href="/">Back to catalogue</a>`
  );
}

const Answer = z.object({
  product: z.string(),
  sku: z.string(),
  warrantyMonths: z.number().int(),
});

/** Proves an agent drives a real browser through the browser tools to find a fact on a local site. */
const browserAgent: StageDefinition = {
  id: 'browser-agent',
  title: 'Browser agent',
  description:
    'An agent with the browser tools opens a local product catalogue in headless Chromium, follows the right product link and reads a fact that only the product page holds.',
  packages: [BROWSER, CORE],
  needs: ['handshake'],
  requires: [{ kind: 'playwright' }],
  timeoutMs: 150_000,
  async run(ctx) {
    const visits: string[] = [];
    const site = await serveHttp(ctx, (request, response) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      visits.push(path);
      const product = PRODUCTS.find((entry) => path === `/product/${entry.slug}`);
      const html = path === '/' ? catalogue() : product ? detail(product) : undefined;
      response.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html ?? page('Not found', '<h1>Not found</h1>'));
    });

    const session = new BrowserSession({ headless: true, timeout: 15_000 });
    ctx.onCleanup(() => session.close());
    const tools = browserTools(session, { modules: ['navigation', 'extraction'] });

    await ctx.check('the browser tools load the requested modules', (evidence) => {
      const names = tools.map((entry) => entry.name);
      evidence('tools', names);
      if (!names.includes('browser_navigate') || !names.includes('browser_get_links')) {
        throw new Error('Navigation or extraction tools are missing');
      }
      if (
        names.some(
          (name) => name.startsWith('browser_click') || name.startsWith('browser_screenshot')
        )
      ) {
        throw new Error('Tools of modules that were not requested were included');
      }
    });

    await ctx.check(
      'the agent browses to the product page and reads the fact',
      async (evidence) => {
        const agent = new Agent({
          name: 'catalogue-researcher',
          model: ctx.model,
          instructions:
            'You research products on websites with the browser tools. Open pages, follow links and read the page text. Never guess: report only what a page shows.',
          tools,
          responseFormat: { type: 'json_schema', schema: Answer },
          maxIterations: 8,
        });
        const run = await ctx.cogitator.run(agent, {
          input: `Open the catalogue at ${site.url}/ and find the warranty period and SKU of the ${TARGET.name}.`,
        });
        const used = run.toolCalls.map((call) => call.name);
        evidence('toolCalls', used);
        evidence('visits', [...visits]);
        evidence('structured', run.structured ?? excerpt(run.output));
        if (!used.includes('browser_navigate')) throw new Error('The agent never navigated');
        if (!visits.includes(`/product/${TARGET.slug}`)) {
          throw new Error('The browser never opened the product page');
        }
        const answer = Answer.parse(run.structured);
        if (answer.sku !== TARGET.sku || answer.warrantyMonths !== 37) {
          throw new Error(`Wrong facts: ${JSON.stringify(answer)}`);
        }
      }
    );

    await ctx.check('the session reports the page it ended on', async (evidence) => {
      const url = session.page.url();
      evidence('url', url);
      if (!url.startsWith(site.url)) throw new Error(`The session is on ${url}`);
    });
  },
};

export const browserStages: StageDefinition[] = [browserAgent];
