import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { ToolCall } from '@cogitator-ai/types';
import { createToolMessage, executeTool } from '../cogitator/tool-executor';
import { ToolRegistry } from '../registry';
import { tool } from '../tool';
import {
  toolContent,
  isToolContentResult,
  toolResultParts,
  toolPartsToText,
} from '../tool-content';
import type { ConstitutionalAI } from '../constitutional/index';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const AUDIO = Buffer.alloc(48_000, 7).toString('base64');

const call: ToolCall = { id: 'call_1', name: 'screenshot', arguments: {} };

describe('tool results with media', () => {
  it('sends the images of a content result to the model as image parts', () => {
    const message = createToolMessage(call, {
      callId: 'call_1',
      name: 'screenshot',
      result: {
        type: 'tool-content',
        content: [
          { type: 'text', text: 'Screenshot of https://example.com' },
          { type: 'image', data: PNG, mediaType: 'image/png' },
        ],
      },
    });

    expect(message.content).toEqual([
      { type: 'text', text: 'Screenshot of https://example.com' },
      { type: 'image_base64', image_base64: { data: PNG, media_type: 'image/png' } },
    ]);
  });

  it('describes files instead of putting their bytes in the context', () => {
    const message = createToolMessage(call, {
      callId: 'call_1',
      name: 'speak_text',
      result: {
        type: 'tool-content',
        content: [
          { type: 'text', text: 'Synthesized speech' },
          { type: 'file', data: AUDIO, mediaType: 'audio/mpeg', filename: 'speech.mp3' },
        ],
      },
    });

    expect(typeof message.content).toBe('string');
    expect(message.content).not.toContain(AUDIO.slice(0, 32));
    expect(message.content).toContain('audio/mpeg file "speech.mp3", 46.9 KB');
  });

  it('describes images in formats models cannot take', () => {
    const message = createToolMessage(call, {
      callId: 'call_1',
      name: 'render',
      result: toolContent({ type: 'image', data: 'PHN2Zz48L3N2Zz4=', mediaType: 'image/svg+xml' }),
    });

    expect(message.content).toBe('[image/svg+xml image, 11 B]');
  });

  it('strips data URL prefixes and recognizes only well-formed content results', () => {
    const result = toolContent({
      type: 'image',
      data: `data:image/png;base64,${PNG}`,
      mediaType: 'image/png',
    });

    expect(result.content[0]).toEqual({ type: 'image', data: PNG, mediaType: 'image/png' });
    expect(isToolContentResult(result)).toBe(true);
    expect(isToolContentResult({ type: 'tool-content', content: [{ type: 'image' }] })).toBe(false);
    expect(isToolContentResult({ type: 'tool-content' })).toBe(false);
  });

  it('reads screenshot objects as text and an image', () => {
    expect(toolResultParts({ image: PNG, width: 1 })).toEqual([
      { type: 'text', text: '{"width":1,"image":"(image attached)"}' },
      { type: 'image', data: PNG, mediaType: 'image/png' },
    ]);
    expect(toolResultParts({ image: 'a cat' })).toBeUndefined();
  });

  it('lets guardrails read the text of a media result, not its base64', async () => {
    const filterToolResult = vi.fn(async () => ({ allowed: true }));
    const constitutionalAI = {
      guardTool: vi.fn(async () => ({ approved: true })),
      filterToolResult,
    } as unknown as ConstitutionalAI;
    const registry = new ToolRegistry();
    registry.register(
      tool({
        name: 'speak_text',
        description: 'Speak',
        parameters: z.object({}),
        execute: async () =>
          toolContent(
            { type: 'text', text: 'Spoken' },
            { type: 'file', data: AUDIO, mediaType: 'audio/mpeg' }
          ),
      })
    );

    await executeTool(
      registry,
      { id: 'c1', name: 'speak_text', arguments: {} },
      'run_1',
      'agent_1',
      undefined,
      constitutionalAI,
      true,
      async () => undefined
    );

    expect(filterToolResult).toHaveBeenCalledWith(
      'speak_text',
      toolPartsToText([
        { type: 'text', text: 'Spoken' },
        { type: 'file', data: AUDIO, mediaType: 'audio/mpeg' },
      ])
    );
    expect(filterToolResult.mock.calls[0]).not.toContain(AUDIO);
  });
});
