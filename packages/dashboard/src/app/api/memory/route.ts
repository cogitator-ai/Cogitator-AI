import { NextResponse } from 'next/server';
import { createEmbeddingService } from '@cogitator-ai/memory';
import { query, queryOne } from '@/lib/db';
import { withAuth } from '@/lib/auth/middleware';

export const GET = withAuth(async (request) => {
  try {
    const searchParams = request.nextUrl.searchParams;
    const action = searchParams.get('action');

    switch (action) {
      case 'threads': {
        const agentId = searchParams.get('agentId');
        let sql = `
          SELECT
            thread_id as id,
            agent_id,
            title,
            metadata,
            COUNT(*) as message_count,
            MAX(created_at) as last_message_at,
            MIN(created_at) as created_at
          FROM dashboard_messages
          GROUP BY thread_id, agent_id, title, metadata
          ORDER BY last_message_at DESC
        `;
        const params: string[] = [];
        if (agentId) {
          sql = sql.replace('ORDER BY', 'HAVING agent_id = $1 ORDER BY');
          params.push(agentId);
        }
        const threads = await query(sql, params);
        return NextResponse.json(threads);
      }

      case 'entries': {
        const threadId = searchParams.get('threadId');
        if (!threadId) {
          return NextResponse.json({ error: 'threadId required' }, { status: 400 });
        }
        const entries = await query(
          `SELECT * FROM dashboard_messages WHERE thread_id = $1 ORDER BY created_at ASC`,
          [threadId]
        );
        return NextResponse.json(entries);
      }

      case 'stats': {
        const stats = await queryOne<{
          total_entries: string;
          total_threads: string;
          total_tokens: string;
        }>(`
          SELECT
            COUNT(*) as total_entries,
            COUNT(DISTINCT thread_id) as total_threads,
            COALESCE(SUM(tokens), 0) as total_tokens
          FROM dashboard_messages
        `);
        return NextResponse.json({
          totalEntries: parseInt(stats?.total_entries || '0'),
          totalThreads: parseInt(stats?.total_threads || '0'),
          totalTokens: parseInt(stats?.total_tokens || '0'),
        });
      }

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    console.error('[api/memory] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Memory operation failed' },
      { status: 500 }
    );
  }
});

export const POST = withAuth(async (request) => {
  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      case 'semantic-search': {
        const { query: searchQuery, threadId, limit = 10 } = body;

        if (!searchQuery || typeof searchQuery !== 'string') {
          return NextResponse.json({ error: 'query is required' }, { status: 400 });
        }

        let embeddingService;
        const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';

        if (process.env.OPENAI_API_KEY) {
          embeddingService = createEmbeddingService({
            provider: 'openai',
            apiKey: process.env.OPENAI_API_KEY,
            model: 'text-embedding-3-small',
          });
        } else {
          embeddingService = createEmbeddingService({
            provider: 'ollama',
            baseUrl: ollamaUrl,
            model: 'nomic-embed-text',
          });
        }

        console.log('[memory] Generating embedding for query:', searchQuery.slice(0, 50));
        const queryEmbedding = await embeddingService.embed(searchQuery);

        const results = await query<{
          id: string;
          thread_id: string;
          role: string;
          content: string;
          created_at: Date;
          similarity: number;
        }>(`
          SELECT
            id,
            thread_id,
            role,
            content,
            created_at,
            1 - (embedding <=> $1::vector) as similarity
          FROM dashboard_messages
          WHERE embedding IS NOT NULL
          ${threadId ? 'AND thread_id = $3' : ''}
          ORDER BY embedding <=> $1::vector
          LIMIT $2
        `, threadId
          ? [`[${queryEmbedding.join(',')}]`, limit, threadId]
          : [`[${queryEmbedding.join(',')}]`, limit]
        );

        return NextResponse.json({
          query: searchQuery,
          results: results.map(r => ({
            id: r.id,
            threadId: r.thread_id,
            role: r.role,
            content: r.content,
            createdAt: r.created_at,
            similarity: r.similarity,
          })),
        });
      }

      case 'build-context': {
        const { threadId, maxTokens = 8000, strategy = 'recent' } = body;

        if (!threadId) {
          return NextResponse.json({ error: 'threadId is required' }, { status: 400 });
        }

        const messages = await query<{
          role: string;
          content: string;
          created_at: Date;
        }>(`
          SELECT role, content, created_at
          FROM dashboard_messages
          WHERE thread_id = $1
          ORDER BY created_at ${strategy === 'recent' ? 'DESC' : 'ASC'}
          LIMIT $2
        `, [threadId, Math.floor(maxTokens / 100)]);

        const orderedMessages = strategy === 'recent' ? messages.reverse() : messages;

        let tokenCount = 0;
        const contextMessages = [];
        for (const msg of orderedMessages) {
          const msgTokens = Math.ceil(msg.content.length / 4);
          if (tokenCount + msgTokens > maxTokens) break;
          tokenCount += msgTokens;
          contextMessages.push({
            role: msg.role,
            content: msg.content,
          });
        }

        return NextResponse.json({
          threadId,
          strategy,
          maxTokens,
          context: {
            messages: contextMessages,
            tokenCount,
            truncated: orderedMessages.length > contextMessages.length,
            facts: [],
          },
        });
      }

      case 'add-embedding': {
        const { messageId, content } = body;

        if (!messageId || !content) {
          return NextResponse.json({ error: 'messageId and content required' }, { status: 400 });
        }

        let embeddingService;
        const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';

        if (process.env.OPENAI_API_KEY) {
          embeddingService = createEmbeddingService({
            provider: 'openai',
            apiKey: process.env.OPENAI_API_KEY,
            model: 'text-embedding-3-small',
          });
        } else {
          embeddingService = createEmbeddingService({
            provider: 'ollama',
            baseUrl: ollamaUrl,
            model: 'nomic-embed-text',
          });
        }

        const embedding = await embeddingService.embed(content);

        await query(
          `UPDATE dashboard_messages SET embedding = $1::vector WHERE id = $2`,
          [`[${embedding.join(',')}]`, messageId]
        );

        return NextResponse.json({ success: true, dimensions: embedding.length });
      }

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    console.error('[api/memory] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Memory operation failed' },
      { status: 500 }
    );
  }
});
