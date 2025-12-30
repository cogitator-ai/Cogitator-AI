/**
 * Calculator tool - evaluates mathematical expressions safely
 */

import { z } from 'zod';
import { tool } from '../tool';

const calculatorParams = z.object({
  expression: z.string().describe('Mathematical expression to evaluate (e.g., "2 + 3 * 4")'),
});

/**
 * Safe mathematical expression evaluator
 * Supports: +, -, *, /, ^, (), sqrt, sin, cos, tan, log, abs, round, floor, ceil, pi, e
 */
function evaluateExpression(expr: string): number {
  const tokens = tokenize(expr);
  return parseExpression(tokens, 0).value;
}

type Token =
  | { type: 'number'; value: number }
  | { type: 'operator'; value: string }
  | { type: 'function'; value: string }
  | { type: 'paren'; value: '(' | ')' };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const str = expr.replace(/\s+/g, '');

  while (i < str.length) {
    const char = str[i];

    if (/[0-9.]/.test(char)) {
      let num = '';
      while (i < str.length && /[0-9.]/.test(str[i])) {
        num += str[i];
        i++;
      }
      tokens.push({ type: 'number', value: parseFloat(num) });
      continue;
    }

    if (str.slice(i, i + 2) === 'pi') {
      tokens.push({ type: 'number', value: Math.PI });
      i += 2;
      continue;
    }
    if (char === 'e' && (i + 1 >= str.length || !/[a-z]/i.test(str[i + 1]))) {
      tokens.push({ type: 'number', value: Math.E });
      i++;
      continue;
    }

    const functions = ['sqrt', 'sin', 'cos', 'tan', 'log', 'abs', 'round', 'floor', 'ceil'];
    let foundFunc = false;
    for (const func of functions) {
      if (str.slice(i, i + func.length) === func) {
        tokens.push({ type: 'function', value: func });
        i += func.length;
        foundFunc = true;
        break;
      }
    }
    if (foundFunc) continue;

    if (['+', '-', '*', '/', '^'].includes(char)) {
      tokens.push({ type: 'operator', value: char });
      i++;
      continue;
    }

    if (char === '(' || char === ')') {
      tokens.push({ type: 'paren', value: char });
      i++;
      continue;
    }

    throw new Error(`Unknown character: ${char}`);
  }

  return tokens;
}

interface ParseResult {
  value: number;
  pos: number;
}

function parseExpression(tokens: Token[], pos: number): ParseResult {
  return parseAddSub(tokens, pos);
}

function parseAddSub(tokens: Token[], pos: number): ParseResult {
  let result = parseMulDiv(tokens, pos);

  while (
    result.pos < tokens.length &&
    tokens[result.pos].type === 'operator' &&
    ['+', '-'].includes((tokens[result.pos] as { type: 'operator'; value: string }).value)
  ) {
    const op = (tokens[result.pos] as { type: 'operator'; value: string }).value;
    const right = parseMulDiv(tokens, result.pos + 1);
    result = {
      value: op === '+' ? result.value + right.value : result.value - right.value,
      pos: right.pos,
    };
  }

  return result;
}

function parseMulDiv(tokens: Token[], pos: number): ParseResult {
  let result = parsePower(tokens, pos);

  while (
    result.pos < tokens.length &&
    tokens[result.pos].type === 'operator' &&
    ['*', '/'].includes((tokens[result.pos] as { type: 'operator'; value: string }).value)
  ) {
    const op = (tokens[result.pos] as { type: 'operator'; value: string }).value;
    const right = parsePower(tokens, result.pos + 1);
    result = {
      value: op === '*' ? result.value * right.value : result.value / right.value,
      pos: right.pos,
    };
  }

  return result;
}

function parsePower(tokens: Token[], pos: number): ParseResult {
  const base = parseUnary(tokens, pos);

  if (
    base.pos < tokens.length &&
    tokens[base.pos].type === 'operator' &&
    (tokens[base.pos] as { type: 'operator'; value: string }).value === '^'
  ) {
    const exponent = parsePower(tokens, base.pos + 1);
    return {
      value: Math.pow(base.value, exponent.value),
      pos: exponent.pos,
    };
  }

  return base;
}

function parseUnary(tokens: Token[], pos: number): ParseResult {
  if (
    tokens[pos].type === 'operator' &&
    (tokens[pos] as { type: 'operator'; value: string }).value === '-'
  ) {
    const result = parseUnary(tokens, pos + 1);
    return { value: -result.value, pos: result.pos };
  }

  return parsePrimary(tokens, pos);
}

function parsePrimary(tokens: Token[], pos: number): ParseResult {
  const token = tokens[pos];

  if (token.type === 'number') {
    return { value: token.value, pos: pos + 1 };
  }

  if (token.type === 'function') {
    if (tokens[pos + 1]?.type !== 'paren' || tokens[pos + 1].value !== '(') {
      throw new Error(`Expected '(' after function ${token.value}`);
    }
    const arg = parseExpression(tokens, pos + 2);
    if (tokens[arg.pos]?.type !== 'paren' || tokens[arg.pos].value !== ')') {
      throw new Error(`Expected ')' after function argument`);
    }

    let value: number;
    switch (token.value) {
      case 'sqrt':
        value = Math.sqrt(arg.value);
        break;
      case 'sin':
        value = Math.sin(arg.value);
        break;
      case 'cos':
        value = Math.cos(arg.value);
        break;
      case 'tan':
        value = Math.tan(arg.value);
        break;
      case 'log':
        value = Math.log(arg.value);
        break;
      case 'abs':
        value = Math.abs(arg.value);
        break;
      case 'round':
        value = Math.round(arg.value);
        break;
      case 'floor':
        value = Math.floor(arg.value);
        break;
      case 'ceil':
        value = Math.ceil(arg.value);
        break;
      default:
        throw new Error(`Unknown function: ${token.value}`);
    }

    return { value, pos: arg.pos + 1 };
  }

  if (token.type === 'paren' && token.value === '(') {
    const result = parseExpression(tokens, pos + 1);
    if (tokens[result.pos]?.type !== 'paren' || tokens[result.pos].value !== ')') {
      throw new Error(`Expected ')'`);
    }
    return { value: result.value, pos: result.pos + 1 };
  }

  throw new Error(`Unexpected token: ${JSON.stringify(token)}`);
}

export const calculator = tool({
  name: 'calculator',
  description:
    'Evaluate mathematical expressions. Supports +, -, *, /, ^ (power), parentheses, and functions: sqrt, sin, cos, tan, log, abs, round, floor, ceil. Constants: pi, e.',
  parameters: calculatorParams,
  execute: async ({ expression }) => {
    try {
      const result = evaluateExpression(expression);
      if (!isFinite(result)) {
        return { error: 'Result is not a finite number', expression };
      }
      return { result, expression };
    } catch (err) {
      return { error: (err as Error).message, expression };
    }
  },
});
