import { code } from '../code.js';

/** `fetch_url`: reads public web pages and JSON, refuses private networks, follows redirects hop by hop. */
export const FETCH_URL_TS = code`
  import { lookup } from 'node:dns/promises';
  import { BlockList, isIP } from 'node:net';
  import { tool } from '@cogitator-ai/core';
  import { z } from 'zod';

  const TIMEOUT_MS = 15_000;
  const MAX_BYTES = 200_000;
  const MAX_REDIRECTS = 5;

  const privateNetworks = new BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
  ] as const) {
    privateNetworks.addSubnet(network, prefix, 'ipv4');
  }
  for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) {
    privateNetworks.addSubnet(network, prefix, 'ipv6');
  }

  /** Whether \`address\` is loopback, link-local, private or otherwise not on the public internet. */
  export function isPrivateAddress(address: string): boolean {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return privateNetworks.check(mapped[1], 'ipv4');
    const family = isIP(address);
    if (family === 0) return true;
    return privateNetworks.check(address, family === 4 ? 'ipv4' : 'ipv6');
  }

  async function assertPublic(url: URL): Promise<void> {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(\`Only http and https URLs can be fetched, not \${url.protocol}\`);
    }
    const host = url.hostname.replace(/^\\[|\\]$/g, '');
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
    const blocked = addresses.find(isPrivateAddress);
    if (blocked) {
      throw new Error(\`\${url.hostname} resolves to \${blocked}, which is not on the public internet\`);
    }
  }

  const ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };

  function decodeEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\\d+|[a-z]+);/gi, (entity, body: string) => {
      if (body[0] === '#') {
        const point = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
        return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
      }
      return ENTITIES[body.toLowerCase()] ?? entity;
    });
  }

  /** The readable text of an HTML page: no scripts, styles or tags, one blank line between blocks. */
  export function htmlToText(html: string): string {
    return decodeEntities(
      html
        .replace(/<(script|style|noscript|svg|template|head)\\b[\\s\\S]*?<\\/\\1>/gi, ' ')
        .replace(/<br\\s*\\/?>|<\\/?(?:p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|main|nav|pre|blockquote)\\b[^>]*>/gi, '\\n')
        .replace(/<[^>]*>/g, ' ')
    )
      .replace(/[ \\t\\f\\v\\u00a0]+/g, ' ')
      .replace(/ *\\n */g, '\\n')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();
  }

  async function readLimited(body: ReadableStream<Uint8Array>): Promise<{ text: string; truncated: boolean }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      while (bytes < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) return { text: text + decoder.decode(), truncated: false };
        const room = MAX_BYTES - bytes;
        bytes += value.byteLength;
        text += decoder.decode(value.byteLength > room ? value.subarray(0, room) : value, { stream: true });
      }
      return { text: text + decoder.decode(), truncated: true };
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  export const fetchUrl = tool({
    name: 'fetch_url',
    description:
      'Fetch a public web page or JSON document over HTTP(S) and return its text. Pages are converted to plain text and cut at 200 kB.',
    parameters: z.object({
      url: z.url({ protocol: /^https?$/ }).describe('The http or https URL to fetch'),
    }),
    sideEffects: ['network'],
    timeout: TIMEOUT_MS + 1_000,
    execute: async ({ url }, { signal }) => {
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
      let target = new URL(url);

      for (let hop = 0; ; hop++) {
        await assertPublic(target);
        const response = await fetch(target, {
          redirect: 'manual',
          signal: timeout,
          headers: { 'user-agent': 'cogitator-agent/1.0', accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5' },
        });

        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location) {
          await response.body?.cancel();
          if (hop >= MAX_REDIRECTS) throw new Error(\`Stopped after \${MAX_REDIRECTS} redirects\`);
          target = new URL(location, target);
          continue;
        }

        const contentType = response.headers.get('content-type') ?? 'unknown';
        const { text, truncated } = response.body ? await readLimited(response.body) : { text: '', truncated: false };
        return {
          url: target.toString(),
          status: response.status,
          contentType,
          truncated,
          content: contentType.includes('html') ? htmlToText(text) : text,
        };
      }
    },
  });
`;

