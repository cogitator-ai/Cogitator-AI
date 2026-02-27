import { z } from 'zod';
import { tool } from '../tool';
import type {
  Tool,
  GraphAdapter,
  GraphNode,
  GraphSemanticSearchOptions,
  NodeQuery,
} from '@cogitator-ai/types';

export interface CoreFactsLike {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  getAll(): Promise<Record<string, string>>;
}

export interface MemoryToolsConfig {
  graphAdapter: GraphAdapter;
  coreFacts?: CoreFactsLike;
  embeddingFn?: (text: string) => Promise<number[]>;
  agentId: string;
}

const rememberParams = z.object({
  fact: z.string().describe('The fact or piece of information to remember'),
  category: z.string().optional().describe('Category to organize this fact under'),
  isCoreFact: z.boolean().optional().describe('Whether this is a core fact about the user'),
  coreFactKey: z
    .string()
    .optional()
    .describe('Key for the core fact (required if isCoreFact is true)'),
});

const recallParams = z.object({
  query: z.string().describe('Search query to find relevant memories'),
});

const forgetParams = z.object({
  query: z.string().describe('Pattern to match facts to delete'),
});

export function createMemoryTools(config: MemoryToolsConfig): Tool[] {
  const { graphAdapter, coreFacts, embeddingFn, agentId } = config;

  const remember = tool({
    name: 'remember',
    description:
      'Save a fact or piece of information to long-term memory. Use this when the user shares important information that should be remembered across conversations.',
    parameters: rememberParams,
    execute: async ({ fact, category, isCoreFact, coreFactKey }) => {
      const embedding = embeddingFn ? await embeddingFn(fact) : undefined;

      const properties: Record<string, unknown> = {};
      if (category) properties.category = category;

      const result = await graphAdapter.addNode({
        agentId,
        name: fact,
        type: 'concept',
        aliases: [],
        properties,
        embedding,
        confidence: 1,
        source: 'user',
      });

      if (isCoreFact && coreFactKey && coreFacts) {
        await coreFacts.set(coreFactKey, fact);
      }

      const nodeId = result.success ? result.data.id : 'unknown';
      return { saved: true, id: nodeId };
    },
  });

  const recall = tool({
    name: 'recall',
    description:
      'Search long-term memory for relevant facts and information. Returns both semantic matches from the knowledge graph and core facts.',
    parameters: recallParams,
    execute: async ({ query }) => {
      type ResultItem = { fact: string; type: string; confidence: number };
      const results: ResultItem[] = [];

      if (embeddingFn) {
        const vector = await embeddingFn(query);
        const searchOpts: GraphSemanticSearchOptions = {
          agentId,
          vector,
          limit: 10,
        };
        const semanticResult = await graphAdapter.searchNodesSemantic(searchOpts);
        if (semanticResult.success) {
          for (const node of semanticResult.data) {
            results.push({
              fact: node.name,
              type: 'semantic',
              confidence: node.score,
            });
          }
        }
      } else {
        const nodeQuery: NodeQuery = {
          agentId,
          namePattern: query,
          limit: 10,
        };
        const textResult = await graphAdapter.queryNodes(nodeQuery);
        if (textResult.success) {
          for (const node of textResult.data) {
            results.push({
              fact: node.name,
              type: 'text',
              confidence: node.confidence ?? 1,
            });
          }
        }
      }

      const coreFactsData = coreFacts ? await coreFacts.getAll() : {};

      return { results, coreFacts: coreFactsData };
    },
  });

  const forget = tool({
    name: 'forget',
    description:
      'Delete facts from long-term memory that match the given pattern. Use with care as this permanently removes information.',
    parameters: forgetParams,
    execute: async ({ query }) => {
      const nodeQuery: NodeQuery = {
        agentId,
        namePattern: query,
      };
      const found = await graphAdapter.queryNodes(nodeQuery);

      const nodes: GraphNode[] = found.success ? found.data : [];
      const items: string[] = [];

      for (const node of nodes) {
        await graphAdapter.deleteNode(node.id);
        items.push(node.name);
      }

      return { deleted: items.length, items };
    },
  });

  return [remember, recall, forget];
}
