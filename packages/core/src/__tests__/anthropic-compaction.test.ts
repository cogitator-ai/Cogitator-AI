import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolCallMessage } from '@cogitator-ai/types';
import {
  anthropicCompactionSummarizer,
  ANTHROPIC_COMPACTION_BETA,
} from '../llm/anthropic-compaction';

function client(content: string | null) {
  const create = vi.fn(async () => ({
    content: [{ type: 'compaction', content, encrypted_content: null }],
  }));
  return { create, client: { beta: { messages: { create } } } as unknown as Anthropic };
}

describe('anthropicCompactionSummarizer', () => {
  it('asks Anthropic to compact with the prompt as instructions and answers with the summary', async () => {
    const { create, client: anthropic } = client('[{"kind":"fact","text":"x"}]');
    const summarize = anthropicCompactionSummarizer({
      model: 'claude-sonnet-5-5',
      client: anthropic,
    });

    const answer = await summarize([{ role: 'user', content: '[0] user: hello' }], {
      prompt: 'List the atoms',
    });

    expect(answer).toBe('[{"kind":"fact","text":"x"}]');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: '[0] user: hello' }],
        compaction: { type: 'summarize', instructions: 'List the atoms' },
        betas: [ANTHROPIC_COMPACTION_BETA],
      })
    );
  });

  it('reads an earlier summary, tool calls and their results as part of the conversation', async () => {
    const { create, client: anthropic } = client('summary');
    const summarize = anthropicCompactionSummarizer({
      model: 'claude-sonnet-5-5',
      client: anthropic,
    });

    const call: ToolCallMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.ts' } }],
    };
    await summarize([
      { role: 'system', content: '[Conversation summary]\nUser is Ana' },
      { role: 'user', content: 'Read a.ts' },
      call,
      { role: 'tool', content: 'export {}', toolCallId: 'c1', name: 'read' },
      { role: 'assistant', content: 'It is empty.' },
    ]);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'user', content: '[Conversation summary]\nUser is Ana\n\nRead a.ts' },
          { role: 'assistant', content: '[calls read {"path":"a.ts"}]' },
          { role: 'user', content: '[read result] export {}' },
          { role: 'assistant', content: 'It is empty.' },
        ],
      })
    );
  });

  it('fails when the compaction holds no summary', async () => {
    const { client: anthropic } = client(null);
    const summarize = anthropicCompactionSummarizer({
      model: 'claude-sonnet-5-5',
      client: anthropic,
    });

    await expect(summarize([{ role: 'user', content: 'x' }])).rejects.toThrow(/without a summary/);
  });
});
