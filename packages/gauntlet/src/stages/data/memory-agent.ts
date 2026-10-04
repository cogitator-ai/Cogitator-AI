import { Agent, tool } from '@cogitator-ai/core';
import { PostgresAdapter, unwrap } from '@cogitator-ai/memory';
import type {
  FactAdapter,
  EmbeddingAdapter,
  MemoryAdapter,
  MemoryConfig,
} from '@cogitator-ai/types';
import { z } from 'zod';
import type { StageDefinition } from '../../runner/types.js';
import {
  EMBEDDING_MODEL,
  dropPostgresSchema,
  openRouterEmbeddingConfig,
  openRouterEmbeddings,
  textOf,
  uniqueSuffix,
} from './support.js';

function hasFacts(adapter: MemoryAdapter): adapter is MemoryAdapter & FactAdapter {
  return 'addFact' in adapter && typeof adapter.addFact === 'function';
}

function hasEmbeddings(adapter: MemoryAdapter): adapter is MemoryAdapter & EmbeddingAdapter {
  return 'addEmbedding' in adapter && typeof adapter.addEmbedding === 'function';
}

/**
 * An agent on a Postgres-backed runtime: a tool result from one run is recalled by a fresh
 * runtime in the next run of the same thread, a stored fact and a stored document reach the
 * prompt through the context builder, and the thread is read back from Postgres directly.
 */
