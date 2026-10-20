/**
 * Reads a Python literal (the `repr` of dicts, lists, tuples, strings, numbers, `True`, `False`
 * and `None`) into a JSON value. BEAM stores its probing questions this way, not as JSON.
 */
export function parsePythonLiteral(text: string): unknown {
  const parser = new LiteralParser(text);
  const value = parser.value();
  parser.end();
  return value;
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  a: '\x07',
  '0': '\0',
  '\\': '\\',
  "'": "'",
  '"': '"',
};

class LiteralParser {
  private index = 0;

  constructor(private readonly text: string) {}

  value(): unknown {
    this.skipSpace();
    const char = this.text[this.index];
    if (char === '{') return this.dict();
    if (char === '[') return this.sequence('[', ']');
    if (char === '(') return this.sequence('(', ')');
    if (char === "'" || char === '"') return this.strings();
    if (this.text.startsWith('True', this.index)) return this.keyword('True', true);
    if (this.text.startsWith('False', this.index)) return this.keyword('False', false);
    if (this.text.startsWith('None', this.index)) return this.keyword('None', null);
    return this.number();
  }

  end(): void {
    this.skipSpace();
    if (this.index < this.text.length) this.fail('unexpected text after the value');
  }

  private dict(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    this.index++;
    for (;;) {
      this.skipSpace();
      if (this.text[this.index] === '}') {
        this.index++;
        return result;
      }
      const key = this.value();
      this.skipSpace();
      this.expect(':');
      Object.defineProperty(result, String(key), {
        value: this.value(),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skipSpace();
      if (this.text[this.index] === ',') this.index++;
      else if (this.text[this.index] !== '}') this.fail("expected ',' or '}'");
    }
  }

  private sequence(open: string, close: string): unknown[] {
    const result: unknown[] = [];
    this.expect(open);
    for (;;) {
      this.skipSpace();
      if (this.text[this.index] === close) {
        this.index++;
        return result;
      }
      result.push(this.value());
      this.skipSpace();
      if (this.text[this.index] === ',') this.index++;
      else if (this.text[this.index] !== close) this.fail(`expected ',' or '${close}'`);
    }
  }

  private strings(): string {
    let result = this.string();
    for (;;) {
      const save = this.index;
      this.skipSpace();
      const char = this.text[this.index];
      if (char !== "'" && char !== '"') {
        this.index = save;
        return result;
      }
      result += this.string();
    }
  }

  private string(): string {
    const quote = this.text[this.index];
    const triple = this.text.startsWith(quote.repeat(3), this.index);
    const delimiter = triple ? quote.repeat(3) : quote;
    this.index += delimiter.length;
    let result = '';
    while (this.index < this.text.length) {
      if (this.text.startsWith(delimiter, this.index)) {
        this.index += delimiter.length;
        return result;
      }
      const char = this.text[this.index];
      if (char === '\\') {
        result += this.escape();
        continue;
      }
      result += char;
      this.index++;
    }
    return this.fail('unterminated string');
  }

  private escape(): string {
    const next = this.text[this.index + 1];
    if (next === 'x' || next === 'u' || next === 'U') {
      const length = next === 'x' ? 2 : next === 'u' ? 4 : 8;
      const hex = this.text.slice(this.index + 2, this.index + 2 + length);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== length) this.fail('bad escape');
      this.index += 2 + length;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    if (next === '\n') {
      this.index += 2;
      return '';
    }
    const mapped = next === undefined ? undefined : ESCAPES[next];
    this.index += 2;
    return mapped ?? `\\${next ?? ''}`;
  }

  private number(): number {
    const match = /^-?(?:\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+)/.exec(this.text.slice(this.index));
    if (!match) return this.fail('unexpected character');
    this.index += match[0].length;
    return Number(match[0]);
  }

  private keyword<T>(word: string, value: T): T {
    this.index += word.length;
    return value;
  }

  private expect(char: string): void {
    if (this.text[this.index] !== char) this.fail(`expected '${char}'`);
    this.index++;
  }

  private skipSpace(): void {
    while (this.index < this.text.length && /\s/.test(this.text[this.index])) this.index++;
  }

  private fail(reason: string): never {
    throw new Error(`Python literal: ${reason} at ${this.index}`);
  }
}
