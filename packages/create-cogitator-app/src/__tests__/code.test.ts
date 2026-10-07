import { describe, it, expect } from 'vitest';
import { code, tsKey, tsString, yamlString } from '../kit/code.js';

describe('code', () => {
  it('removes the common indentation and ends with one newline', () => {
    expect(code`
      const a = 1;
        const b = 2;
    `).toBe('const a = 1;\n  const b = 2;\n');
  });

  it('indents a multi-line value to its placeholder', () => {
    const body = 'one();\ntwo();';
    expect(code`
      function f() {
        ${body}
      }
    `).toBe('function f() {\n  one();\n  two();\n}\n');
  });

  it('drops the line of a false, null or undefined value', () => {
    const missing: string | null = null;
    expect(code`
      first
      ${false}
      ${missing}
      ${undefined}
      last
    `).toBe('first\nlast\n');
  });

  it('keeps an empty string and collapses runs of blank lines', () => {
    expect(code`
      a


      b ${''}
    `).toBe('a\n\nb\n');
  });

  it('unescapes backticks and template placeholders for generated template literals', () => {
    expect(code`
      const s = \`\${name}\`;
    `).toBe('const s = `${name}`;\n');
  });

  it('does not double a nested block trailing newline', () => {
    const inner = code`
      x();
    `;
    expect(code`
      {
        ${inner}
      }
    `).toBe('{\n  x();\n}\n');
  });
});

describe('literals', () => {
  it('quotes any text as a TypeScript string', () => {
    expect(tsString("bob's {app}")).toBe("'bob\\'s {app}'");
    expect(tsString('a\\b\nc')).toBe("'a\\\\b\\nc'");
  });

  it('quotes property keys only when needed', () => {
    expect(tsKey('assistant')).toBe('assistant');
    expect(tsKey('my-agent')).toBe("'my-agent'");
  });

  it('quotes YAML scalars that would change meaning', () => {
    expect(yamlString('sqlite')).toBe('sqlite');
    expect(yamlString('ollama/qwen3.5:9b')).toBe('"ollama/qwen3.5:9b"');
    expect(yamlString('yes')).toBe('"yes"');
    expect(yamlString('1.5')).toBe('"1.5"');
    expect(yamlString('')).toBe('""');
  });
});
