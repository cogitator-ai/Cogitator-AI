import type { Tool, ToolCall, ToolResult, ToolContext, Message } from '@cogitator-ai/types';
import { ToolRegistry } from '../registry';
import { getLogger } from '../logger';
import type { SandboxManager } from './initializers';
import type { ConstitutionalAI } from '../constitutional/index';

export async function executeTool(
  registry: ToolRegistry,
  toolCall: ToolCall,
  runId: string,
  agentId: string,
  sandboxManager: SandboxManager | undefined,
  constitutionalAI: ConstitutionalAI | undefined,
  filterToolCalls: boolean,
  initializeSandbox: () => Promise<void>,
  signal?: AbortSignal
): Promise<ToolResult> {
  const tool = registry.get(toolCall.name);

  if (!tool) {
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: `Tool not found: ${toolCall.name}`,
    };
  }

  const parseResult = tool.parameters.safeParse(toolCall.arguments);
  if (!parseResult.success) {
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: `Invalid arguments: ${parseResult.error.message}`,
    };
  }

  if (constitutionalAI && filterToolCalls) {
    const context: ToolContext = {
      agentId,
      runId,
      signal: signal ?? new AbortController().signal,
    };
    const guardResult = await constitutionalAI.guardTool(tool, toolCall.arguments, context);
    if (!guardResult.approved) {
      return {
        callId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Tool blocked: ${guardResult.reason ?? 'Policy violation'}`,
      };
    }
  }

  if (tool.sandbox?.type === 'docker' || tool.sandbox?.type === 'wasm') {
    return executeInSandbox(
      tool,
      { ...toolCall, arguments: parseResult.data as Record<string, unknown> },
      runId,
      agentId,
      sandboxManager,
      initializeSandbox
    );
  }

  const context: ToolContext = {
    agentId,
    runId,
    signal: signal ?? new AbortController().signal,
  };

  try {
    const result = await tool.execute(parseResult.data, context);
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result,
    };
  } catch (error) {
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function executeInSandbox(
  tool: Tool,
  toolCall: ToolCall,
  runId: string,
  agentId: string,
  sandboxManager: SandboxManager | undefined,
  initializeSandbox: () => Promise<void>
): Promise<ToolResult> {
  await initializeSandbox();

  if (!sandboxManager) {
    getLogger().warn('Sandbox unavailable, executing natively', { tool: tool.name });
    const context: ToolContext = {
      agentId,
      runId,
      signal: new AbortController().signal,
    };
    try {
      const result = await tool.execute(
        toolCall.arguments as Parameters<typeof tool.execute>[0],
        context
      );
      return { callId: toolCall.id, name: toolCall.name, result };
    } catch (error) {
      return {
        callId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const args = toolCall.arguments;
  const sandboxConfig = tool.sandbox!;

  const isWasm = sandboxConfig.type === 'wasm';
  const request = isWasm
    ? {
        command: [],
        stdin: JSON.stringify(args),
        timeout: tool.timeout,
      }
    : {
        command: ['sh', '-c', String(args.command ?? '')],
        cwd: args.cwd as string | undefined,
        env: args.env as Record<string, string> | undefined,
        timeout: tool.timeout,
      };

  const result = await sandboxManager.execute(request, sandboxConfig);

  if (!result.success) {
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: result.error,
    };
  }

  if (isWasm) {
    try {
      const parsed = JSON.parse(result.data!.stdout);
      return {
        callId: toolCall.id,
        name: toolCall.name,
        result: parsed,
      };
    } catch {
      return {
        callId: toolCall.id,
        name: toolCall.name,
        result: result.data!.stdout,
      };
    }
  }

  return {
    callId: toolCall.id,
    name: toolCall.name,
    result: {
      stdout: result.data!.stdout,
      stderr: result.data!.stderr,
      exitCode: result.data!.exitCode,
      timedOut: result.data!.timedOut,
      duration: result.data!.duration,
      command: args.command,
    },
  };
}

export function createToolMessage(toolCall: ToolCall, result: ToolResult): Message {
  const content = result.error
    ? JSON.stringify({ error: result.error })
    : JSON.stringify(result.result ?? null);
  return {
    role: 'tool',
    content,
    toolCallId: toolCall.id,
    name: toolCall.name,
  };
}
