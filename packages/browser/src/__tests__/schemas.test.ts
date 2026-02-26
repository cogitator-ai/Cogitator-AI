import { describe, it, expect } from 'vitest';
import {
  navigateSchema,
  goBackSchema,
  goForwardSchema,
  reloadSchema,
  waitForNavigationSchema,
  getCurrentUrlSchema,
  waitForSelectorSchema,
  clickSchema,
  typeSchema,
  selectOptionSchema,
  hoverSchema,
  scrollSchema,
  pressKeySchema,
  dragAndDropSchema,
  fillFormSchema,
  uploadFileSchema,
  getTextSchema,
  getHtmlSchema,
  getAttributeSchema,
  getLinksSchema,
  querySelectorAllSchema,
  extractTableSchema,
  extractStructuredSchema,
  screenshotSchema,
  screenshotElementSchema,
  findByDescriptionSchema,
  clickByDescriptionSchema,
  interceptRequestSchema,
  waitForResponseSchema,
  blockResourcesSchema,
  captureHarSchema,
  getApiCallsSchema,
} from '../utils/schemas';
import type {
  NavigateInput,
  ClickInput,
  FillFormInput,
  InterceptRequestInput,
} from '../utils/schemas';

describe('Navigation schemas', () => {
  describe('navigateSchema', () => {
    it('parses valid input', () => {
      const result = navigateSchema.parse({ url: 'https://example.com' });
      expect(result.url).toBe('https://example.com');
    });

    it('accepts optional waitUntil', () => {
      const result = navigateSchema.parse({ url: 'https://example.com', waitUntil: 'networkidle' });
      expect(result.waitUntil).toBe('networkidle');
    });

    it('accepts all waitUntil values', () => {
      for (const val of ['load', 'domcontentloaded', 'networkidle', 'commit'] as const) {
        expect(navigateSchema.parse({ url: 'https://example.com', waitUntil: val }).waitUntil).toBe(
          val
        );
      }
    });

    it('rejects missing url', () => {
      expect(() => navigateSchema.parse({})).toThrow();
    });

    it('rejects invalid waitUntil', () => {
      expect(() =>
        navigateSchema.parse({ url: 'https://example.com', waitUntil: 'nope' })
      ).toThrow();
    });

    it('rejects non-URL string', () => {
      expect(() => navigateSchema.parse({ url: 'not-a-url' })).toThrow();
    });

    it('satisfies NavigateInput type', () => {
      const input: NavigateInput = { url: 'https://example.com', waitUntil: 'load' };
      expect(navigateSchema.parse(input)).toEqual(input);
    });
  });

  describe('goBackSchema', () => {
    it('parses empty object', () => {
      expect(goBackSchema.parse({})).toEqual({});
    });
  });

  describe('goForwardSchema', () => {
    it('parses empty object', () => {
      expect(goForwardSchema.parse({})).toEqual({});
    });
  });

  describe('reloadSchema', () => {
    it('parses empty object', () => {
      expect(reloadSchema.parse({})).toEqual({});
    });

    it('accepts optional waitUntil', () => {
      expect(reloadSchema.parse({ waitUntil: 'domcontentloaded' }).waitUntil).toBe(
        'domcontentloaded'
      );
    });

    it('rejects invalid waitUntil', () => {
      expect(() => reloadSchema.parse({ waitUntil: 'invalid' })).toThrow();
    });
  });

  describe('waitForNavigationSchema', () => {
    it('parses empty object', () => {
      expect(waitForNavigationSchema.parse({})).toEqual({});
    });

    it('accepts url and timeout', () => {
      const result = waitForNavigationSchema.parse({ url: '**/api/**', timeout: 5000 });
      expect(result.url).toBe('**/api/**');
      expect(result.timeout).toBe(5000);
    });
  });

  describe('getCurrentUrlSchema', () => {
    it('parses empty object', () => {
      expect(getCurrentUrlSchema.parse({})).toEqual({});
    });
  });

  describe('waitForSelectorSchema', () => {
    it('parses valid input', () => {
      const result = waitForSelectorSchema.parse({ selector: '#main' });
      expect(result.selector).toBe('#main');
    });

    it('accepts all state values', () => {
      for (const state of ['visible', 'hidden', 'attached', 'detached'] as const) {
        expect(waitForSelectorSchema.parse({ selector: 'div', state }).state).toBe(state);
      }
    });

    it('accepts optional timeout', () => {
      const result = waitForSelectorSchema.parse({ selector: 'div', timeout: 3000 });
      expect(result.timeout).toBe(3000);
    });

    it('rejects missing selector', () => {
      expect(() => waitForSelectorSchema.parse({})).toThrow();
    });

    it('rejects invalid state', () => {
      expect(() => waitForSelectorSchema.parse({ selector: 'div', state: 'gone' })).toThrow();
    });
  });
});

