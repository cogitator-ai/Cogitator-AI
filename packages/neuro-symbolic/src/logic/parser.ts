import type { Term, CompoundTerm, Clause, ListTerm } from '@cogitator-ai/types';
import { INFIX_OPERATORS, PREFIX_OPERATORS, MAX_PRIORITY, ARGUMENT_PRIORITY } from './operators';

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

interface SourcePosition {
  position: number;
  line: number;
  column: number;
}

class PrologSyntaxError extends Error {
  readonly location: SourcePosition;

  constructor(message: string, at: SourcePosition) {
    super(`${message} at line ${at.line}, column ${at.column}`);
    this.name = 'PrologSyntaxError';
    this.location = { position: at.position, line: at.line, column: at.column };
  }
}

type TokenKind =
  | 'atom'
  | 'variable'
  | 'number'
  | 'string'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'comma'
  | 'pipe'
  | 'end'
  | 'eof';

interface Token extends SourcePosition {
  kind: TokenKind;
  text: string;
  numberValue?: number;
  end: number;
}

const SYMBOL_CHARS = new Set('+-*/\\^<>=~:.?@#&$');

function isLayout(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isAlnum(ch: string): boolean {
  return /^[a-zA-Z0-9_]$/.test(ch);
}

class Lexer {
  private pos = 0;
  private line = 1;
  private column = 1;

  constructor(private readonly input: string) {}

  private peek(offset = 0): string {
    return this.input[this.pos + offset] ?? '';
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

  private location(): SourcePosition {
    return { position: this.pos, line: this.line, column: this.column };
  }

  private skipLayoutAndComments(): void {
    while (this.pos < this.input.length) {
      const ch = this.peek();

      if (isLayout(ch)) {
        this.advance();
        continue;
      }

      if (ch === '%') {
        while (this.pos < this.input.length && this.peek() !== '\n') this.advance();
        continue;
      }

      if (ch === '/' && this.peek(1) === '*') {
        const start = this.location();
        this.advance();
        this.advance();
        let closed = false;
        while (this.pos < this.input.length) {
          if (this.peek() === '*' && this.peek(1) === '/') {
            this.advance();
            this.advance();
            closed = true;
            break;
          }
          this.advance();
        }
        if (!closed) throw new PrologSyntaxError('Unterminated block comment', start);
        continue;
      }

      break;
    }
  }

  private readQuoted(quote: string): string {
    const start = this.location();
    let value = '';
    this.advance();

    for (;;) {
      if (this.pos >= this.input.length) {
        throw new PrologSyntaxError(`Unterminated string starting`, start);
      }

      const ch = this.advance();

      if (ch === quote) {
        if (this.peek() === quote) {
          this.advance();
          value += quote;
          continue;
        }
        return value;
      }

      if (ch !== '\\') {
        value += ch;
        continue;
      }

      if (this.pos >= this.input.length) {
        throw new PrologSyntaxError(`Unterminated string starting`, start);
      }

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
        case '0':
          value += '\0';
          break;
        case '\n':
          break;
        default:
          value += escaped;
      }
    }
  }

  private readNumber(): number {
    let text = '';
    while (isDigit(this.peek())) text += this.advance();

    if (this.peek() === '.' && isDigit(this.peek(1))) {
      text += this.advance();
      while (isDigit(this.peek())) text += this.advance();
    }

    const expSign = this.peek(1) === '+' || this.peek(1) === '-';
    if (
      (this.peek() === 'e' || this.peek() === 'E') &&
      (isDigit(this.peek(1)) || (expSign && isDigit(this.peek(2))))
    ) {
      text += this.advance();
      if (expSign) text += this.advance();
      while (isDigit(this.peek())) text += this.advance();
    }

    return Number(text);
  }

  private readWhile(predicate: (ch: string) => boolean): string {
    let value = '';
    while (this.pos < this.input.length && predicate(this.peek())) value += this.advance();
    return value;
  }

  nextToken(): Token {
    this.skipLayoutAndComments();
    const start = this.location();
    const make = (kind: TokenKind, text: string, numberValue?: number): Token => ({
      kind,
      text,
      numberValue,
      ...start,
      end: this.pos,
    });

    if (this.pos >= this.input.length) return make('eof', '');

    const ch = this.peek();

    switch (ch) {
      case '(':
        this.advance();
        return make('lparen', '(');
      case ')':
        this.advance();
        return make('rparen', ')');
      case '[':
        this.advance();
        return make('lbracket', '[');
      case ']':
        this.advance();
        return make('rbracket', ']');
      case ',':
        this.advance();
        return make('comma', ',');
      case '|':
        this.advance();
        return make('pipe', '|');
      case '!':
      case ';':
        this.advance();
        return make('atom', ch);
    }

    if (ch === '.') {
      const next = this.peek(1);
      if (next === '' || isLayout(next) || next === '%') {
        this.advance();
        return make('end', '.');
      }
    }

    if (ch === '"') return make('string', this.readQuoted('"'));
    if (ch === "'") return make('atom', this.readQuoted("'"));

    if (isDigit(ch)) {
      const value = this.readNumber();
      return make('number', String(value), value);
    }

    if (/[A-Z_]/.test(ch)) return make('variable', this.readWhile(isAlnum));
    if (/[a-z]/.test(ch)) return make('atom', this.readWhile(isAlnum));

    if (SYMBOL_CHARS.has(ch)) {
      const symbol = this.readWhile((c) => SYMBOL_CHARS.has(c));
      return make('atom', symbol);
    }

    throw new PrologSyntaxError(`Unexpected character '${ch}'`, start);
  }
}

interface Parsed {
  term: Term;
  priority: number;
}

const TERM_TERMINATORS = new Set<TokenKind>(['rparen', 'rbracket', 'comma', 'pipe', 'end', 'eof']);

class Parser {
  private readonly lexer: Lexer;
  private current: Token;
  private lookahead: Token;
  private anonVarCounter = 0;

  constructor(input: string) {
    this.lexer = new Lexer(input);
    this.current = this.lexer.nextToken();
    this.lookahead = this.current.kind === 'eof' ? this.current : this.lexer.nextToken();
  }

  private advance(): Token {
    const token = this.current;
    this.current = this.lookahead;
    this.lookahead = this.current.kind === 'eof' ? this.current : this.lexer.nextToken();
    return token;
  }

  private fail(message: string, token: Token = this.current): never {
    throw new PrologSyntaxError(message, token);
  }

  private describe(token: Token): string {
    return token.kind === 'eof' ? 'end of input' : `'${token.text}'`;
  }

  private expect(kind: TokenKind, what: string): Token {
    if (this.current.kind !== kind) {
      this.fail(`Expected ${what} but found ${this.describe(this.current)}`);
    }
    return this.advance();
  }

  private isFunctionalNotation(): boolean {
    return this.lookahead.kind === 'lparen' && this.lookahead.position === this.current.end;
  }

  private infixOperatorName(): string | null {
    if (this.current.kind === 'comma') return ',';
    if (this.current.kind === 'atom' && INFIX_OPERATORS.has(this.current.text)) {
      return this.current.text;
    }
    return null;
  }

  parse(maxPriority: number): Term {
    return this.parseExpression(maxPriority).term;
  }

  private parseExpression(maxPriority: number): Parsed {
    let left = this.parsePrimary(maxPriority);

    for (;;) {
      const name = this.infixOperatorName();
      if (name === null) break;

      const op = INFIX_OPERATORS.get(name)!;
      if (op.priority > maxPriority) break;

      const leftMax = op.type === 'yfx' ? op.priority : op.priority - 1;
      if (left.priority > leftMax) break;

      const rightMax = op.type === 'xfy' ? op.priority : op.priority - 1;
      this.advance();
      const right = this.parseExpression(rightMax);
      left = {
        term: { type: 'compound', functor: name, args: [left.term, right.term] },
        priority: op.priority,
      };
    }

    return left;
  }

  private parsePrimary(maxPriority: number): Parsed {
    const token = this.current;

    switch (token.kind) {
      case 'number':
        this.advance();
        return { term: { type: 'number', value: token.numberValue! }, priority: 0 };

      case 'string':
        this.advance();
        return { term: { type: 'string', value: token.text }, priority: 0 };

      case 'variable':
        this.advance();
        if (token.text === '_') {
          return { term: { type: 'variable', name: `_G${this.anonVarCounter++}` }, priority: 0 };
        }
        return { term: { type: 'variable', name: token.text }, priority: 0 };

      case 'lparen': {
        this.advance();
        const term = this.parse(MAX_PRIORITY);
        this.expect('rparen', "')'");
        return { term, priority: 0 };
      }

      case 'lbracket':
        return { term: this.parseList(), priority: 0 };

      case 'atom':
        return this.parseAtomStart(maxPriority);

      default:
        return this.fail(`Unexpected ${this.describe(token)}`);
    }
  }

  private parseAtomStart(maxPriority: number): Parsed {
    const token = this.current;
    const name = token.text;

    if (this.isFunctionalNotation()) {
      this.advance();
      return { term: this.parseArguments(name), priority: 0 };
    }

    const prefix = PREFIX_OPERATORS.get(name);
    if (prefix) {
      if (
        (name === '-' || name === '+') &&
        this.lookahead.kind === 'number' &&
        this.lookahead.position === token.end
      ) {
        this.advance();
        const number = this.advance();
        const value = name === '-' ? -number.numberValue! : number.numberValue!;
        return { term: { type: 'number', value }, priority: 0 };
      }

      const nextIsInfix =
        this.lookahead.kind === 'atom' &&
        INFIX_OPERATORS.has(this.lookahead.text) &&
        !PREFIX_OPERATORS.has(this.lookahead.text);

      if (!TERM_TERMINATORS.has(this.lookahead.kind) && !nextIsInfix) {
        const priority = Math.min(prefix.priority, maxPriority);
        const argMax = prefix.type === 'fy' ? priority : priority - 1;
        this.advance();
        const operand = this.parseExpression(argMax);
        if (name === '+' && operand.term.type === 'number') {
          return { term: operand.term, priority };
        }
        return {
          term: { type: 'compound', functor: name, args: [operand.term] },
          priority,
        };
      }
    }

    this.advance();
    return { term: { type: 'atom', value: name }, priority: 0 };
  }

  private parseArguments(functor: string): CompoundTerm {
    this.expect('lparen', "'('");
    const args: Term[] = [this.parse(ARGUMENT_PRIORITY)];
    while (this.current.kind === 'comma') {
      this.advance();
      args.push(this.parse(ARGUMENT_PRIORITY));
    }
    this.expect('rparen', "')' or ','");
    return { type: 'compound', functor, args };
  }

  private parseList(): ListTerm {
    this.expect('lbracket', "'['");

    if (this.current.kind === 'rbracket') {
      this.advance();
      return { type: 'list', elements: [] };
    }

    const elements: Term[] = [this.parse(ARGUMENT_PRIORITY)];
    while (this.current.kind === 'comma') {
      this.advance();
      elements.push(this.parse(ARGUMENT_PRIORITY));
    }

    let tail: Term | undefined;
    if (this.current.kind === 'pipe') {
      this.advance();
      tail = this.parse(ARGUMENT_PRIORITY);
    }

    this.expect('rbracket', "']'");
    return tail ? { type: 'list', elements, tail } : { type: 'list', elements };
  }

  private toGoal(term: Term, token: Token): CompoundTerm {
    switch (term.type) {
      case 'compound':
        return term;
      case 'atom':
        return { type: 'compound', functor: term.value, args: [] };
      case 'variable':
        return { type: 'compound', functor: 'call', args: [term] };
      default:
        return this.fail('Goal must be callable (atom, compound term or variable)', token);
    }
  }

  private flattenConjunction(term: Term, token: Token): CompoundTerm[] {
    if (term.type === 'compound' && term.functor === ',' && term.args.length === 2) {
      return [
        ...this.flattenConjunction(term.args[0], token),
        ...this.flattenConjunction(term.args[1], token),
      ];
    }
    return [this.toGoal(term, token)];
  }

  parseClause(): Clause {
    const start = this.current;
    const term = this.parse(MAX_PRIORITY);
    this.expect('end', "'.' at end of clause");

    if (term.type === 'compound' && term.functor === ':-' && term.args.length === 2) {
      return {
        head: this.toHead(term.args[0], start),
        body: this.flattenConjunction(term.args[1], start),
      };
    }

    return { head: this.toHead(term, start), body: [] };
  }

  private toHead(term: Term, token: Token): CompoundTerm {
    if (term.type === 'atom') return { type: 'compound', functor: term.value, args: [] };
    if (term.type === 'compound' && !(term.functor === ':-' && term.args.length === 2)) {
      return term;
    }
    return this.fail('Clause head must be an atom or compound term', token);
  }

  parseProgram(): Clause[] {
    const clauses: Clause[] = [];
    while (this.current.kind !== 'eof') {
      clauses.push(this.parseClause());
    }
    return clauses;
  }

  parseQuery(): CompoundTerm[] {
    if (this.current.kind === 'atom' && this.current.text === '?-') {
      this.advance();
    }

    const start = this.current;
    const term = this.parse(MAX_PRIORITY);
    const goals = this.flattenConjunction(term, start);

    if (
      this.current.kind === 'end' ||
      (this.current.kind === 'atom' && this.current.text === '?')
    ) {
      this.advance();
    }
    this.expectEof();
    return goals;
  }

  parseStandaloneTerm(): Term {
    const term = this.parse(MAX_PRIORITY);
    if (this.current.kind === 'end') this.advance();
    this.expectEof();
    return term;
  }

  expectEof(): void {
    if (this.current.kind !== 'eof') {
      this.fail(`Unexpected ${this.describe(this.current)} after end of term`);
    }
  }
}

function runParser<T>(input: string, action: (parser: Parser) => T): ParseResult<T> {
  try {
    return { success: true, value: action(new Parser(input)) };
  } catch (error) {
    if (error instanceof PrologSyntaxError) {
      return { success: false, error: { message: error.message, ...error.location } };
    }
    return {
      success: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
        position: 0,
        line: 1,
        column: 1,
      },
    };
  }
}

export function parseTerm(input: string): ParseResult<Term> {
  return runParser(input, (parser) => parser.parseStandaloneTerm());
}

export function parseClause(input: string): ParseResult<Clause> {
  return runParser(input, (parser) => {
    const clause = parser.parseClause();
    parser.expectEof();
    return clause;
  });
}

export function parseProgram(input: string): ParseResult<Clause[]> {
  return runParser(input, (parser) => parser.parseProgram());
}

export function parseQuery(input: string): ParseResult<CompoundTerm[]> {
  return runParser(input, (parser) => parser.parseQuery());
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
    case 'list': {
      const allPairs =
        term.elements.length > 0 &&
        term.elements.every(
          (e) => e.type === 'compound' && e.functor === '=' && e.args.length === 2
        );
      if (allPairs) {
        const obj: Record<string, unknown> = {};
        for (const e of term.elements) {
          const compound = e as CompoundTerm;
          obj[String(termToValue(compound.args[0]))] = termToValue(compound.args[1]);
        }
        return obj;
      }
      return term.elements.map(termToValue);
    }
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
