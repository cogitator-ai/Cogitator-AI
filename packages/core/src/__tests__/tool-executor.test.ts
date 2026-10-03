import { describe, it, expect, vi } from 'vitest';
import type { ToolCall, ToolContext, ToolResult } from '@cogitator-ai/types';
import { z } from 'zod';
import { ToolRegistry } from '../registry';
import { tool } from '../tool';
import { createToolMessage, executeTool } from '../cogitator/tool-executor';
import type { SandboxManager } from '../cogitator/initializers';

const toolCall: ToolCall = {
  id: 'tc_1',
  name: 'search',
  arguments: { query: 'hello' },
};

describe('createToolMessage', () => {
  it('includes error in content when result has error', () => {
    const result: ToolResult = {
      callId: 'tc_1',
      name: 'search',
      result: null,
      error: 'Tool not found: search',
    };

    const msg = createToolMessage(toolCall, result);

    expect(msg.role).toBe('tool');
    expect(msg.toolCallId).toBe('tc_1');
    expect(msg.name).toBe('search');

    const parsed = JSON.parse(msg.content as string);
    expect(parsed.error).toBe('Tool not found: search');
  });

  it('returns JSON of result when no error', () => {
    const result: ToolResult = {
      callId: 'tc_1',
      name: 'search',
      result: { items: [1, 2, 3], total: 3 },
    };

    const msg = createToolMessage(toolCall, result);

    expect(msg.role).toBe('tool');
    const parsed = JSON.parse(msg.content as string);
    expect(parsed).toEqual({ items: [1, 2, 3], total: 3 });
  });

  it('delivers a base64 screenshot as an image after the rest of the result', () => {
    const msg = createToolMessage(toolCall, {
      callId: 'tc_1',
      name: 'search',
      result: { image: 'iVBORw0KGgoAAAANSUhEUg==', mimeType: 'image/png', width: 800, height: 600 },
    });

    expect(msg.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          mimeType: 'image/png',
          width: 800,
          height: 600,
          image: '(image attached)',
        }),
      },
      {
        type: 'image_base64',
        image_base64: { data: 'iVBORw0KGgoAAAANSUhEUg==', media_type: 'image/png' },
      },
    ]);
  });

  it('reads imageBase64 and data URLs, and keeps fields that are not images as JSON', () => {
    const generated = createToolMessage(toolCall, {
      callId: 'tc_1',
      name: 'search',
      result: { imageBase64: 'data:image/jpeg;base64,/9j/4AAQ', model: 'gpt-image' },
    });
    const caption = createToolMessage(toolCall, {
      callId: 'tc_1',
      name: 'search',
      result: { image: 'a cat on a mat' },
    });

    expect(generated.content).toEqual([
      { type: 'text', text: '{"model":"gpt-image","imageBase64":"(image attached)"}' },
      { type: 'image_base64', image_base64: { data: '/9j/4AAQ', media_type: 'image/jpeg' } },
    ]);
    expect(caption.content).toBe('{"image":"a cat on a mat"}');
  });

  it('returns "null" when result is null', () => {
    const result: ToolResult = {
      callId: 'tc_1',
      name: 'search',
      result: null,
    };

    const msg = createToolMessage(toolCall, result);

    expect(msg.content).toBe('null');
  });

  it('returns "null" when result is undefined', () => {
    const result: ToolResult = {
      callId: 'tc_1',
      name: 'search',
      result: undefined,
    };

    const msg = createToolMessage(toolCall, result);

    expect(msg.content).toBe('null');
  });

  it('returns string result correctly', () => {
    const result: ToolResult = {
      callId: 'tc_1',
      name: 'search',
      result: 'success',
    };

    const msg = createToolMessage(toolCall, result);

    expect(JSON.parse(msg.content as string)).toBe('success');
  });

  it('prioritizes error over result', () => {
    const result: ToolResult = {
      callId: 'tc_1',
      name: 'search',
      result: { data: 'some data' },
      error: 'Timeout exceeded',
    };

    const msg = createToolMessage(toolCall, result);

    const parsed = JSON.parse(msg.content as string);
    expect(parsed.error).toBe('Timeout exceeded');
    expect(parsed.data).toBeUndefined();
  });
});