export const memoryAgentStage: StageDefinition = {
  id: 'memory-agent',
  title: 'Memory: agent across runs',
  description:
    'An agent on Postgres memory recalls a tool result in a later run on a fresh runtime, gets facts and semantic context from the context builder, and its thread is really in Postgres.',
  packages: ['@cogitator-ai/core', '@cogitator-ai/memory', '@cogitator-ai/types'],
  needs: ['handshake'],
  requires: [
    { kind: 'service', name: 'postgres' },
    {
      kind: 'env',
      name: 'OPENROUTER_API_KEY',
      why: `semantic context embeds with ${EMBEDDING_MODEL} through OpenRouter`,
    },
  ],
  timeoutMs: 180_000,
  async run(ctx) {
    const suffix = uniqueSuffix();
    const schema = `gauntlet_data_agent_${suffix}`;
    const connectionString = ctx.services.postgres;
    const threadId = `thread_concierge_${suffix}`;
    const agentId = `concierge_${suffix}`;
    const lockerCode = `${suffix.slice(0, 4).toUpperCase()}-QUILL`;
    const tea = 'Oriental Beauty oolong';
    const wifiPassword = `amber-falcon-${suffix.slice(4)}`;
    ctx.onCleanup(() => dropPostgresSchema(connectionString, schema));

    const memory: MemoryConfig = {
      adapter: 'postgres',
      postgres: { connectionString, schema, poolSize: 3 },
      embedding: openRouterEmbeddingConfig(),
      contextBuilder: {
        strategy: 'recent',
        maxTokens: 6000,
        includeFacts: true,
        includeSemanticContext: true,
      },
    };

    let lookups = 0;
    const lockerLookup = tool({
      name: 'locker_lookup',
      description: "Looks up the caller's office locker code. The service answers once per day.",
      parameters: z.object({}),
      execute: async () => {
        lookups += 1;
        return lookups === 1
          ? { lockerCode }
          : { error: 'The locker service is offline until tomorrow' };
      },
    });
    const concierge = () =>
      new Agent({
        id: agentId,
        name: 'concierge',
        model: ctx.model,
        instructions:
          'You are an office concierge. Answer in one or two short sentences. Use what you know from the conversation, the known facts and the relevant context.',
        tools: [lockerLookup],
        temperature: 0,
        maxIterations: 3,
      });

    const memoryErrors: string[] = [];
    const onMemoryError = (error: Error, operation: 'save' | 'load') => {
      memoryErrors.push(`${operation}: ${error.message}`);
    };
    const first = ctx.createCogitator({ memory });

    await ctx.check('seeds a fact and a document into the runtime memory', async (evidence) => {
      const store = await first.getMemory();
      if (!store)
        throw new Error('getMemory() returned no adapter, the Postgres memory did not connect');
      evidence('provider', store.provider);
      if (!hasFacts(store) || !hasEmbeddings(store))
        throw new Error('The Postgres store lacks facts or embeddings');
      unwrap(
        await store.addFact({
          agentId,
          content: `The user's favourite tea is ${tea}.`,
          category: 'preference',
          confidence: 1,
          source: 'user',
        })
      );
      const doc = `Office handbook: the staff wifi at the Lisbon office is called Cogi-Staff and its password is ${wifiPassword}.`;
      const vector = await openRouterEmbeddings().embed(doc);
      unwrap(
        await store.addEmbedding({
          sourceId: 'handbook-wifi',
          sourceType: 'document',
          vector,
          content: doc,
        })
      );
      evidence('vectorSize', vector.length);
    });

    await ctx.check('run 1 calls the tool and answers with its result', async (evidence) => {
      const run = await first.run(concierge(), {
        input: 'Please look up my locker code and tell me what it is.',
        threadId,
        signal: ctx.signal,
        onMemoryError,
      });
      evidence(
        'toolCalls',
        run.toolCalls.map((call) => call.name)
      );
      evidence('output', run.output.slice(0, 200));
      if (!run.toolCalls.some((call) => call.name === 'locker_lookup'))
        throw new Error('The agent did not call locker_lookup');
      if (!run.output.includes(lockerCode))
        throw new Error(`The answer lacks the code ${lockerCode}`);
    });

    const second = ctx.createCogitator({ memory });

    await ctx.check(
      'run 2 on a fresh runtime recalls the code from the stored thread',
      async (evidence) => {
        const run = await second.run(concierge(), {
          input: 'Remind me, what was my locker code? And which tea do I like?',
          threadId,
          signal: ctx.signal,
          onMemoryError,
        });
        const system = textOf(run.messages.find((message) => message.role === 'system')?.content);
        const replayed = run.messages.some((message) =>
          textOf(message.content).includes('look up my locker code')
        );
        evidence('output', run.output.slice(0, 200));
        evidence('historyReplayed', replayed);
        evidence('factsInPrompt', system.includes(tea));
        evidence(
          'toolCallsAgain',
          run.toolCalls.map((call) => call.name)
        );
        if (!replayed) throw new Error('The first run was not loaded into the prompt');
        if (!system.includes(tea))
          throw new Error('The context builder did not put the stored fact into the system prompt');
        if (!run.output.includes(lockerCode))
          throw new Error(`The answer lacks the code ${lockerCode}: ${run.output}`);
        if (!run.output.toLowerCase().includes('oolong'))
          throw new Error(`The answer lacks the tea from the facts: ${run.output}`);
      }
    );

    await ctx.check('run 3 answers from semantic context found in pgvector', async (evidence) => {
      const question = 'What is the password of the staff wifi at the Lisbon office?';
      const embeddings = openRouterEmbeddings();
      const store = await second.getMemory();
      if (!store || !hasEmbeddings(store))
        throw new Error('The second runtime has no embedding store');
      const [queryVector] = await embeddings.embedBatch([question]);
      const best = unwrap(await store.search({ vector: queryVector!, limit: 20, threshold: 0 }))[0];
      evidence('similarity', best ? Number(best.score.toFixed(3)) : null);
      const run = await second.run(concierge(), {
        input: question,
        threadId,
        signal: ctx.signal,
        onMemoryError,
      });
      const system = textOf(run.messages.find((message) => message.role === 'system')?.content);
      evidence('contextInPrompt', system.includes(wifiPassword));
      evidence('output', run.output.slice(0, 200));
      if (!system.includes(wifiPassword)) {
        throw new Error(
          `The handbook entry did not reach the prompt (similarity ${best?.score.toFixed(3) ?? 'n/a'}, the context builder only takes hits at 0.7 or more)`
        );
      }
      if (!run.output.includes(wifiPassword))
        throw new Error(`The answer lacks the password: ${run.output}`);
    });

    await ctx.check(
      'the thread is in Postgres, in order, with the tool exchange',
      async (evidence) => {
        const reader = new PostgresAdapter({
          provider: 'postgres',
          connectionString,
          schema,
          poolSize: 1,
        });
        unwrap(await reader.connect());
        try {
          const thread = unwrap(await reader.getThread(threadId));
          const entries = unwrap(await reader.getEntries({ threadId, includeToolCalls: true }));
          const roles = entries.map((entry) => entry.message.role);
          evidence('owner', thread?.agentId);
          evidence('roles', roles);
          evidence('reportedMemoryErrors', memoryErrors);
          if (thread?.agentId !== agentId)
            throw new Error(`Thread owner is ${thread?.agentId ?? 'missing'}`);
          const userTurns = entries
            .filter((entry) => entry.message.role === 'user')
            .map((entry) => textOf(entry.message.content));
          if (userTurns.length !== 3 || !userTurns[0]?.includes('look up my locker code')) {
            throw new Error(`Stored user turns: ${JSON.stringify(userTurns)}`);
          }
          const toolEntry = entries.find((entry) => entry.message.role === 'tool');
          const callEntry = entries.find((entry) => (entry.toolCalls?.length ?? 0) > 0);
          if (!toolEntry || !textOf(toolEntry.message.content).includes(lockerCode)) {
            throw new Error(
              `The tool exchange of run 1 is missing from the thread (${memoryErrors.length} memory errors were reported to onMemoryError)`
            );
          }
          if (callEntry?.toolCalls?.[0]?.name !== 'locker_lookup')
            throw new Error('The assistant tool call is not stored');
          const times = entries.map((entry) => entry.createdAt.getTime());
          if (times.some((time, index) => index > 0 && time < times[index - 1]!)) {
            throw new Error('Entries are not in chronological order');
          }
          if (roles[0] !== 'user' || roles.at(-1) !== 'assistant')
            throw new Error(`Thread starts with ${roles[0]} and ends with ${roles.at(-1)}`);
        } finally {
          await reader.disconnect();
        }
      }
    );
  },
};
