export function evaluateArithmetic(expression: string): number {
  const tokens = expression.match(/\d+(?:\.\d+)?|[-+*/%()]|\S/g) ?? [];
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const primary = (): number => {
    const token = next();
    if (token === '(') {
      const value = sum();
      if (next() !== ')') throw new Error('Missing closing parenthesis');
      return value;
    }
    if (token === '-') return -primary();
    if (token === '+') return primary();
    if (token !== undefined && /^\d/.test(token)) return Number(token);
    throw new Error(`Unexpected token: ${token ?? 'end of input'}`);
  };

  const product = (): number => {
    let value = primary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next();
      const rhs = primary();
      value = op === '*' ? value * rhs : op === '/' ? value / rhs : value % rhs;
    }
    return value;
  };

  const sum = (): number => {
    let value = product();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const rhs = product();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  };

  const result = sum();
  if (pos !== tokens.length) throw new Error(`Unexpected token: ${peek()}`);
  return result;
}