describe('Interaction schemas', () => {
  describe('clickSchema', () => {
    it('parses minimal input', () => {
      const result = clickSchema.parse({ selector: 'button' });
      expect(result.selector).toBe('button');
    });

    it('accepts all options', () => {
      const input = {
        selector: 'button.submit',
        button: 'right' as const,
        clickCount: 2,
        position: { x: 10, y: 20 },
      };
      const result = clickSchema.parse(input);
      expect(result).toEqual(input);
    });

    it('rejects invalid button', () => {
      expect(() => clickSchema.parse({ selector: 'a', button: 'back' })).toThrow();
    });

    it('rejects position missing y', () => {
      expect(() => clickSchema.parse({ selector: 'a', position: { x: 10 } })).toThrow();
    });

    it('rejects missing selector', () => {
      expect(() => clickSchema.parse({})).toThrow();
    });

    it('satisfies ClickInput type', () => {
      const input: ClickInput = { selector: '#btn', button: 'left', clickCount: 1 };
      expect(clickSchema.parse(input)).toEqual(input);
    });
  });

  describe('typeSchema', () => {
    it('parses required fields', () => {
      const result = typeSchema.parse({ selector: 'input', text: 'hello' });
      expect(result.selector).toBe('input');
      expect(result.text).toBe('hello');
    });

    it('accepts delay and clearFirst', () => {
      const result = typeSchema.parse({
        selector: 'input',
        text: 'world',
        delay: 50,
        clearFirst: true,
      });
      expect(result.delay).toBe(50);
      expect(result.clearFirst).toBe(true);
    });

    it('rejects missing text', () => {
      expect(() => typeSchema.parse({ selector: 'input' })).toThrow();
    });

    it('rejects missing selector', () => {
      expect(() => typeSchema.parse({ text: 'hello' })).toThrow();
    });
  });

  describe('selectOptionSchema', () => {
    it('parses with value', () => {
      const result = selectOptionSchema.parse({ selector: 'select', value: 'opt1' });
      expect(result.value).toBe('opt1');
    });

    it('parses with label', () => {
      const result = selectOptionSchema.parse({ selector: 'select', label: 'Option 1' });
      expect(result.label).toBe('Option 1');
    });

    it('parses with index', () => {
      const result = selectOptionSchema.parse({ selector: 'select', index: 0 });
      expect(result.index).toBe(0);
    });

    it('rejects selector without value/label/index', () => {
      expect(() => selectOptionSchema.parse({ selector: 'select' })).toThrow(
        'At least one of value, label, or index is required'
      );
    });

    it('rejects missing selector', () => {
      expect(() => selectOptionSchema.parse({ value: 'x' })).toThrow();
    });
  });

  describe('hoverSchema', () => {
    it('parses minimal input', () => {
      expect(hoverSchema.parse({ selector: '.menu' }).selector).toBe('.menu');
    });

    it('accepts position', () => {
      const result = hoverSchema.parse({ selector: '.menu', position: { x: 5, y: 5 } });
      expect(result.position).toEqual({ x: 5, y: 5 });
    });

    it('rejects missing selector', () => {
      expect(() => hoverSchema.parse({})).toThrow();
    });
  });

  describe('scrollSchema', () => {
    it('parses with direction only', () => {
      expect(scrollSchema.parse({ direction: 'down' }).direction).toBe('down');
    });

    it('accepts all directions', () => {
      for (const dir of ['up', 'down', 'left', 'right'] as const) {
        expect(scrollSchema.parse({ direction: dir }).direction).toBe(dir);
      }
    });

    it('accepts amount and selector', () => {
      const result = scrollSchema.parse({
        direction: 'up',
        amount: 500,
        selector: '.scrollable',
      });
      expect(result.amount).toBe(500);
      expect(result.selector).toBe('.scrollable');
    });

    it('rejects missing direction', () => {
      expect(() => scrollSchema.parse({})).toThrow();
    });

    it('rejects invalid direction', () => {
      expect(() => scrollSchema.parse({ direction: 'diagonal' })).toThrow();
    });
  });

  describe('pressKeySchema', () => {
    it('parses key only', () => {
      expect(pressKeySchema.parse({ key: 'Enter' }).key).toBe('Enter');
    });

    it('accepts modifiers', () => {
      const result = pressKeySchema.parse({ key: 'c', modifiers: ['Control', 'Shift'] });
      expect(result.modifiers).toEqual(['Control', 'Shift']);
    });

    it('accepts all modifier values', () => {
      for (const mod of ['Shift', 'Control', 'Alt', 'Meta'] as const) {
        expect(pressKeySchema.parse({ key: 'a', modifiers: [mod] }).modifiers).toEqual([mod]);
      }
    });

    it('rejects missing key', () => {
      expect(() => pressKeySchema.parse({})).toThrow();
    });

    it('rejects invalid modifier', () => {
      expect(() => pressKeySchema.parse({ key: 'a', modifiers: ['Super'] })).toThrow();
    });
  });

  describe('dragAndDropSchema', () => {
    it('parses valid input', () => {
      const result = dragAndDropSchema.parse({ source: '#item', target: '#zone' });
      expect(result.source).toBe('#item');
      expect(result.target).toBe('#zone');
    });

    it('rejects missing source', () => {
      expect(() => dragAndDropSchema.parse({ target: '#zone' })).toThrow();
    });

    it('rejects missing target', () => {
      expect(() => dragAndDropSchema.parse({ source: '#item' })).toThrow();
    });
  });

  describe('fillFormSchema', () => {
    it('parses string values', () => {
      const result = fillFormSchema.parse({ fields: { Name: 'John', Email: 'john@test.com' } });
      expect(result.fields.Name).toBe('John');
    });

    it('parses boolean values', () => {
      const result = fillFormSchema.parse({ fields: { 'I agree': true } });
      expect(result.fields['I agree']).toBe(true);
    });

    it('parses array values', () => {
      const result = fillFormSchema.parse({ fields: { Tags: ['a', 'b'] } });
      expect(result.fields.Tags).toEqual(['a', 'b']);
    });

    it('parses mixed value types', () => {
      const input: FillFormInput = {
        fields: { Name: 'Al', Accept: true, Options: ['x', 'y'] },
      };
      expect(fillFormSchema.parse(input)).toEqual(input);
    });

    it('rejects missing fields', () => {
      expect(() => fillFormSchema.parse({})).toThrow();
    });

    it('rejects number values in fields', () => {
      expect(() => fillFormSchema.parse({ fields: { Age: 25 } })).toThrow();
    });
  });

  describe('uploadFileSchema', () => {
    it('parses valid input', () => {
      const result = uploadFileSchema.parse({
        selector: 'input[type=file]',
        filePaths: ['/tmp/doc.pdf'],
      });
      expect(result.filePaths).toEqual(['/tmp/doc.pdf']);
    });

    it('accepts multiple file paths', () => {
      const result = uploadFileSchema.parse({
        selector: '#upload',
        filePaths: ['/a.jpg', '/b.png', '/c.gif'],
      });
      expect(result.filePaths).toHaveLength(3);
    });

    it('rejects missing filePaths', () => {
      expect(() => uploadFileSchema.parse({ selector: 'input' })).toThrow();
    });

    it('rejects missing selector', () => {
      expect(() => uploadFileSchema.parse({ filePaths: ['/tmp/x'] })).toThrow();
    });
  });
});

