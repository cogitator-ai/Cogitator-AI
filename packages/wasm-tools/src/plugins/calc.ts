/**
 * Calculator WASM Plugin
 *
 * This file is compiled to WASM using the Extism JS PDK.
 * It provides safe mathematical expression evaluation.
 *
 * Build command:
 *   esbuild src/plugins/calc.ts -o dist/temp/calc.js --bundle --format=cjs --target=es2020
 *   extism-js dist/temp/calc.js -o dist/wasm/calc.wasm
 */

interface CalcInput {
  expression: string;
}

interface CalcOutput {
  result: number;
  expression: string;
  error?: string;
}

function safeEval(expression: string): number {
  const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, '');

  if (sanitized !== expression.trim()) {
    throw new Error('Invalid characters in expression');
  }

  const matched = sanitized.match(/(\d*\.?\d+|[+\-*/()%])/g);
  if (!matched) {
    throw new Error('No valid tokens in expression');
  }

  const tokens: string[] = matched;
  let pos = 0;

  function parseExpr(): number {
    let left = parseTerm();
    while (pos < tokens.length && (tokens[pos] === '+' || tokens[pos] === '-')) {
      const op = tokens[pos++];
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseFactor();
    while (
      pos < tokens.length &&
      (tokens[pos] === '*' || tokens[pos] === '/' || tokens[pos] === '%')
    ) {
      const op = tokens[pos++];
      const right = parseFactor();
      if (op === '*') left *= right;
      else if (op === '/') {
        if (right === 0) throw new Error('Division by zero');
        left /= right;
      } else {
        left %= right;
      }
    }
    return left;
  }

  function parseFactor(): number {
    if (tokens[pos] === '(') {
      pos++;
      const val = parseExpr();
      if (tokens[pos] === ')') pos++;
      return val;
    }
    if (tokens[pos] === '-') {
      pos++;
      return -parseFactor();
    }
    if (tokens[pos] === '+') {
      pos++;
      return parseFactor();
    }
    const num = parseFloat(tokens[pos++]);
    if (isNaN(num)) throw new Error('Invalid expression');
    return num;
  }

  return parseExpr();
}

export function calculate(): number {
  try {
    const inputStr = Host.inputString();
    const input: CalcInput = JSON.parse(inputStr);

    const result = safeEval(input.expression);

    const output: CalcOutput = {
      result,
      expression: input.expression,
    };

    Host.outputString(JSON.stringify(output));
    return 0;
  } catch (error) {
    const output: CalcOutput = {
      result: NaN,
      expression: '',
      error: error instanceof Error ? error.message : String(error),
    };
    Host.outputString(JSON.stringify(output));
    return 1;
  }
}

declare const Host: {
  inputString(): string;
  outputString(s: string): void;
};