/** `current_time`: the date and time in any IANA time zone. */
export const CURRENT_TIME_TS = code`
  import { tool } from '@cogitator-ai/core';
  import { z } from 'zod';

  function assertTimeZone(timeZone: string): void {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
    } catch {
      throw new Error(\`Unknown time zone "\${timeZone}", use an IANA name such as Europe/Berlin\`);
    }
  }

  export const currentTime = tool({
    name: 'current_time',
    description: 'The current date and time, in UTC and in a given IANA time zone.',
    parameters: z.object({
      timeZone: z
        .string()
        .optional()
        .describe('An IANA time zone such as America/New_York, the local one when left out'),
    }),
    execute: async ({ timeZone }) => {
      const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      assertTimeZone(zone);
      const now = new Date();
      return {
        utc: now.toISOString(),
        timeZone: zone,
        local: new Intl.DateTimeFormat('en-US', {
          timeZone: zone,
          dateStyle: 'full',
          timeStyle: 'long',
        }).format(now),
      };
    },
  });
`;

/** `calculator`: arithmetic through a small parser, never through `eval`. */
export const CALCULATOR_TS = code`
  import { tool } from '@cogitator-ai/core';
  import { z } from 'zod';

  const FUNCTIONS: Record<string, (...args: number[]) => number> = {
    abs: Math.abs,
    ceil: Math.ceil,
    cos: Math.cos,
    exp: Math.exp,
    floor: Math.floor,
    ln: Math.log,
    log: Math.log10,
    max: Math.max,
    min: Math.min,
    round: Math.round,
    sin: Math.sin,
    sqrt: Math.sqrt,
    tan: Math.tan,
  };

  const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

  /**
   * Evaluates \`+ - * / % ^\`, parentheses, the functions in FUNCTIONS and the
   * constants pi and e. Precedence is the usual one, \`^\` is right-associative
   * and binds tighter than a unary minus, so \`-2^2\` is -4. \`%\` is the
   * remainder of a division, never a percentage.
   */
  class Parser {
    private position = 0;

    constructor(private readonly source: string) {}

    parse(): number {
      const value = this.sum();
      this.skipSpace();
      if (this.position < this.source.length) {
        throw new Error(\`Unexpected "\${this.source[this.position]}" at position \${this.position + 1}\`);
      }
      return value;
    }

    private sum(): number {
      let value = this.product();
      for (;;) {
        if (this.take('+')) value += this.product();
        else if (this.take('-')) value -= this.product();
        else return value;
      }
    }

    private product(): number {
      let value = this.unary();
      for (;;) {
        if (this.take('*')) value *= this.unary();
        else if (this.take('/')) {
          const divisor = this.unary();
          if (divisor === 0) throw new Error('Division by zero');
          value /= divisor;
        } else if (this.take('%')) {
          if (!this.startsOperand()) {
            throw new Error(
              \`"%" is the remainder of a division and needs a number after it. For a percentage divide by 100: \${value}% is \${value} / 100\`
            );
          }
          value %= this.unary();
        } else return value;
      }
    }

    private unary(): number {
      if (this.take('-')) return -this.unary();
      if (this.take('+')) return this.unary();
      return this.power();
    }

    private power(): number {
      const base = this.primary();
      return this.take('^') ? base ** this.unary() : base;
    }

    private primary(): number {
      this.skipSpace();
      if (this.take('(')) {
        const value = this.sum();
        this.expect(')');
        return value;
      }

      const number = /^(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?/i.exec(this.rest());
      if (number) {
        this.position += number[0].length;
        return Number(number[0]);
      }

      const name = /^[a-z]+/i.exec(this.rest())?.[0].toLowerCase();
      if (name) {
        this.position += name.length;
        if (name in CONSTANTS) return CONSTANTS[name];
        const fn = FUNCTIONS[name];
        if (!fn) throw new Error(\`Unknown name "\${name}"\`);
        this.expect('(');
        const args = [this.sum()];
        while (this.take(',')) args.push(this.sum());
        this.expect(')');
        return fn(...args);
      }

      throw new Error(
        this.position < this.source.length
          ? \`Unexpected "\${this.source[this.position]}" at position \${this.position + 1}\`
          : 'The expression ends too early'
      );
    }

    private startsOperand(): boolean {
      this.skipSpace();
      return /[\\d.(a-z+-]/i.test(this.source[this.position] ?? '');
    }

    private rest(): string {
      return this.source.slice(this.position);
    }

    private skipSpace(): void {
      while (/\\s/.test(this.source[this.position] ?? '')) this.position++;
    }

    private take(token: string): boolean {
      this.skipSpace();
      if (this.source[this.position] !== token) return false;
      this.position++;
      return true;
    }

    private expect(token: string): void {
      if (!this.take(token)) throw new Error(\`Expected "\${token}" at position \${this.position + 1}\`);
    }
  }

  export function evaluate(expression: string): number {
    const value = new Parser(expression).parse();
    if (!Number.isFinite(value)) throw new Error('The result is not a finite number');
    return value;
  }

  export const calculator = tool({
    name: 'calculator',
    description:
      'Evaluate an arithmetic expression exactly. Supports + - * / ^, % as the remainder of a division (write a percentage as x / 100, so 17.5% of 2480 is 17.5 / 100 * 2480), parentheses, sqrt, abs, round, floor, ceil, min, max, log, ln, exp, sin, cos, tan, pi and e.',
    parameters: z.object({
      expression: z.string().min(1).max(500).describe('For example "(17.5 * 4) / 3 + sqrt(2)"'),
    }),
    execute: async ({ expression }) => ({ expression, result: evaluate(expression) }),
  });
`;