describe('Extraction schemas', () => {
  describe('getTextSchema', () => {
    it('parses empty object', () => {
      expect(getTextSchema.parse({})).toEqual({});
    });

    it('accepts optional selector', () => {
      expect(getTextSchema.parse({ selector: '#content' }).selector).toBe('#content');
    });
  });

  describe('getHtmlSchema', () => {
    it('parses empty object', () => {
      expect(getHtmlSchema.parse({})).toEqual({});
    });

    it('accepts selector and outer', () => {
      const result = getHtmlSchema.parse({ selector: 'main', outer: true });
      expect(result.selector).toBe('main');
      expect(result.outer).toBe(true);
    });
  });

  describe('getAttributeSchema', () => {
    it('parses valid input', () => {
      const result = getAttributeSchema.parse({ selector: 'img', attribute: 'src' });
      expect(result.selector).toBe('img');
      expect(result.attribute).toBe('src');
    });

    it('rejects missing attribute', () => {
      expect(() => getAttributeSchema.parse({ selector: 'img' })).toThrow();
    });

    it('rejects missing selector', () => {
      expect(() => getAttributeSchema.parse({ attribute: 'src' })).toThrow();
    });
  });

  describe('getLinksSchema', () => {
    it('parses empty object', () => {
      expect(getLinksSchema.parse({})).toEqual({});
    });

    it('accepts selector and baseUrl', () => {
      const result = getLinksSchema.parse({
        selector: 'nav',
        baseUrl: 'https://example.com',
      });
      expect(result.selector).toBe('nav');
      expect(result.baseUrl).toBe('https://example.com');
    });
  });

  describe('querySelectorAllSchema', () => {
    it('parses minimal input', () => {
      expect(querySelectorAllSchema.parse({ selector: 'li' }).selector).toBe('li');
    });

    it('accepts attributes and limit', () => {
      const result = querySelectorAllSchema.parse({
        selector: 'a',
        attributes: ['href', 'title'],
        limit: 10,
      });
      expect(result.attributes).toEqual(['href', 'title']);
      expect(result.limit).toBe(10);
    });

    it('rejects missing selector', () => {
      expect(() => querySelectorAllSchema.parse({})).toThrow();
    });
  });

  describe('extractTableSchema', () => {
    it('parses empty object', () => {
      expect(extractTableSchema.parse({})).toEqual({});
    });

    it('accepts optional selector', () => {
      expect(extractTableSchema.parse({ selector: 'table.data' }).selector).toBe('table.data');
    });
  });

  describe('extractStructuredSchema', () => {
    it('parses valid input', () => {
      const result = extractStructuredSchema.parse({ instruction: 'Extract all product prices' });
      expect(result.instruction).toBe('Extract all product prices');
    });

    it('accepts optional selector', () => {
      const result = extractStructuredSchema.parse({
        instruction: 'Get names',
        selector: '.products',
      });
      expect(result.selector).toBe('.products');
    });

    it('rejects missing instruction', () => {
      expect(() => extractStructuredSchema.parse({})).toThrow();
    });
  });
});

