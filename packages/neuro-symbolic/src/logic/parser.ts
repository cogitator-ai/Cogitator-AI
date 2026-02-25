import type { Term, CompoundTerm, Clause, ListTerm } from '@cogitator-ai/types';

export interface ParseError {
  message: string;
  position: number;
  line: number;
  column: number;
}

export interface ParseResult<T> {
  success: boolean;
  value?: T;
  error?: ParseError;
}

type Token =
  | { type: 'atom'; value: string }
  | { type: 'variable'; value: string }
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'operator'; value: string }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'lbracket' }
  | { type: 'rbracket' }
  | { type: 'comma' }
  | { type: 'period' }
  | { type: 'pipe' }
  | { type: 'neck' }
  | { type: 'cut' }
  | { type: 'eof' };

class Lexer {
  private pos = 0;
  private line = 1;
  private column = 1;

  constructor(private input: string) {}

  private peek(): string {
    return this.input[this.pos] || '';
  }

  private advance(): string {
    const ch = this.input[this.pos++];
    if (ch === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return ch;
  }

  private skipWhitespaceAndComments(): void {
    while (this.pos < this.input.length) {
      const ch = this.peek();

      if (/\s/.test(ch)) {
        this.advance();
        continue;
      }

      if (ch === '%') {
        while (this.pos < this.input.length && this.peek() !== '\n') {
          this.advance();
        }
        continue;
      }

      if (ch === '/' && this.input[this.pos + 1] === '*') {
        this.advance();
        this.advance();
        while (this.pos < this.input.length) {
          if (
            this.peek() === '*' &&
            this.pos + 1 < this.input.length &&
            this.input[this.pos + 1] === '/'
          ) {
            this.advance();
            this.advance();
            break;
          }
          this.advance();
        }
        continue;
      }

      break;
    }
  }

  private readString(quote: string): string {
    let value = '';
    const startLine = this.line;
    this.advance();

    while (this.pos < this.input.length && this.peek() !== quote) {
      if (this.peek() === '\\') {
        this.advance();
        const escaped = this.advance();
        switch (escaped) {
          case 'n':
            value += '\n';
            break;
          case 't':
            value += '\t';
            break;
          case 'r':
            value += '\r';
            break;
          case '\\':
            value += '\\';
            break;
          case "'":
            value += "'";
            break;
          case '"':
            value += '"';
            break;
          default:
            value += escaped;
        }
      } else {
        value += this.advance();
      }
    }

    if (this.pos >= this.input.length || this.peek() !== quote) {
      throw new Error(`Unterminated string starting at line ${startLine}`);
    }

    this.advance();

    return value;
  }

  private readNumber(): number {
    let numStr = '';
    let hasDecimal = false;

    if (this.peek() === '-') {
      numStr += this.advance();
    }

    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (/\d/.test(ch)) {
        numStr += this.advance();
      } else if (ch === '.' && !hasDecimal && /\d/.test(this.input[this.pos + 1] || '')) {
        hasDecimal = true;
        numStr += this.advance();
      } else {
        break;
      }
    }

    return parseFloat(numStr);
  }

