export type InfixOperatorType = 'xfx' | 'xfy' | 'yfx';
export type PrefixOperatorType = 'fy' | 'fx';

export interface InfixOperator {
  priority: number;
  type: InfixOperatorType;
}

export interface PrefixOperator {
  priority: number;
  type: PrefixOperatorType;
}

export const MAX_PRIORITY = 1200;
export const ARGUMENT_PRIORITY = 999;

const comparison = (): InfixOperator => ({ priority: 700, type: 'xfx' });
const additive = (): InfixOperator => ({ priority: 500, type: 'yfx' });
const multiplicative = (): InfixOperator => ({ priority: 400, type: 'yfx' });

export const INFIX_OPERATORS: ReadonlyMap<string, InfixOperator> = new Map<string, InfixOperator>([
  [':-', { priority: 1200, type: 'xfx' }],
  [';', { priority: 1100, type: 'xfy' }],
  ['->', { priority: 1050, type: 'xfy' }],
  [',', { priority: 1000, type: 'xfy' }],
  ['=', comparison()],
  ['\\=', comparison()],
  ['==', comparison()],
  ['\\==', comparison()],
  ['@<', comparison()],
  ['@>', comparison()],
  ['@=<', comparison()],
  ['@>=', comparison()],
  ['=..', comparison()],
  ['is', comparison()],
  ['=:=', comparison()],
  ['=\\=', comparison()],
  ['<', comparison()],
  ['>', comparison()],
  ['=<', comparison()],
  ['>=', comparison()],
  ['+', additive()],
  ['-', additive()],
  ['/\\', additive()],
  ['\\/', additive()],
  ['xor', additive()],
  ['*', multiplicative()],
  ['/', multiplicative()],
  ['//', multiplicative()],
  ['mod', multiplicative()],
  ['rem', multiplicative()],
  ['div', multiplicative()],
  ['<<', multiplicative()],
  ['>>', multiplicative()],
  ['**', { priority: 200, type: 'xfx' }],
  ['^', { priority: 200, type: 'xfy' }],
]);

export const PREFIX_OPERATORS: ReadonlyMap<string, PrefixOperator> = new Map<
  string,
  PrefixOperator
>([
  ['\\+', { priority: 900, type: 'fy' }],
  ['-', { priority: 200, type: 'fy' }],
  ['+', { priority: 200, type: 'fy' }],
  ['\\', { priority: 200, type: 'fy' }],
]);

const SOLO_ATOMS = new Set(['[]', '!', ';', '{}', ',', '|']);
const PLAIN_ATOM = /^[a-z][a-zA-Z0-9_]*$/;
const SYMBOL_ATOM = /^[+\-*/\\^<>=~:.?@#&$]+$/;

export function atomNeedsQuotes(name: string): boolean {
  if (PLAIN_ATOM.test(name)) return false;
  if (SOLO_ATOMS.has(name) && name !== ',' && name !== '|') return false;
  if (SYMBOL_ATOM.test(name)) return false;
  return true;
}

export function escapeQuoted(value: string, quote: '"' | "'"): string {
  let escaped = '';
  for (const ch of value) {
    switch (ch) {
      case '\\':
        escaped += '\\\\';
        break;
      case '\n':
        escaped += '\\n';
        break;
      case '\t':
        escaped += '\\t';
        break;
      case '\r':
        escaped += '\\r';
        break;
      default:
        escaped += ch === quote ? `\\${quote}` : ch;
    }
  }
  return escaped;
}

export function formatAtom(name: string): string {
  return atomNeedsQuotes(name) ? `'${escapeQuoted(name, "'")}'` : name;
}
