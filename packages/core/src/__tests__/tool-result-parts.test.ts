import { describe, it, expect } from 'vitest';
import type { ToolCall, ToolResult } from '@cogitator-ai/types';
import { createToolMessage } from '../cogitator/tool-executor';
import {
  DEFAULT_TOOL_RESULT_MAX_LENGTH,
  isToolContentResult,
  toolContent,
  toolPartsToMessageContent,
  toolPartsToText,
  truncateToolResultText,
} from '../tool-content';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const call: ToolCall = { id: 'call_1', name: 'read', arguments: {} };
const ok = (result: unknown): ToolResult => ({ callId: 'call_1', name: 'read', result });

describe('json parts', () => {
  it('reach the model as JSON text while the application keeps the value', () => {
    const value = { rows: [{ id: 1, name: 'Ada' }], total: 1 };
    const result = toolContent({ type: 'text', text: 'Query done' }, { type: 'json', value });

    expect(createToolMessage(call, ok(result)).content).toBe(
      `Query done\n${JSON.stringify(value)}`
    );
    expect(result.content[1]).toEqual({ type: 'json', value });
  });

  it('describe values JSON cannot hold instead of throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toolPartsToText([{ type: 'json', value: cyclic }])).toBe('[object Object]');
    expect(toolPartsToText([{ type: 'json', value: undefined }])).toBe('null');
    expect(toolPartsToText([{ type: 'json', value: 10n }])).toBe('10');
  });
});

describe('resource parts', () => {
  it('give the model the text of a text resource under a line naming it', () => {
    const text = toolPartsToText([
      {
        type: 'resource',
        uri: 'file:///repo/README.md',
        name: 'README.md',
        mediaType: 'text/markdown',
        text: '# Hello',
      },
    ]);
    expect(text).toBe('[resource "README.md" file:///repo/README.md (text/markdown)]\n# Hello');
  });

  it('describe a binary resource and keep its bytes out of the context', () => {
    const data = Buffer.alloc(2048, 1).toString('base64');
    const text = toolPartsToText([
      {
        type: 'resource',
        uri: 'https://example.com/report.pdf',
        mediaType: 'application/pdf',
        data,
      },
    ]);
    expect(text).toBe(
      '[resource https://example.com/report.pdf (application/pdf), 2.0 KB, delivered to the application, not shown here]'
    );
    expect(text).not.toContain(data.slice(0, 20));
  });

  it('name a linked resource with its description', () => {
    expect(
      toolPartsToText([
        {
          type: 'resource',
          uri: 'https://example.com/issues/7',
          name: 'Issue 7',
          description: 'Login fails on Safari',
        },
      ])
    ).toBe('[resource "Issue 7" https://example.com/issues/7 - Login fails on Safari]');
  });

  it('lose the data URL prefix of binary contents', () => {
    const result = toolContent({
      type: 'resource',
      uri: 'attachment:///a.bin',
      data: 'data:application/octet-stream;base64,AAAA',
    });
    expect(result.content[0]).toMatchObject({ data: 'AAAA' });
  });

  it('count as content only when well formed', () => {
    const parts = (part: unknown) => ({ type: 'tool-content', content: [part] });
    expect(isToolContentResult(parts({ type: 'resource', uri: 'file:///a' }))).toBe(true);
    expect(isToolContentResult(parts({ type: 'json', value: null }))).toBe(true);
    expect(isToolContentResult(parts({ type: 'json' }))).toBe(false);
    expect(isToolContentResult(parts({ type: 'resource', uri: 7 }))).toBe(false);
    expect(isToolContentResult(parts({ type: 'resource', uri: 'file:///a', name: 1 }))).toBe(false);
    expect(
      isToolContentResult(parts({ type: 'resource', uri: 'file:///a', text: 'x', data: 'AAAA' }))
    ).toBe(false);
  });
});

