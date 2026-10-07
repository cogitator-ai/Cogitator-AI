import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import type {
  Agent,
  ChatRequest,
  ChatResponse,
  LLMBackend,
  Message,
  Tool,
  ToolCall,
  ToolInvoker,
} from '@cogitator-ai/types';
import { SelfModifyingAgent } from '../self-modifying-agent';

function chatResponse(content: string, toolCalls?: ToolCall[]): ChatResponse {
  return {
    id: 'resp',
    content,
    toolCalls,
    finishReason: toolCalls?.length ? 'tool_calls' : 'stop',
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
  };
}

/** Calls `call` once, then answers with what the tool messages said. */
function scriptedLLM(call: ToolCall) {
  const seen: Message[][] = [];
  const llm: Partial<LLMBackend> = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => {
      seen.push([...request.messages]);
      const results = request.messages.filter((m) => m.role === 'tool');
      return results.length === 0
        ? chatResponse('', [call])
        : chatResponse(`Tool said: ${results.map((m) => String(m.content)).join(' | ')}`);
    }),
  };
  return { llm: llm as LLMBackend, seen };
}

function agentWith(tools: Tool[]): Agent {
  return {
    name: 'ops',
    model: 'test-model',
    instructions: 'Operate.',
    tools,
    config: { temperature: 0.5 },
  } as Agent;
}

const plainConfig = {
  toolGeneration: { enabled: false },
  metaReasoning: { enabled: false },
  architectureEvolution: { enabled: false },
  constraints: { enabled: false },
};

function execTool() {
  const execute = vi.fn(async ({ command }: { command: string }) => `ran ${command}`);
  const tool: Tool<{ command: string }, string> = {
    name: 'exec',
    description: 'Run a shell command',
    parameters: z.object({ command: z.string() }),
    requiresApproval: true,
    execute,
    toJSON: () => ({
      name: 'exec',
      description: 'Run a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    }),
  };
  return { tool: tool as Tool, execute };
}

const agents: SelfModifyingAgent[] = [];
function selfModifying(options: ConstructorParameters<typeof SelfModifyingAgent>[0]) {
  const agent = new SelfModifyingAgent(options);
  agents.push(agent);
  return agent;
}

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

describe('SelfModifyingAgent tool calls', () => {
  it('never run a tool that needs approval when nobody approves it', async () => {
    const { tool, execute } = execTool();
    const { llm } = scriptedLLM({
      id: 'c1',
      name: 'exec',
      arguments: { command: 'rm -rf /tmp/x' },
    });

    const result = await selfModifying({ agent: agentWith([tool]), llm, config: plainConfig }).run(
      'clean up'
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.output).toContain('needs approval');
  });

  it('run it once onApproval approves it', async () => {
    const { tool, execute } = execTool();
    const { llm } = scriptedLLM({ id: 'c1', name: 'exec', arguments: { command: 'ls' } });
    const onApproval = vi.fn(() => ({ approved: true as const }));

    const result = await selfModifying({
      agent: agentWith([tool]),
      llm,
      config: plainConfig,
      onApproval,
    }).run('list files');

    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'c1', toolName: 'exec', arguments: { command: 'ls' } })
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('ran ls');
  });

  it('run a tool whose parameters are a JSON schema instead of failing the run', async () => {
    const execute = vi.fn(async (args: unknown) => ({ got: args }));
    const jsonSchemaTool = {
      name: 'lookup',
      description: 'Look up',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      execute,
      toJSON: () => ({
        name: 'lookup',
        description: 'Look up',
        parameters: { type: 'object' as const, properties: { q: { type: 'string' } } },
      }),
    } as unknown as Tool;
    const { llm } = scriptedLLM({ id: 'c1', name: 'lookup', arguments: { q: 'cats' } });

    const result = await selfModifying({
      agent: agentWith([jsonSchemaTool]),
      llm,
      config: plainConfig,
    }).run('look up cats');

    expect(execute).toHaveBeenCalledWith({ q: 'cats' }, expect.anything());
    expect(result.output).toContain('"got":{"q":"cats"}');
  });

  it('hand every call to the given tool invoker, sandbox and all', async () => {
    const execute = vi.fn(async () => 'ran on the host');
    const sandboxed: Tool = {
      name: 'exec',
      description: 'Run a shell command',
      parameters: z.object({ command: z.string() }),
      sandbox: { type: 'docker', image: 'alpine' },
      execute,
      toJSON: () => ({
        name: 'exec',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      }),
    };
    const invokeTool = vi.fn<ToolInvoker['invokeTool']>(async (tool, _args, options) => ({
      callId: options?.toolCallId ?? '',
      name: tool.name,
      result: 'ran in the sandbox',
    }));
    const { llm } = scriptedLLM({ id: 'c9', name: 'exec', arguments: { command: 'ls' } });

    const result = await selfModifying({
      agent: agentWith([sandboxed]),
      llm,
      config: plainConfig,
      toolInvoker: { invokeTool },
    }).run('list files');

    expect(execute).not.toHaveBeenCalled();
    expect(invokeTool).toHaveBeenCalledWith(
      sandboxed,
      { command: 'ls' },
      expect.objectContaining({ toolCallId: 'c9' })
    );
    expect(result.output).toContain('ran in the sandbox');
  });

  it('keep the tool timeout', async () => {
    const slow: Tool = {
      name: 'slow',
      description: 'Slow',
      parameters: z.object({}),
      timeout: 20,
      execute: () => new Promise((resolve) => setTimeout(() => resolve('late'), 2_000)),
      toJSON: () => ({
        name: 'slow',
        description: 'Slow',
        parameters: { type: 'object', properties: {} },
      }),
    };
    const { llm } = scriptedLLM({ id: 'c1', name: 'slow', arguments: {} });

    const result = await selfModifying({ agent: agentWith([slow]), llm, config: plainConfig }).run(
      'go'
    );

    expect(result.output).toContain('timed out after 20ms');
  });
});