  private readIdentifier(): string {
    let value = '';
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (/[a-zA-Z0-9_]/.test(ch)) {
        value += this.advance();
      } else {
        break;
      }
    }
    return value;
  }

  nextToken(): Token {
    this.skipWhitespaceAndComments();

    if (this.pos >= this.input.length) {
      return { type: 'eof' };
    }

    const ch = this.peek();

    if (ch === '(') {
      this.advance();
      return { type: 'lparen' };
    }
    if (ch === ')') {
      this.advance();
      return { type: 'rparen' };
    }
    if (ch === '[') {
      this.advance();
      return { type: 'lbracket' };
    }
    if (ch === ']') {
      this.advance();
      return { type: 'rbracket' };
    }
    if (ch === ',') {
      this.advance();
      return { type: 'comma' };
    }
    if (ch === '.') {
      this.advance();
      return { type: 'period' };
    }
    if (ch === '|') {
      this.advance();
      return { type: 'pipe' };
    }
    if (ch === '!') {
      this.advance();
      return { type: 'cut' };
    }

    if (ch === ':' && this.input[this.pos + 1] === '-') {
      this.advance();
      this.advance();
      return { type: 'neck' };
    }

    if (this.isOperatorStart(ch)) {
      return this.readOperator();
    }

    if (ch === '"' || ch === "'") {
      const value = this.readString(ch);
      if (ch === "'") {
        return { type: 'atom', value };
      }
      return { type: 'string', value };
    }

    if (/\d/.test(ch)) {
      return { type: 'number', value: this.readNumber() };
    }

    if (/[A-Z_]/.test(ch)) {
      const value = this.readIdentifier();
      return { type: 'variable', value };
    }

    if (/[a-z]/.test(ch)) {
      const value = this.readIdentifier();
      return { type: 'atom', value };
    }

    throw new Error(`Unexpected character '${ch}' at line ${this.line}, column ${this.column}`);
  }

  private static readonly OP_START_CHARS = new Set('=<>\\+-*/@#^');

  private isOperatorStart(ch: string): boolean {
    return Lexer.OP_START_CHARS.has(ch);
  }

  private static readonly MULTI_CHAR_OPS = [
    '=:=',
    '=\\=',
    '=..',
    '\\==',
    '\\+',
    '\\=',
    '==',
    '>=',
    '=<',
    '->',
    '**',
    '//',
    '@<',
    '@>',
  ];

  private readOperator(): Token {
    const start = this.pos;

    let best = '';
    for (const op of Lexer.MULTI_CHAR_OPS) {
      if (this.input.startsWith(op, this.pos) && op.length > best.length) {
        best = op;
      }
    }

    if (best) {
      let remaining = best.length;
      while (remaining-- > 0) this.advance();
      return { type: 'operator', value: best };
    }

    const ch = this.advance();
    if ('=<>+\\-*/@#^'.includes(ch)) {
      return { type: 'operator', value: ch };
    }

    throw new Error(
      `Unexpected character '${ch}' at line ${this.line}, column ${this.column} (pos ${start})`
    );
  }

  getPosition(): { line: number; column: number; pos: number } {
    return { line: this.line, column: this.column, pos: this.pos };
  }
}

class Parser {
  private currentToken: Token;
  private lexer: Lexer;

  constructor(input: string) {
    this.lexer = new Lexer(input);
    this.currentToken = this.lexer.nextToken();
  }

  private advance(): Token {
    const token = this.currentToken;
    this.currentToken = this.lexer.nextToken();
    return token;
  }

  private expect(type: Token['type']): Token {
    if (this.currentToken.type !== type) {
      const pos = this.lexer.getPosition();
      throw new Error(`Expected ${type} but got ${this.currentToken.type} at line ${pos.line}`);
    }
    return this.advance();
  }

  private static readonly OPERATOR_PRECEDENCE: Record<string, number> = {
    ';': 1100,
    '->': 1050,
    '=': 700,
    '\\=': 700,
    '==': 700,
    '\\==': 700,
    is: 700,
    '=:=': 700,
    '=\\=': 700,
    '<': 700,
    '>': 700,
    '>=': 700,
    '=<': 700,
    '@<': 700,
    '@>': 700,
    '=..': 700,
    '+': 500,
    '-': 500,
    '*': 400,
    '/': 400,
    '//': 400,
    mod: 400,
    rem: 400,
    '**': 200,
    '^': 200,
  };

  private static readonly RIGHT_ASSOC = new Set(['**', '^']);

  private static readonly OPERATOR_ATOMS = new Set(['is', 'mod', 'rem']);

