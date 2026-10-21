import { z } from 'zod';
import { verifyEvidence, type MemoryItems } from '@cogitator-ai/memory';
import { tool, toolset } from '../tool';
import type {
  BaseToolContext,
  Evidence,
  GraphAdapter,
  GraphNode,
  GraphSemanticSearchOptions,
  MemoryAdapter,
  MemoryEntry,
  MemoryItemScope,
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
  /**
   * Memory items `remember` writes to, `recall` searches and `forget` lets go, scoped to the
   * calling run's user
   */
  items?: MemoryItems;
  /**
   * The conversations `remember` checks its `quote` against. With it, a fact counts as the
   * user's (graph `source: 'user'`, an `active` memory item, a core fact) only when the quote is
   * found word for word in a user message of the run's thread, so a model cannot plant what the
   * user never said. Without it nothing can be checked and every fact is kept as before.
   */
  memory?: Pick<MemoryAdapter, 'getEntries'>;
}

/** User messages of a thread `remember` looks for its quote in, the newest */
const QUOTE_LOOKBACK = 50;

const rememberParams = z.object({
  fact: z.string().describe('The fact or piece of information to remember'),
  category: z.string().optional().describe('Category to organize this fact under'),
  isCoreFact: z.boolean().optional().describe('Whether this is a core fact about the user'),
  coreFactKey: z
    .string()
    .optional()
    .describe('Key for the core fact (required if isCoreFact is true)'),
  quote: z
    .string()
    .optional()
    .describe("The user's own words that state the fact, copied exactly from their message"),
});

const recallParams = z.object({
  query: z.string().describe('Search query to find relevant memories'),
});

const forgetParams = z.object({
  query: z.string().describe('Pattern to match facts to delete'),
});

export function createMemoryTools(config: MemoryToolsConfig) {
  const { graphAdapter, coreFacts, embeddingFn, agentId, items, memory } = config;

  /** Where `remember` keeps a fact: the user's memory, or the thread's for a run without a user */
  const scopeOf = (context: BaseToolContext): MemoryItemScope => ({
    agentId,
    ...(context.userId !== undefined
      ? { userId: context.userId }
      : context.threadId !== undefined && { threadId: context.threadId }),
  });

  /** What `recall` and `forget` see: the user's memory and the thread's */
  const seenFrom = (context: BaseToolContext): MemoryItemScope => ({
    ...scopeOf(context),
    ...(context.threadId !== undefined && { threadId: context.threadId }),
  });

  /** The user message of the run's thread `quote` is found in, word for word */
  const quotedIn = async (
    quote: string | undefined,
    context: BaseToolContext
  ): Promise<MemoryEntry | undefined> => {
    if (!memory || !quote?.trim() || !context.threadId) return undefined;
    const entries = await memory.getEntries({ threadId: context.threadId, limit: QUOTE_LOOKBACK });
    if (!entries.success) return undefined;
    return [...entries.data]
      .reverse()
      .find(
        (entry) =>
          entry.message.role === 'user' &&
          verifyEvidence({ entryId: entry.id, quote }, entry) === 'verified'
      );
  };

  const remember = tool({
    name: 'remember',
    description:
      "Save a fact or piece of information to long-term memory. Use this when the user shares important information that should be remembered across conversations, and give the user's own words as the quote.",
    parameters: rememberParams,
    execute: async ({ fact, category, isCoreFact, coreFactKey, quote }, context) => {
      if (isCoreFact && !coreFactKey) {
        return { saved: false, error: 'coreFactKey is required when isCoreFact is true' };
      }

      const said = await quotedIn(quote, context);
      const usersOwn = memory ? said !== undefined : true;
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
        confidence: usersOwn ? 1 : 0.6,
        source: usersOwn ? 'user' : 'inferred',
        ...(said && quote && { evidence: [{ entryId: said.id, quote }] }),
      });

      if (!result.success) {
        return { saved: false, error: result.error };
      }

      const now = new Date();
      const evidence: Evidence[] = said && quote ? [{ entryId: said.id, quote }] : [];
      const [item] = items
        ? await items.write([
            {
              kind: 'fact',
              content: fact,
              trust: usersOwn ? 'user' : 'model',
              confidence: 0.9,
              scope: scopeOf(context),
              evidence,
              verified: evidence.length > 0,
              saidAt: said?.createdAt ?? now,
              sessionAt: now,
              ...(category && { metadata: { category } }),
            },
          ])
        : [];

      const coreFact = Boolean(isCoreFact && coreFactKey && coreFacts && usersOwn);
      if (coreFact && coreFactKey && coreFacts) {
        await coreFacts.set(coreFactKey, fact);
      }

      return {
        saved: true,
        id: result.data.id,
        ...(item && { status: item.status }),
        ...(!usersOwn && {
          note: "Kept as a suggestion: the quote was not found in the user's messages",
        }),
        ...(isCoreFact && !coreFact && coreFacts && { coreFact: false }),
      };
    },
  });

  const recall = tool({
    name: 'recall',
    description:
      'Search long-term memory for relevant facts and information. Returns both semantic matches from the knowledge graph and core facts.',
    parameters: recallParams,
    execute: async ({ query }, context) => {
      type ResultItem = { fact: string; type: string; confidence: number };
      const results: ResultItem[] = [];

      if (items) {
        for (const item of await items.query({
          scope: seenFrom(context),
          text: query,
          limit: 10,
        })) {
          results.push({ fact: item.content, type: 'memory', confidence: item.confidence });
        }
      }

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
      'Forget facts in long-term memory that match the given pattern: they are no longer recalled or used. Use with care.',
    parameters: forgetParams,
    execute: async ({ query }, context) => {
      const expired = items ? await items.query({ scope: seenFrom(context), text: query }) : [];
      if (items && expired.length > 0) await items.expire(expired.map((item) => item.id));
      const nodeQuery: NodeQuery = {
        agentId,
        namePattern: query,
      };
      const found = await graphAdapter.queryNodes(nodeQuery);

      const nodes: GraphNode[] = found.success ? found.data : [];
      const deletedNames: string[] = [];
      const failed: Array<{ id: string; name: string; error: string }> = [];

      for (const node of nodes) {
        const result = await graphAdapter.deleteNode(node.id);
        if (result.success) {
          deletedNames.push(node.name);
        } else {
          failed.push({ id: node.id, name: node.name, error: result.error });
        }
      }

      return {
        deleted: deletedNames.length,
        items: deletedNames,
        ...(failed.length > 0 && { failed }),
        ...(expired.length > 0 && { forgotten: expired.map((item) => item.content) }),
      };
    },
  });

  return toolset(remember, recall, forget);
}
