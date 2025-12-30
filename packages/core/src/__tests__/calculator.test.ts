import { describe, it, expect } from 'vitest';
import { calculator } from '../tools/calculator.js';

const mockContext = {
  agentId: 'agent_test',
  runId: 'run_test',
  signal: new AbortController().signal,
};

describe('calculator tool', () => {
  describe('basic arithmetic', () => {
    it('evaluates addition', async () => {
      const result = await calculator.execute({ expression: '2 + 3' }, mockContext);
      expect(result).toEqual({ result: 5, expression: '2 + 3' });
    });

    it('evaluates subtraction', async () => {
      const result = await calculator.execute({ expression: '10 - 4' }, mockContext);
      expect(result).toEqual({ result: 6, expression: '10 - 4' });
    });

    it('evaluates multiplication', async () => {
      const result = await calculator.execute({ expression: '6 * 7' }, mockContext);
      expect(result).toEqual({ result: 42, expression: '6 * 7' });
    });

    it('evaluates division', async () => {
      const result = await calculator.execute({ expression: '20 / 4' }, mockContext);
      expect(result).toEqual({ result: 5, expression: '20 / 4' });
    });

    it('handles negative numbers', async () => {
      const result = await calculator.execute({ expression: '-5 + 3' }, mockContext);
      expect(result).toEqual({ result: -2, expression: '-5 + 3' });
    });

    it('handles decimals', async () => {
      const result = await calculator.execute({ expression: '3.14 * 2' }, mockContext);
      expect(result).toEqual({ result: 6.28, expression: '3.14 * 2' });
    });
  });

  describe('operator precedence', () => {
    it('respects multiplication over addition', async () => {
      const result = await calculator.execute({ expression: '2 + 3 * 4' }, mockContext);
      expect(result).toEqual({ result: 14, expression: '2 + 3 * 4' });
    });

    it('respects parentheses', async () => {
      const result = await calculator.execute({ expression: '(2 + 3) * 4' }, mockContext);
      expect(result).toEqual({ result: 20, expression: '(2 + 3) * 4' });
    });

    it('handles nested parentheses', async () => {
      const result = await calculator.execute({ expression: '((2 + 3) * (4 - 1))' }, mockContext);
      expect(result).toEqual({ result: 15, expression: '((2 + 3) * (4 - 1))' });
    });
  });

  describe('power operator', () => {
    it('evaluates power', async () => {
      const result = await calculator.execute({ expression: '2^3' }, mockContext);
      expect(result).toEqual({ result: 8, expression: '2^3' });
    });

    it('handles right-associative power', async () => {
      const result = await calculator.execute({ expression: '2^2^3' }, mockContext);
      expect(result).toEqual({ result: 256, expression: '2^2^3' });
    });
  });

  describe('mathematical functions', () => {
    it('evaluates sqrt', async () => {
      const result = await calculator.execute({ expression: 'sqrt(16)' }, mockContext);
      expect(result).toEqual({ result: 4, expression: 'sqrt(16)' });
    });

    it('evaluates abs', async () => {
      const result = await calculator.execute({ expression: 'abs(-5)' }, mockContext);
      expect(result).toEqual({ result: 5, expression: 'abs(-5)' });
    });

    it('evaluates round', async () => {
      const result = await calculator.execute({ expression: 'round(3.7)' }, mockContext);
      expect(result).toEqual({ result: 4, expression: 'round(3.7)' });
    });

    it('evaluates floor', async () => {
      const result = await calculator.execute({ expression: 'floor(3.9)' }, mockContext);
      expect(result).toEqual({ result: 3, expression: 'floor(3.9)' });
    });

    it('evaluates ceil', async () => {
      const result = await calculator.execute({ expression: 'ceil(3.1)' }, mockContext);
      expect(result).toEqual({ result: 4, expression: 'ceil(3.1)' });
    });

    it('evaluates sin', async () => {
      const result = (await calculator.execute({ expression: 'sin(0)' }, mockContext)) as {
        result: number;
        expression: string;
      };
      expect(result.result).toBeCloseTo(0);
    });

    it('evaluates cos', async () => {
      const result = (await calculator.execute({ expression: 'cos(0)' }, mockContext)) as {
        result: number;
        expression: string;
      };
      expect(result.result).toBeCloseTo(1);
    });

    it('evaluates log', async () => {
      const result = (await calculator.execute({ expression: 'log(e)' }, mockContext)) as {
        result: number;
        expression: string;
      };
      expect(result.result).toBeCloseTo(1);
    });
  });

  describe('constants', () => {
    it('supports pi', async () => {
      const result = (await calculator.execute({ expression: 'pi' }, mockContext)) as {
        result: number;
        expression: string;
      };
      expect(result.result).toBeCloseTo(Math.PI);
    });

    it('supports e', async () => {
      const result = (await calculator.execute({ expression: 'e' }, mockContext)) as {
        result: number;
        expression: string;
      };
      expect(result.result).toBeCloseTo(Math.E);
    });

    it('uses pi in expressions', async () => {
      const result = (await calculator.execute({ expression: '2 * pi' }, mockContext)) as {
        result: number;
        expression: string;
      };
      expect(result.result).toBeCloseTo(2 * Math.PI);
    });
  });

  describe('complex expressions', () => {
    it('evaluates compound expression', async () => {
      const result = await calculator.execute({ expression: 'sqrt(16) + 2^3 - 4' }, mockContext);
      expect(result).toEqual({ result: 8, expression: 'sqrt(16) + 2^3 - 4' });
    });

    it('handles function with expression argument', async () => {
      const result = await calculator.execute({ expression: 'sqrt(9 + 16)' }, mockContext);
      expect(result).toEqual({ result: 5, expression: 'sqrt(9 + 16)' });
    });
  });

  describe('error handling', () => {
    it('returns error for invalid characters', async () => {
      const result = (await calculator.execute({ expression: '2 + x' }, mockContext)) as {
        error: string;
        expression: string;
      };
      expect(result.error).toContain('Unknown character');
    });

    it('returns error for division by zero (Infinity)', async () => {
      const result = (await calculator.execute({ expression: '1 / 0' }, mockContext)) as {
        error: string;
        expression: string;
      };
      expect(result.error).toContain('not a finite number');
    });

    it('returns error for missing function parentheses', async () => {
      const result = (await calculator.execute({ expression: 'sqrt 16' }, mockContext)) as {
        error: string;
        expression: string;
      };
      expect(result.error).toContain("Expected '(' after function");
    });
  });

  describe('tool metadata', () => {
    it('has correct name', () => {
      expect(calculator.name).toBe('calculator');
    });

    it('has description', () => {
      expect(calculator.description).toContain('mathematical expressions');
    });

    it('returns valid JSON schema', () => {
      const schema = calculator.toJSON();
      expect(schema.name).toBe('calculator');
      expect(schema.parameters.type).toBe('object');
      expect(schema.parameters.properties).toHaveProperty('expression');
    });
  });
});