  private getOperator(): { value: string; prec: number } | null {
    if (this.currentToken.type === 'operator') {
      const val = this.currentToken.value;
      const prec = Parser.OPERATOR_PRECEDENCE[val];
      if (prec !== undefined) return { value: val, prec };
    }
    if (this.currentToken.type === 'atom' && Parser.OPERATOR_ATOMS.has(this.currentToken.value)) {
      const val = this.currentToken.value;
      const prec = Parser.OPERATOR_PRECEDENCE[val];
      if (prec !== undefined) return { value: val, prec };
    }
    return null;
  }

  private parseExpression(minPrec: number): Term {
    let left = this.parsePrimary();

    for (;;) {
      const op = this.getOperator();
      if (!op || op.prec < minPrec) break;

      this.advance();
      const nextMinPrec = Parser.RIGHT_ASSOC.has(op.value) ? op.prec : op.prec + 1;
      const right = this.parseExpression(nextMinPrec);
      left = { type: 'compound', functor: op.value, args: [left, right] };
    }

    return left;
  }

  parseTerm(): Term {
    return this.parseExpression(0);
  }

  private parsePrimary(): Term {
    const token = this.currentToken;

    if (token.type === 'operator' && (token.value === '-' || token.value === '+')) {
      this.advance();
      const inner = this.parsePrimary();
      if (token.value === '+') return inner;
      if (inner.type === 'number') return { type: 'number', value: -inner.value };
      return { type: 'compound', functor: '-', args: [inner] };
    }

    if (token.type === 'operator' && token.value === '\\+') {
      this.advance();
      const inner = this.parsePrimary();
      return { type: 'compound', functor: '\\+', args: [inner] };
    }

    if (token.type === 'atom') {
      this.advance();
      if (this.currentToken.type === 'lparen') {
        return this.parseCompound(token.value);
      }
      return { type: 'atom', value: token.value };
    }

    if (token.type === 'variable') {
      this.advance();
      if (token.value === '_') {
        return { type: 'variable', name: `_G${Math.random().toString(36).slice(2, 8)}` };
      }
      return { type: 'variable', name: token.value };
    }

    if (token.type === 'number') {
      this.advance();
      return { type: 'number', value: token.value };
    }

    if (token.type === 'string') {
      this.advance();
      return { type: 'string', value: token.value };
    }

    if (token.type === 'lbracket') {
      return this.parseList();
    }

    if (token.type === 'cut') {
      this.advance();
      return { type: 'atom', value: '!' };
    }

    if (token.type === 'lparen') {
      this.advance();
      const term = this.parseExpression(0);
      this.expect('rparen');
      return term;
    }

    const pos = this.lexer.getPosition();
    throw new Error(`Unexpected token ${token.type} at line ${pos.line}`);
  }

  private parseCompound(functor: string): CompoundTerm {
    this.expect('lparen');
    const args: Term[] = [];

    if (this.currentToken.type !== 'rparen') {
      args.push(this.parseTerm());
      while (this.currentToken.type === 'comma') {
        this.advance();
        args.push(this.parseTerm());
      }
    }

    this.expect('rparen');
    return { type: 'compound', functor, args };
  }

  private parseList(): ListTerm {
    this.expect('lbracket');

    if (this.currentToken.type === 'rbracket') {
      this.advance();
      return { type: 'list', elements: [] };
    }

    const elements: Term[] = [];
    elements.push(this.parseTerm());

    while (this.currentToken.type === 'comma') {
      this.advance();
      elements.push(this.parseTerm());
    }

    let tail: Term | undefined;
    if (this.currentToken.type === 'pipe') {
      this.advance();
      tail = this.parseTerm();
    }

    this.expect('rbracket');
    return { type: 'list', elements, tail };
  }