describe('Vision schemas', () => {
  describe('screenshotSchema', () => {
    it('parses empty object', () => {
      expect(screenshotSchema.parse({})).toEqual({});
    });

    it('accepts all options', () => {
      const result = screenshotSchema.parse({
        fullPage: true,
        selector: '#hero',
        quality: 80,
      });
      expect(result.fullPage).toBe(true);
      expect(result.selector).toBe('#hero');
      expect(result.quality).toBe(80);
    });
  });

  describe('screenshotElementSchema', () => {
    it('parses valid input', () => {
      expect(screenshotElementSchema.parse({ selector: '.chart' }).selector).toBe('.chart');
    });

    it('rejects missing selector', () => {
      expect(() => screenshotElementSchema.parse({})).toThrow();
    });
  });

  describe('findByDescriptionSchema', () => {
    it('parses valid input', () => {
      const result = findByDescriptionSchema.parse({ description: 'blue submit button' });
      expect(result.description).toBe('blue submit button');
    });

    it('rejects missing description', () => {
      expect(() => findByDescriptionSchema.parse({})).toThrow();
    });
  });

  describe('clickByDescriptionSchema', () => {
    it('parses with description only', () => {
      const result = clickByDescriptionSchema.parse({ description: 'login button' });
      expect(result.description).toBe('login button');
    });

    it('accepts optional index', () => {
      const result = clickByDescriptionSchema.parse({ description: 'link', index: 2 });
      expect(result.index).toBe(2);
    });

    it('rejects missing description', () => {
      expect(() => clickByDescriptionSchema.parse({})).toThrow();
    });
  });
});

