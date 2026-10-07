import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { compileFunction } from 'node:vm';
import ts from 'typescript';
import { CALCULATOR_TS } from '../kit/features/starter-tools.js';

interface CalculatorModule {
  evaluate: (expression: string) => number;
  calculator: { description: string };
}

/**
 * The generated calculator compiled and loaded as a project would run it,
 * with `tool()` of @cogitator-ai/core reduced to returning its definition.
 */
function loadCalculator(): CalculatorModule {
  const { outputText } = ts.transpileModule(CALCULATOR_TS, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const requireReal = createRequire(import.meta.url);
  const module = { exports: {} as Record<string, unknown> };
  const load = (specifier: string): unknown =>
    specifier === '@cogitator-ai/core'
      ? { tool: (definition: unknown) => definition }
      : requireReal(specifier);
  compileFunction(outputText, ['module', 'exports', 'require'])(module, module.exports, load);
  return module.exports as unknown as CalculatorModule;
}

describe('generated calculator', () => {
  const { evaluate, calculator } = loadCalculator();

  it('evaluates arithmetic with the usual precedence', () => {
    expect(evaluate('1 + 2 * 3')).toBe(7);
    expect(evaluate('2 ^ 3 ^ 2')).toBe(512);
    expect(evaluate('17.5 / 100 * 2480')).toBe(434);
  });

  it('keeps % the remainder of a division', () => {
    expect(evaluate('10 % 3')).toBe(1);
    expect(evaluate('10 % -3')).toBe(1);
    expect(evaluate('max(1, 5, 3) % (1 + 1)')).toBe(1);
  });

  it('tells a model that wrote a percentage how to write it', () => {
    expect(() => evaluate('17.5% * 2480')).toThrow(
      '"%" is the remainder of a division and needs a number after it. For a percentage divide by 100: 17.5% is 17.5 / 100'
    );
    expect(() => evaluate('(20%)')).toThrow('20% is 20 / 100');
    expect(() => evaluate('20 %')).toThrow('remainder of a division');
  });

  it('says in its description what % means', () => {
    expect(calculator.description).toContain('% as the remainder of a division');
    expect(calculator.description).toContain('17.5 / 100 * 2480');
  });
});
