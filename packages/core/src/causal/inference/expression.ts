/**
 * Arithmetic expressions for `custom` structural equations, evaluated without
 * running code: numbers, variables, `+ - * / ^`, parentheses and the
 * functions in {@link EXPRESSION_FUNCTIONS}.
 */

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: string };

type Node =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; op: '-' | '+'; operand: Node }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/' | '^'; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] };

export const EXPRESSION_FUNCTIONS: Readonly<Record<string, (...args: number[]) => number>> = {
  abs: Math.abs,
  exp: Math.exp,
  log: Math.log,
  sqrt: Math.sqrt,
  pow: Math.pow,
  min: Math.min,
  max: Math.max,
  tanh: Math.tanh,
  sigmoid: (x) => 1 / (1 + Math.exp(-x)),
};

export class ExpressionError extends Error {
  constructor(expression: string, reason: string) {
    super(`Invalid expression "${expression}": ${reason}`);
    this.name = 'ExpressionError';
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|(\S))/y;
  let match: RegExpExecArray | null;

  while (pattern.lastIndex < source.length && (match = pattern.exec(source))) {
    const [, number, name, op] = match;
    if (number !== undefined) tokens.push({ kind: 'number', value: Number(number) });
    else if (name !== undefined) tokens.push({ kind: 'name', value: name });
    else if (op !== undefined) {
      if (!'+-*/^(),'.includes(op)) throw new ExpressionError(source, `unexpected "${op}"`);
      tokens.push({ kind: 'op', value: op });
    }
  }

  return tokens;
}

class Parser {
  private position = 0;

  constructor(
    private readonly source: string,
    private readonly tokens: Token[]
  ) {}

  parse(): Node {
    if (this.tokens.length === 0) throw new ExpressionError(this.source, 'it is empty');
    const node = this.expression();
    const extra = this.tokens[this.position];
    if (extra) throw new ExpressionError(this.source, `unexpected "${extra.value}"`);
    return node;
  }

  private expression(): Node {
    let node = this.term();
    while (this.peekOp('+') || this.peekOp('-')) {
      const op = this.peekOp('+') ? '+' : '-';
      this.position++;
      node = { kind: 'binary', op, left: node, right: this.term() };
    }
    return node;
  }

  private term(): Node {
    let node = this.unary();
    while (this.peekOp('*') || this.peekOp('/')) {
      const op = this.peekOp('*') ? '*' : '/';
      this.position++;
      node = { kind: 'binary', op, left: node, right: this.unary() };
    }
    return node;
  }

  private unary(): Node {
    if (this.peekOp('-') || this.peekOp('+')) {
      const op = this.peekOp('-') ? '-' : '+';
      this.position++;
      return { kind: 'unary', op, operand: this.unary() };
    }
    return this.power();
  }

  private power(): Node {
    const base = this.primary();
    if (this.peekOp('^')) {
      this.position++;
      return { kind: 'binary', op: '^', left: base, right: this.unary() };
    }
    return base;
  }

  private primary(): Node {
    const token = this.next();

    if (token.kind === 'number') return { kind: 'number', value: token.value };

    if (token.kind === 'name') {
      if (!this.peekOp('(')) return { kind: 'variable', name: token.value };
      if (!Object.hasOwn(EXPRESSION_FUNCTIONS, token.value)) {
        throw new ExpressionError(this.source, `unknown function "${token.value}"`);
      }
      this.position++;
      const args: Node[] = [];
      if (!this.peekOp(')')) {
        args.push(this.expression());
        while (this.peekOp(',')) {
          this.position++;
          args.push(this.expression());
        }
      }
      this.expectOp(')');
      return { kind: 'call', name: token.value, args };
    }

    if (token.value === '(') {
      const node = this.expression();
      this.expectOp(')');
      return node;
    }

    throw new ExpressionError(this.source, `unexpected "${token.value}"`);
  }

  private next(): Token {
    const token = this.tokens[this.position++];
    if (!token) throw new ExpressionError(this.source, 'it ends too early');
    return token;
  }

  private peekOp(op: string): boolean {
    const token = this.tokens[this.position];
    return token?.kind === 'op' && token.value === op;
  }

  private expectOp(op: string): void {
    if (!this.peekOp(op)) throw new ExpressionError(this.source, `expected "${op}"`);
    this.position++;
  }
}

function evaluateNode(node: Node, variable: (name: string) => number): number {
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'variable':
      return variable(node.name);
    case 'unary': {
      const value = evaluateNode(node.operand, variable);
      return node.op === '-' ? -value : value;
    }
    case 'call':
      return EXPRESSION_FUNCTIONS[node.name](
        ...node.args.map((arg) => evaluateNode(arg, variable))
      );
    case 'binary': {
      const left = evaluateNode(node.left, variable);
      const right = evaluateNode(node.right, variable);
      switch (node.op) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return left / right;
        case '^':
          return Math.pow(left, right);
      }
    }
  }
}

/** A compiled expression: its value for the given variable values. */
export type CompiledExpression = (variables: Readonly<Record<string, number>>) => number;

/**
 * Parse `source` once; the result evaluates it with variables by name, a
 * variable without a value counting as 0.
 *
 * @throws ExpressionError when `source` is not a valid expression
 */
export function compileExpression(source: string): CompiledExpression {
  const ast = new Parser(source, tokenize(source)).parse();
  return (variables) =>
    evaluateNode(ast, (name) => (Object.hasOwn(variables, name) ? variables[name] : 0));
}
