import { describe, it, expect, beforeEach } from 'vitest';
import type { LogicQueryResult } from '@cogitator-ai/types';
import { SLDResolver, createResolver, formatSolutions } from '../logic/resolver';
import { KnowledgeBase, createKnowledgeBase } from '../logic/knowledge-base';

describe('SLDResolver', () => {
  let kb: KnowledgeBase;
  let resolver: SLDResolver;

  beforeEach(() => {
    kb = createKnowledgeBase();
    resolver = createResolver(kb);
  });

  describe('simple fact queries', () => {
    it('proves a simple fact using query method', () => {
      kb.assertFact('human', [{ type: 'atom', value: 'socrates' }]);

      const goal = {
        type: 'compound' as const,
        functor: 'human',
        args: [{ type: 'atom' as const, value: 'socrates' }],
      };

      const result = resolver.query([goal]);
      expect(result.success).toBe(true);
    });

    it('fails for non-existent fact', () => {
      kb.assertFact('human', [{ type: 'atom', value: 'socrates' }]);

      const goal = {
        type: 'compound' as const,
        functor: 'human',
        args: [{ type: 'atom' as const, value: 'plato' }],
      };

      const result = resolver.query([goal]);
      expect(result.success).toBe(false);
    });

    it('finds all matching facts with variable', () => {
      kb.assertFact('color', [{ type: 'atom', value: 'red' }]);
      kb.assertFact('color', [{ type: 'atom', value: 'green' }]);
      kb.assertFact('color', [{ type: 'atom', value: 'blue' }]);

      const goal = {
        type: 'compound' as const,
        functor: 'color',
        args: [{ type: 'variable' as const, name: 'X' }],
      };

      const result = resolver.query([goal]);
      expect(result.success).toBe(true);
      expect(result.solutions.length).toBe(3);
    });
  });

  describe('rule resolution', () => {
    it('resolves single rule', () => {
      kb.assertFact('human', [{ type: 'atom', value: 'socrates' }]);

      kb.assertRule(
        {
          type: 'compound',
          functor: 'mortal',
          args: [{ type: 'variable', name: 'X' }],
        },
        [
          {
            type: 'compound',
            functor: 'human',
            args: [{ type: 'variable', name: 'X' }],
          },
        ]
      );

      const goal = {
        type: 'compound' as const,
        functor: 'mortal',
        args: [{ type: 'atom' as const, value: 'socrates' }],
      };

      const result = resolver.query([goal]);
      expect(result.success).toBe(true);
    });

    it('resolves chained rules', () => {
      kb.assertFact('parent', [
        { type: 'atom', value: 'tom' },
        { type: 'atom', value: 'mary' },
      ]);
      kb.assertFact('parent', [
        { type: 'atom', value: 'mary' },
        { type: 'atom', value: 'ann' },
      ]);

      kb.assertRule(
        {
          type: 'compound',
          functor: 'grandparent',
          args: [
            { type: 'variable', name: 'X' },
            { type: 'variable', name: 'Z' },
          ],
        },
        [
          {
            type: 'compound',
            functor: 'parent',
            args: [
              { type: 'variable', name: 'X' },
              { type: 'variable', name: 'Y' },
            ],
          },
          {
            type: 'compound',
            functor: 'parent',
            args: [
              { type: 'variable', name: 'Y' },
              { type: 'variable', name: 'Z' },
            ],
          },
        ]
      );

      const goal = {
        type: 'compound' as const,
        functor: 'grandparent',
        args: [
          { type: 'atom' as const, value: 'tom' },
          { type: 'atom' as const, value: 'ann' },
        ],
      };

      const result = resolver.query([goal]);
      expect(result.success).toBe(true);
    });
  });

  describe('conjunction queries', () => {
    it('resolves conjunction of goals', () => {
      kb.assertFact('likes', [
        { type: 'atom', value: 'john' },
        { type: 'atom', value: 'pizza' },
      ]);
      kb.assertFact('likes', [
        { type: 'atom', value: 'john' },
        { type: 'atom', value: 'beer' },
      ]);

      const goals = [
        {
          type: 'compound' as const,
          functor: 'likes',
          args: [
            { type: 'atom' as const, value: 'john' },
            { type: 'atom' as const, value: 'pizza' },
          ],
        },
        {
          type: 'compound' as const,
          functor: 'likes',
          args: [
            { type: 'atom' as const, value: 'john' },
            { type: 'atom' as const, value: 'beer' },
          ],
        },
      ];

      const result = resolver.query(goals);
      expect(result.success).toBe(true);
    });

    it('fails if any goal fails', () => {
      kb.assertFact('likes', [
        { type: 'atom', value: 'john' },
        { type: 'atom', value: 'pizza' },
      ]);

      const goals = [
        {
          type: 'compound' as const,
          functor: 'likes',
          args: [
            { type: 'atom' as const, value: 'john' },
            { type: 'atom' as const, value: 'pizza' },
          ],
        },
        {
          type: 'compound' as const,
          functor: 'likes',
          args: [
            { type: 'atom' as const, value: 'john' },
            { type: 'atom' as const, value: 'beer' },
          ],
        },
      ];

      const result = resolver.query(goals);
      expect(result.success).toBe(false);
    });
  });

  describe('configuration', () => {
    it('respects maxSolutions limit', () => {
      kb.assertFact('num', [{ type: 'number', value: 1 }]);
      kb.assertFact('num', [{ type: 'number', value: 2 }]);
      kb.assertFact('num', [{ type: 'number', value: 3 }]);
      kb.assertFact('num', [{ type: 'number', value: 4 }]);
      kb.assertFact('num', [{ type: 'number', value: 5 }]);

      const limitedResolver = createResolver(kb, { maxSolutions: 2 });

      const goal = {
        type: 'compound' as const,
        functor: 'num',
        args: [{ type: 'variable' as const, name: 'X' }],
      };

      const result = limitedResolver.query([goal]);
      expect(result.solutions.length).toBe(2);
    });
  });

  describe('query result structure', () => {
    it('returns solutions with variable bindings', () => {
      kb.assertFact('person', [{ type: 'atom', value: 'alice' }]);
      kb.assertFact('person', [{ type: 'atom', value: 'bob' }]);

      const goal = {
        type: 'compound' as const,
        functor: 'person',
        args: [{ type: 'variable' as const, name: 'Name' }],
      };

      const result = resolver.query([goal]);
      expect(result.success).toBe(true);
      expect(result.solutions).toHaveLength(2);

      for (const solution of result.solutions) {
        expect(solution.get('Name')).toBeDefined();
      }
    });

    it('returns empty solutions for ground queries', () => {
      kb.assertFact('fact', [{ type: 'atom', value: 'value' }]);

      const goal = {
        type: 'compound' as const,
        functor: 'fact',
        args: [{ type: 'atom' as const, value: 'value' }],
      };

      const result = resolver.query([goal]);
      expect(result.success).toBe(true);
      expect(result.solutions).toHaveLength(1);
    });
  });
});

describe('formatSolutions', () => {
  it('formats successful query with solutions', () => {
    const solution1 = new Map<string, { type: 'atom'; value: string }>();
    solution1.set('X', { type: 'atom', value: 'foo' });

    const solution2 = new Map<string, { type: 'atom'; value: string }>();
    solution2.set('X', { type: 'atom', value: 'bar' });

    const result: LogicQueryResult = {
      success: true,
      solutions: [solution1, solution2],
      confidence: 1,
    };

    const formatted = formatSolutions(result);
    expect(formatted).toContain('X');
    expect(formatted).toContain('foo');
    expect(formatted).toContain('bar');
  });

  it('formats failed query', () => {
    const result: LogicQueryResult = {
      success: false,
      solutions: [],
      confidence: 0,
    };

    const formatted = formatSolutions(result);
    expect(formatted.toLowerCase()).toContain('false');
  });

  it('formats ground query success', () => {
    const result: LogicQueryResult = {
      success: true,
      solutions: [new Map()],
      confidence: 1,
    };

    const formatted = formatSolutions(result);
    expect(formatted.toLowerCase()).toContain('true');
  });
});
