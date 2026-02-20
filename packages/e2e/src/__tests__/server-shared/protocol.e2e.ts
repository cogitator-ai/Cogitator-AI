import { describe, it, expect } from 'vitest';
import {
  createStartEvent,
  createTextStartEvent,
  createTextDeltaEvent,
  createTextEndEvent,
  createToolCallStartEvent,
  createToolCallDeltaEvent,
  createToolCallEndEvent,
  createToolResultEvent,
  createErrorEvent,
  createFinishEvent,
  encodeSSE,
  encodeDone,
  generateId,
  generateOpenAPISpec,
} from '@cogitator-ai/server-shared';
import type { OpenAPIContext, SwaggerConfig } from '@cogitator-ai/server-shared';

describe('server-shared: protocol utilities', () => {
  it('event factories create correctly typed events', () => {
    const start = createStartEvent('msg-1');
    expect(start.type).toBe('start');
    expect(start.messageId).toBe('msg-1');

    const textStart = createTextStartEvent('t-1');
    expect(textStart.type).toBe('text-start');
    expect(textStart.id).toBe('t-1');

    const textDelta = createTextDeltaEvent('t-1', 'hello');
    expect(textDelta.type).toBe('text-delta');
    expect(textDelta.id).toBe('t-1');
    expect(textDelta.delta).toBe('hello');

    const textEnd = createTextEndEvent('t-1');
    expect(textEnd.type).toBe('text-end');
    expect(textEnd.id).toBe('t-1');

    const toolStart = createToolCallStartEvent('tc-1', 'calculator');
    expect(toolStart.type).toBe('tool-call-start');
    expect(toolStart.id).toBe('tc-1');
    expect(toolStart.toolName).toBe('calculator');

    const toolDelta = createToolCallDeltaEvent('tc-1', '{"x":1}');
    expect(toolDelta.type).toBe('tool-call-delta');
    expect(toolDelta.id).toBe('tc-1');
    expect(toolDelta.argsTextDelta).toBe('{"x":1}');

    const toolEnd = createToolCallEndEvent('tc-1');
    expect(toolEnd.type).toBe('tool-call-end');
    expect(toolEnd.id).toBe('tc-1');

    const toolResult = createToolResultEvent('tr-1', 'tc-1', { answer: 42 });
    expect(toolResult.type).toBe('tool-result');
    expect(toolResult.id).toBe('tr-1');
    expect(toolResult.toolCallId).toBe('tc-1');
    expect(toolResult.result).toEqual({ answer: 42 });

    const error = createErrorEvent('something failed', 'ERR_001');
    expect(error.type).toBe('error');
    expect(error.message).toBe('something failed');
    expect(error.code).toBe('ERR_001');

    const finish = createFinishEvent('msg-1', {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
    expect(finish.type).toBe('finish');
    expect(finish.messageId).toBe('msg-1');
    expect(finish.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
  });

  it('encodeSSE produces valid SSE format', () => {
    const encoded = encodeSSE({ type: 'test', data: 'hello' });

    expect(encoded.startsWith('data: ')).toBe(true);
    expect(encoded.endsWith('\n\n')).toBe(true);

    const jsonStr = encoded.slice('data: '.length, -2);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.type).toBe('test');
    expect(parsed.data).toBe('hello');

    expect(encodeDone()).toBe('data: [DONE]\n\n');
  });

  it('generateId produces unique prefixed IDs', () => {
    const ids = new Set<string>();

    for (let i = 0; i < 1000; i++) {
      const id = generateId('test');
      expect(id.startsWith('test')).toBe(true);
      ids.add(id);
    }

    expect(ids.size).toBe(1000);
  });

  it('OpenAPI spec generation includes agent endpoints', () => {
    const ctx: OpenAPIContext = {
      agents: {
        'test-agent': {
          config: {
            instructions: 'You are a test agent',
            tools: [{ name: 'greet', description: 'Say hello', parameters: { type: 'object' } }],
          },
        },
      },
      workflows: {},
      swarms: {},
    };

    const config: SwaggerConfig = {
      title: 'Test API',
      version: '0.1.0',
    };

    const spec = generateOpenAPISpec(ctx, config);

    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toBe('Test API');
    expect(spec.info.version).toBe('0.1.0');

    expect(spec.paths['/health']).toBeDefined();
    expect(spec.paths['/agents']).toBeDefined();
    expect(spec.paths['/agents/test-agent/run']).toBeDefined();
    expect(spec.paths['/agents/test-agent/stream']).toBeDefined();
  });
});