describe('Network schemas', () => {
  describe('interceptRequestSchema', () => {
    it('parses minimal input', () => {
      const result = interceptRequestSchema.parse({
        urlPattern: '**/api/**',
        action: 'block',
      });
      expect(result.urlPattern).toBe('**/api/**');
      expect(result.action).toBe('block');
    });

    it('accepts modify with all sub-fields', () => {
      const input: InterceptRequestInput = {
        urlPattern: '**/graphql',
        action: 'modify',
        modify: {
          headers: { Authorization: 'Bearer xxx' },
          body: '{"query":"{}"}',
          url: 'https://other.com/graphql',
        },
      };
      const result = interceptRequestSchema.parse(input);
      expect(result.modify?.headers?.Authorization).toBe('Bearer xxx');
      expect(result.modify?.body).toBe('{"query":"{}"}');
      expect(result.modify?.url).toBe('https://other.com/graphql');
    });

    it('accepts modify with partial sub-fields', () => {
      const result = interceptRequestSchema.parse({
        urlPattern: '**',
        action: 'modify',
        modify: { headers: { 'X-Custom': 'val' } },
      });
      expect(result.modify?.headers).toEqual({ 'X-Custom': 'val' });
      expect(result.modify?.body).toBeUndefined();
    });

    it('accepts all action values', () => {
      for (const action of ['block', 'modify', 'continue'] as const) {
        expect(interceptRequestSchema.parse({ urlPattern: '*', action }).action).toBe(action);
      }
    });

    it('rejects missing urlPattern', () => {
      expect(() => interceptRequestSchema.parse({ action: 'block' })).toThrow();
    });

    it('rejects missing action', () => {
      expect(() => interceptRequestSchema.parse({ urlPattern: '*' })).toThrow();
    });

    it('rejects invalid action', () => {
      expect(() => interceptRequestSchema.parse({ urlPattern: '*', action: 'redirect' })).toThrow();
    });
  });

  describe('waitForResponseSchema', () => {
    it('parses valid input', () => {
      const result = waitForResponseSchema.parse({ urlPattern: '**/data.json' });
      expect(result.urlPattern).toBe('**/data.json');
    });

    it('accepts optional timeout', () => {
      const result = waitForResponseSchema.parse({ urlPattern: '**', timeout: 10000 });
      expect(result.timeout).toBe(10000);
    });

    it('rejects missing urlPattern', () => {
      expect(() => waitForResponseSchema.parse({})).toThrow();
    });
  });

  describe('blockResourcesSchema', () => {
    it('parses valid input', () => {
      const result = blockResourcesSchema.parse({ types: ['image', 'font'] });
      expect(result.types).toEqual(['image', 'font']);
    });

    it('accepts all resource types', () => {
      const all = ['image', 'stylesheet', 'font', 'media', 'script'] as const;
      expect(blockResourcesSchema.parse({ types: [...all] }).types).toEqual([...all]);
    });

    it('rejects missing types', () => {
      expect(() => blockResourcesSchema.parse({})).toThrow();
    });

    it('rejects invalid resource type', () => {
      expect(() => blockResourcesSchema.parse({ types: ['video'] })).toThrow();
    });
  });

  describe('captureHarSchema', () => {
    it('parses start action', () => {
      expect(captureHarSchema.parse({ action: 'start' }).action).toBe('start');
    });

    it('parses stop with path', () => {
      const result = captureHarSchema.parse({ action: 'stop', path: '/tmp/trace.har' });
      expect(result.action).toBe('stop');
      expect(result.path).toBe('/tmp/trace.har');
    });

    it('rejects missing action', () => {
      expect(() => captureHarSchema.parse({})).toThrow();
    });

    it('rejects invalid action', () => {
      expect(() => captureHarSchema.parse({ action: 'pause' })).toThrow();
    });
  });

  describe('getApiCallsSchema', () => {
    it('parses empty object', () => {
      expect(getApiCallsSchema.parse({})).toEqual({});
    });

    it('accepts urlPattern and method', () => {
      const result = getApiCallsSchema.parse({ urlPattern: '**/api/**', method: 'POST' });
      expect(result.urlPattern).toBe('**/api/**');
      expect(result.method).toBe('POST');
    });
  });
});