  parseClause(): Clause {
    const head = this.parseTerm();

    if (head.type !== 'compound' && head.type !== 'atom') {
      throw new Error('Clause head must be an atom or compound term');
    }

    const compoundHead: CompoundTerm =
      head.type === 'atom' ? { type: 'compound', functor: head.value, args: [] } : head;

    let body: CompoundTerm[] = [];

    if (this.currentToken.type === 'neck') {
      this.advance();
      body = this.parseBody();
    }

    this.expect('period');

    return { head: compoundHead, body };
  }

  private parseBody(): CompoundTerm[] {
    const goals: CompoundTerm[] = [];

    const goal = this.parseGoal();
    goals.push(goal);

    while (this.currentToken.type === 'comma') {
      this.advance();
      goals.push(this.parseGoal());
    }

    return goals;
  }

  private parseGoal(): CompoundTerm {
    const term = this.parseTerm();

    if (term.type === 'atom') {
      return { type: 'compound', functor: term.value, args: [] };
    }

    if (term.type !== 'compound') {
      throw new Error('Goal must be an atom or compound term');
    }

    return term;
  }

  parseProgram(): Clause[] {
    const clauses: Clause[] = [];

    while (this.currentToken.type !== 'eof') {
      clauses.push(this.parseClause());
    }

    return clauses;
  }

  parseQuery(): CompoundTerm[] {
    return this.parseBody();
  }
}

export function parseTerm(input: string): ParseResult<Term> {
  try {
    const parser = new Parser(input);
    const term = parser.parseTerm();
    return { success: true, value: term };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : String(e),
        position: 0,
        line: 1,
        column: 1,
      },
    };
  }
}

export function parseClause(input: string): ParseResult<Clause> {
  try {
    const parser = new Parser(input);
    const clause = parser.parseClause();
    return { success: true, value: clause };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : String(e),
        position: 0,
        line: 1,
        column: 1,
      },
    };
  }
}

export function parseProgram(input: string): ParseResult<Clause[]> {
  try {
    const parser = new Parser(input);
    const clauses = parser.parseProgram();
    return { success: true, value: clauses };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : String(e),
        position: 0,
        line: 1,
        column: 1,
      },
    };
  }
}

export function parseQuery(input: string): ParseResult<CompoundTerm[]> {
  try {
    const parser = new Parser(input);
    const goals = parser.parseQuery();
    return { success: true, value: goals };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : String(e),
        position: 0,
        line: 1,
        column: 1,
      },
    };
  }
}

export function termFromValue(value: unknown): Term {
  if (value === null || value === undefined) {
    return { type: 'atom', value: 'nil' };
  }

  if (typeof value === 'number') {
    return { type: 'number', value };
  }

  if (typeof value === 'string') {
    if (/^[a-z][a-zA-Z0-9_]*$/.test(value)) {
      return { type: 'atom', value };
    }
    return { type: 'string', value };
  }

  if (typeof value === 'boolean') {
    return { type: 'atom', value: value ? 'true' : 'false' };
  }

  if (Array.isArray(value)) {
    return {
      type: 'list',
      elements: value.map(termFromValue),
    };
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([key]) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
    );
    return {
      type: 'list',
      elements: entries.map(([k, v]) => ({
        type: 'compound' as const,
        functor: '=',
        args: [termFromValue(k), termFromValue(v)],
      })),
    };
  }

  return { type: 'atom', value: String(value) };
}

export function termToValue(term: Term): unknown {
  switch (term.type) {
    case 'atom':
      if (term.value === 'true') return true;
      if (term.value === 'false') return false;
      if (term.value === 'nil') return null;
      return term.value;
    case 'number':
      return term.value;
    case 'string':
      return term.value;
    case 'variable':
      return `?${term.name}`;
    case 'list':
      return term.elements.map(termToValue);
    case 'compound':
      if (term.functor === '=' && term.args.length === 2) {
        const key = termToValue(term.args[0]);
        const value = termToValue(term.args[1]);
        return { [String(key)]: value };
      }
      return {
        functor: term.functor,
        args: term.args.map(termToValue),
      };
  }
}
