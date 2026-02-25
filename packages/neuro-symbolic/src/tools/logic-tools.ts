import { z } from 'zod';
import type { ToolContext } from '@cogitator-ai/types';
import { tool } from '@cogitator-ai/core';
import type { NeuroSymbolic } from '../orchestrator';
import { formatSolutions, termToString } from '../logic';

export function createLogicTools(ns: NeuroSymbolic) {
  const queryLogic = tool({
    name: 'query_logic',
    description:
      'Execute a Prolog-style logic query against the knowledge base. ' +
      'Returns variable bindings that satisfy the query. ' +
      'Example queries: "parent(tom, X)", "grandparent(X, ann)", "member(X, [1,2,3])"',
    category: 'development',
    tags: ['logic', 'prolog', 'reasoning', 'neuro-symbolic'],
    parameters: z.object({
      query: z
        .string()
        .describe(
          'Prolog-style query without trailing period. Variables start with uppercase (X, Y, Person). ' +
            'Examples: "parent(tom, X)", "ancestor(X, Y), X \\= Y"'
        ),
      maxSolutions: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Maximum number of solutions to return (default: 10)'),
    }),
    execute: async ({ query, maxSolutions }, _context: ToolContext) => {
      const config = ns.getConfig();
      const originalMax = config.logic?.maxSolutions;

      if (maxSolutions) {
        ns.updateConfig({ logic: { maxSolutions } });
      }

      try {
        const result = ns.queryLogic(query);

        if (!result.success || !result.data) {
          return {
            success: false,
            error: result.error || 'Query failed',
            solutions: [],
          };
        }

        const solutions = result.data.solutions.map((subst) => {
          const bindings: Record<string, string> = {};
          for (const [varName, term] of subst.entries()) {
            bindings[varName] = termToString(term);
          }
          return bindings;
        });

        return {
          success: result.data.success,
          solutionCount: solutions.length,
          solutions,
          formatted: formatSolutions(result.data),
          duration: result.duration,
        };
      } finally {
        if (maxSolutions) {
          ns.updateConfig({ logic: { maxSolutions: originalMax ?? 10 } });
        }
      }
    },
  });

  const assertFact = tool({
    name: 'assert_fact',
    description:
      'Add a fact or rule to the knowledge base. ' +
      'Facts: "parent(tom, mary)." Rules: "grandparent(X, Z) :- parent(X, Y), parent(Y, Z)."',
    category: 'development',
    tags: ['logic', 'prolog', 'knowledge-base', 'neuro-symbolic'],
    parameters: z.object({
      clause: z
        .string()
        .describe(
          'Prolog clause to add. Must end with a period. ' +
            'Fact example: "likes(mary, pizza)." ' +
            'Rule example: "mortal(X) :- human(X)."'
        ),
    }),
    execute: async ({ clause }, _context: ToolContext) => {
      const result = ns.loadLogicProgram(clause);

      const kb = ns.getKnowledgeBase();
      const stats = kb.getStats();

      return {
        success: result.success,
        errors: result.errors,
        knowledgeBaseStats: {
          factCount: stats.factCount,
          ruleCount: stats.ruleCount,
          predicateCount: stats.predicates.length,
        },
      };
    },
  });

  const loadProgram = tool({
    name: 'load_logic_program',
    description:
      'Load a complete Prolog program (multiple facts and rules) into the knowledge base. ' +
      'Use this for bulk loading of knowledge.',
    category: 'development',
    tags: ['logic', 'prolog', 'knowledge-base', 'neuro-symbolic'],
    parameters: z.object({
      program: z
        .string()
        .describe(
          'Prolog program with facts and rules. Each clause ends with a period. ' +
            'Example: "parent(tom, mary). parent(mary, ann). grandparent(X, Z) :- parent(X, Y), parent(Y, Z)."'
        ),
      clearExisting: z
        .boolean()
        .optional()
        .describe('Clear existing knowledge base before loading (default: false)'),
    }),
    execute: async ({ program, clearExisting }, _context: ToolContext) => {
      if (clearExisting) {
        ns.reset();
      }

      const result = ns.loadLogicProgram(program);

      const kb = ns.getKnowledgeBase();
      const stats = kb.getStats();

      return {
        success: result.success,
        errors: result.errors,
        knowledgeBaseStats: {
          factCount: stats.factCount,
          ruleCount: stats.ruleCount,
          predicateCount: stats.predicates.length,
        },
      };
    },
  });

  return { queryLogic, assertFact, loadProgram };
}
