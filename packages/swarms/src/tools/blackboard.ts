/**
 * Swarm blackboard tools for shared state management
 */

import { z } from 'zod';
import { tool } from '@cogitator/core';
import type { Blackboard } from '@cogitator/types';

/**
 * Create blackboard tools bound to a blackboard instance
 */
export function createBlackboardTools(blackboard: Blackboard, currentAgent: string) {
  const readBlackboard = tool({
    name: 'read_blackboard',
    description: 'Read data from the shared blackboard',
    parameters: z.object({
      section: z.string().describe('The section name to read from'),
      key: z.string().optional().describe('Specific key within the section (reads entire section if omitted)'),
    }),
    execute: async ({ section, key }) => {
      const data = blackboard.read(section);

      if (data === undefined) {
        return {
          found: false,
          section,
          data: null,
        };
      }

      if (key && typeof data === 'object' && data !== null) {
        const value = (data as Record<string, unknown>)[key];
        return {
          found: value !== undefined,
          section,
          key,
          data: value ?? null,
        };
      }

      return {
        found: true,
        section,
        data,
      };
    },
  });

  const writeBlackboard = tool({
    name: 'write_blackboard',
    description: 'Write data to the shared blackboard',
    parameters: z.object({
      section: z.string().describe('The section name to write to'),
      data: z.unknown().describe('The data to write (will replace existing section data)'),
      merge: z.boolean().optional().describe('If true and data is an object, merge with existing data'),
    }),
    execute: async ({ section, data, merge }) => {
      if (merge && typeof data === 'object' && data !== null) {
        const existing = blackboard.read(section);
        if (existing && typeof existing === 'object') {
          const merged = { ...existing as object, ...data as object };
          blackboard.write(section, merged, currentAgent);
          return {
            written: true,
            section,
            merged: true,
          };
        }
      }

      blackboard.write(section, data, currentAgent);
      return {
        written: true,
        section,
        merged: false,
      };
    },
  });

  const appendBlackboard = tool({
    name: 'append_blackboard',
    description: 'Append an item to an array section on the blackboard',
    parameters: z.object({
      section: z.string().describe('The section name (must be an array)'),
      item: z.unknown().describe('The item to append'),
    }),
    execute: async ({ section, item }) => {
      try {
        blackboard.append(section, item, currentAgent);
        return {
          appended: true,
          section,
        };
      } catch (error) {
        return {
          appended: false,
          error: error instanceof Error ? error.message : 'Failed to append',
        };
      }
    },
  });

  const listBlackboardSections = tool({
    name: 'list_blackboard_sections',
    description: 'List all available sections on the blackboard',
    parameters: z.object({
      prefix: z.string().optional().describe('Filter sections by prefix'),
    }),
    execute: async ({ prefix }) => {
      let sections = blackboard.getSections();

      if (prefix) {
        sections = sections.filter(s => s.startsWith(prefix));
      }

      return {
        sections,
        count: sections.length,
      };
    },
  });

  const getBlackboardHistory = tool({
    name: 'get_blackboard_history',
    description: 'Get the history of changes for a section',
    parameters: z.object({
      section: z.string().describe('The section to get history for'),
      limit: z.number().optional().describe('Maximum number of history entries (default: 10)'),
    }),
    execute: async ({ section, limit = 10 }) => {
      const history = blackboard.getHistory(section);

      if (!history || history.length === 0) {
        return {
          section,
          history: [],
          count: 0,
        };
      }

      const entries = history.slice(-limit).map(entry => ({
        version: entry.version,
        writtenBy: entry.writtenBy,
        timestamp: entry.timestamp,
        hasValue: entry.value !== undefined,
      }));

      return {
        section,
        history: entries,
        count: entries.length,
        totalHistory: history.length,
      };
    },
  });

  return {
    readBlackboard,
    writeBlackboard,
    appendBlackboard,
    listBlackboardSections,
    getBlackboardHistory,
  };
}

export type BlackboardTools = ReturnType<typeof createBlackboardTools>;