describe('the size of a tool result the model reads', () => {
  it('is left alone up to the limit', () => {
    expect(truncateToolResultText('abc', 3)).toBe('abc');
    expect(truncateToolResultText('abc', Infinity)).toBe('abc');
  });

  it('keeps the start and the end of a longer text with a note of what was left out', () => {
    const text = `${'a'.repeat(600)}${'m'.repeat(1000)}${'z'.repeat(400)}`;
    const cut = truncateToolResultText(text, 1000);

    expect(cut.startsWith('a'.repeat(600))).toBe(true);
    expect(cut.endsWith('z'.repeat(250))).toBe(true);
    expect(cut).toContain('[... 1000 of 2000 characters of this tool result were left out ...]');
    const kept = cut.replace(/\n\n\[\.\.\. .* \.\.\.\]\n\n/, '');
    expect(kept).toHaveLength(1000);
  });

  it('never splits a surrogate pair', () => {
    const text = '😀'.repeat(100);
    const cut = truncateToolResultText(text, 51);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(cut).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('is cut by default at DEFAULT_TOOL_RESULT_MAX_LENGTH characters', () => {
    const huge = 'x'.repeat(DEFAULT_TOOL_RESULT_MAX_LENGTH * 3);
    const content = createToolMessage(call, ok(huge)).content as string;
    expect(content.length).toBeLessThan(DEFAULT_TOOL_RESULT_MAX_LENGTH + 200);
    expect(content).toContain('characters of this tool result were left out');
  });

  it('follows the limit given for the message, for results, errors and parts', () => {
    const long = 'y'.repeat(5000);
    expect((createToolMessage(call, ok(long), 100).content as string).length).toBeLessThan(200);

    const failed = createToolMessage(call, { ...ok(null), error: long }, 100).content as string;
    expect(JSON.parse(failed).error).toContain('were left out');

    const parts = toolPartsToMessageContent(
      [
        { type: 'text', text: 'a'.repeat(3000) },
        { type: 'image', data: PNG, mediaType: 'image/png' },
        { type: 'text', text: 'b'.repeat(1000) },
      ],
      400
    );
    expect(parts).toEqual([
      {
        type: 'text',
        text: `${'a'.repeat(300)}\n\n[... 3600 of 4000 characters of this tool result were left out ...]`,
      },
      { type: 'image_base64', image_base64: { data: PNG, media_type: 'image/png' } },
      { type: 'text', text: 'b'.repeat(100) },
    ]);
  });

  it('cuts the text parts of a media result as one text, so a short first part survives', () => {
    const status = 'Status: FAILED (exit 2)';
    const parts = toolPartsToMessageContent(
      [
        { type: 'text', text: status },
        { type: 'text', text: 'log '.repeat(250_000) },
        { type: 'image', data: PNG, mediaType: 'image/png' },
      ],
      DEFAULT_TOOL_RESULT_MAX_LENGTH
    ) as Array<{ type: string; text?: string }>;

    expect(parts[0]).toEqual({ type: 'text', text: status });
    expect(parts.at(-1)?.type).toBe('image_base64');
    const text = parts.map((part) => part.text ?? '').join('');
    expect(text.length).toBeLessThan(DEFAULT_TOOL_RESULT_MAX_LENGTH + 200);
  });

  it('leaves out whole parts in the middle with one note, never one note per part', () => {
    const many = Array.from({ length: 2000 }, (_, id) => ({
      type: 'json' as const,
      value: { id, name: `item-${id}`, tags: ['a', 'b'] },
    }));
    const parts = toolPartsToMessageContent(
      [...many, { type: 'image', data: PNG, mediaType: 'image/png' }],
      10_000
    ) as Array<{ type: string; text?: string }>;

    const texts = parts.filter((part) => part.type === 'text').map((part) => part.text!);
    expect(texts.filter((text) => text.includes('were left out'))).toHaveLength(1);
    expect(texts.join('').length).toBeLessThan(10_200);
    expect(texts[0]).toBe(JSON.stringify(many[0]!.value));
    expect(parts.at(-1)?.type).toBe('image_base64');
  });

  it('rounds a fractional limit down and keeps the note honest', () => {
    const cut = truncateToolResultText('abcdefghij', 1.5);
    expect(cut).toBe('a\n\n[... 9 of 10 characters of this tool result were left out ...]');
  });

  it('leaves a short media result as it is', () => {
    const parts = toolPartsToMessageContent([
      { type: 'text', text: 'Screenshot' },
      { type: 'image', data: PNG, mediaType: 'image/png' },
    ]);
    expect(parts).toEqual([
      { type: 'text', text: 'Screenshot' },
      { type: 'image_base64', image_base64: { data: PNG, media_type: 'image/png' } },
    ]);
  });
});
