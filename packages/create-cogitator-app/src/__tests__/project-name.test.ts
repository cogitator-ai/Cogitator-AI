import { describe, it, expect } from 'vitest';
import { validateProjectName } from '../utils/project-name.js';

describe('validateProjectName', () => {
  it('accepts lowercase package names', () => {
    for (const name of ['my-agents', 'bot2', 'a.b_c-d', '0x']) {
      expect(validateProjectName(name), name).toBeUndefined();
    }
  });

  it('rejects names npm would refuse or that break generated code', () => {
    for (const name of ["bob's agents", '.', '..', '-x', '_x', 'My-Agents', 'a b', '', '   ']) {
      expect(validateProjectName(name), name).toBeTypeOf('string');
    }
  });

  it('rejects names longer than npm allows', () => {
    expect(validateProjectName('a'.repeat(214))).toBeUndefined();
    expect(validateProjectName('a'.repeat(215))).toBeTypeOf('string');
  });
});