/** Unit tests for the starter tools, runnable offline. */
export const TOOLS_TEST_TS = code`
  import { describe, expect, it } from 'vitest';
  import { evaluate } from '../src/tools/calculator.js';
  import { currentTime } from '../src/tools/current-time.js';
  import { htmlToText, isPrivateAddress } from '../src/tools/fetch-url.js';

  describe('calculator', () => {
    it.each([
      ['1 + 2 * 3', 7],
      ['(1 + 2) * 3', 9],
      ['2 ^ 3 ^ 2', 512],
      ['-2 ^ 2', -4],
      ['sqrt(16) + abs(-3)', 7],
      ['max(1, 5, 3) % 3', 2],
      ['1.5e3 / 3', 500],
    ])('evaluates %s', (expression, expected) => {
      expect(evaluate(expression)).toBe(expected);
    });

    it('rejects what it cannot evaluate', () => {
      expect(() => evaluate('1 / 0')).toThrow('Division by zero');
      expect(() => evaluate('process.exit()')).toThrow();
      expect(() => evaluate('2 +')).toThrow('ends too early');
    });

    it('explains that % is a remainder, not a percentage', () => {
      expect(evaluate('10 % 3')).toBe(1);
      expect(evaluate('10 % -3')).toBe(1);
      expect(() => evaluate('17.5% * 2480')).toThrow('17.5% is 17.5 / 100');
      expect(() => evaluate('20 %')).toThrow('remainder of a division');
    });
  });

  describe('current_time', () => {
    it('answers in the requested time zone', async () => {
      const result = await currentTime.execute(
        { timeZone: 'Asia/Tokyo' },
        { agentId: 'test', runId: 'test', signal: new AbortController().signal }
      );
      expect(result.timeZone).toBe('Asia/Tokyo');
    });

    it('refuses an unknown time zone', async () => {
      await expect(
        currentTime.execute(
          { timeZone: 'Mars/Olympus' },
          { agentId: 'test', runId: 'test', signal: new AbortController().signal }
        )
      ).rejects.toThrow('Unknown time zone');
    });
  });

  describe('fetch_url', () => {
    it('keeps away from private networks', () => {
      for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1']) {
        expect(isPrivateAddress(address), address).toBe(true);
      }
      expect(isPrivateAddress('93.184.216.34')).toBe(false);
    });

    it('turns HTML into readable text', () => {
      const html = '<html><head><title>x</title><style>p{}</style></head><body><h1>Hello &amp; welcome</h1><p>One<br>Two</p><script>alert(1)</script></body></html>';
      expect(htmlToText(html)).toBe('Hello & welcome\\n\\nOne\\nTwo');
    });
  });
`;