describe('executeTool', () => {
  it('preserves run context when sandbox fallback executes natively', async () => {
    let capturedContext: ToolContext | undefined;
    const registry = new ToolRegistry();
    const signal = new AbortController().signal;
    const initializeSandbox = vi.fn(async () => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      registry.register(
        tool({
          name: 'sandboxed_tool',
          description: 'Sandboxed tool',
          parameters: z.object({ value: z.string() }),
          sandbox: { type: 'docker', image: 'alpine:latest' },
          execute: async ({ value }, context) => {
            capturedContext = context;
            return { value };
          },
        })
      );

      const result = await executeTool(
        registry,
        { id: 'tc_1', name: 'sandboxed_tool', arguments: { value: 'ok' } },
        'run_1',
        'agent_1',
        undefined,
        undefined,
        false,
        initializeSandbox,
        signal,
        {
          threadId: 'thread_1',
          userId: 'user_1',
          channelType: 'web',
          channelId: 'channel_1',
        }
      );

      expect(result).toEqual({ callId: 'tc_1', name: 'sandboxed_tool', result: { value: 'ok' } });
      expect(initializeSandbox).toHaveBeenCalledTimes(1);
      expect(capturedContext).toMatchObject({
        agentId: 'agent_1',
        runId: 'run_1',
        signal,
        threadId: 'thread_1',
        userId: 'user_1',
        channelType: 'web',
        channelId: 'channel_1',
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('refuses to run a Docker tool on the host when native fallback is off', async () => {
    const registry = new ToolRegistry();
    const nativeExecute = vi.fn(async () => ({ ran: true }));
    registry.register(
      tool({
        name: 'shell',
        description: 'Run shell',
        parameters: z.object({ command: z.string() }),
        sandbox: { type: 'docker', image: 'alpine:latest' },
        execute: nativeExecute,
      })
    );

    const result = await executeTool(
      registry,
      { id: 'tc_1', name: 'shell', arguments: { command: 'rm -rf ./data' } },
      'run_1',
      'agent_1',
      undefined,
      undefined,
      false,
      async () => undefined,
      undefined,
      undefined,
      false,
      false
    );

    expect(nativeExecute).not.toHaveBeenCalled();
    expect(result.error).toContain('sandbox.allowNativeFallback is false');
  });

  it('uses the sandbox manager created on first sandboxed call', async () => {
    const registry = new ToolRegistry();
    const nativeExecute = vi.fn(async () => ({ native: true }));
    registry.register(
      tool({
        name: 'shell',
        description: 'Run shell',
        parameters: z.object({ command: z.string() }),
        sandbox: { type: 'docker', image: 'alpine:latest' },
        execute: nativeExecute,
      })
    );

    const execute = vi.fn(async () => ({
      success: true,
      data: { stdout: 'hi\n', stderr: '', exitCode: 0, timedOut: false, duration: 5 },
    }));
    const manager: SandboxManager = {
      initialize: async () => undefined,
      execute,
      isDockerAvailable: async () => true,
      shutdown: async () => undefined,
    };
    const initializeSandbox = vi.fn(async () => manager);

    const result = await executeTool(
      registry,
      { id: 'tc_1', name: 'shell', arguments: { command: 'echo hi' } },
      'run_1',
      'agent_1',
      undefined,
      undefined,
      false,
      initializeSandbox
    );

    expect(initializeSandbox).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(nativeExecute).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({ stdout: 'hi\n', exitCode: 0, command: 'echo hi' });
  });

  it('enforces the per-tool timeout and aborts the tool signal', async () => {
    const registry = new ToolRegistry();
    let observedSignal: AbortSignal | undefined;
    registry.register(
      tool({
        name: 'slow',
        description: 'Never resolves on its own',
        parameters: z.object({}),
        timeout: 20,
        execute: (_args, context) => {
          observedSignal = context.signal;
          return new Promise(() => undefined);
        },
      })
    );

    const result = await executeTool(
      registry,
      { id: 'tc_1', name: 'slow', arguments: {} },
      'run_1',
      'agent_1',
      undefined,
      undefined,
      false,
      async () => undefined
    );

    expect(result.error).toBe('Tool "slow" timed out after 20ms');
    expect(observedSignal?.aborted).toBe(true);
  });

  it('propagates parent cancellation through a tool with a timeout', async () => {
    const registry = new ToolRegistry();
    registry.register(
      tool({
        name: 'slow',
        description: 'Never resolves on its own',
        parameters: z.object({}),
        timeout: 10_000,
        execute: () => new Promise(() => undefined),
      })
    );
    const parent = new AbortController();
    setTimeout(() => parent.abort(new Error('Run aborted by user')), 10);

    const result = await executeTool(
      registry,
      { id: 'tc_1', name: 'slow', arguments: {} },
      'run_1',
      'agent_1',
      undefined,
      undefined,
      false,
      async () => undefined,
      parent.signal
    );

    expect(result.error).toBe('Run aborted by user');
  });
});
