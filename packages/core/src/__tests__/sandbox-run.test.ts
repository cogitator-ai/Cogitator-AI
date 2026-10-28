import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLLMBackend, type MockChatResponse } from '@cogitator-ai/test-utils';
import type {
  CogitatorConfig,
  Message,
  PermissionDecisionEvent,
  ToolApprovalRequest,
  ToolCall,
  WorkspaceCommandSandbox,
} from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { exec } from '../tools/exec';
import { workspaceTools } from '../tools/workspace-tools';
import { LocalWorkspace } from '../workspace/local-workspace';

let base: string;
let root: string;
let workspace: LocalWorkspace;
let hostAnswers: Array<boolean | undefined>;

/** A sandbox that runs commands as they are and asks the call's decider about example.com first */
function askingSandbox(): WorkspaceCommandSandbox {
  return {
    kind: 'seatbelt',
    autoAllow: true,
    acceptsCommandDomains: true,
    async route() {
      return { sandboxed: true };
    },
    async start() {},
    async launch(launch) {
      const answer = launch.request.onUnknownHost
        ? await launch.request.onUnknownHost({
            host: 'example.com',
            port: 443,
            command: launch.command,
          })
        : undefined;
      hostAnswers.push(answer);
      return {
        file: launch.file,
        args: launch.args,
        cleanup: () => ({ sandbox: { sandboxed: true, kind: 'seatbelt', violations: [] } }),
      };
    },
  };
}

beforeEach(async () => {
  hostAnswers = [];
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-run-')));
  root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'notes.txt'), 'keep me');
  workspace = new LocalWorkspace({ root, exec: { sandbox: askingSandbox() } });
  await workspace.start();
});

afterEach(async () => {
  await workspace.dispose();
  rmSync(base, { recursive: true, force: true });
});

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  arguments: args,
});

const turn = (...calls: ToolCall[]): MockChatResponse => ({
  content: '',
  toolCalls: calls,
  finishReason: 'tool_calls',
});

function setup(responses: MockChatResponse[], config: CogitatorConfig = {}) {
  const backend = new MockLLMBackend().setResponses([...responses, { content: 'done' }]);
  return new Cogitator({
    memory: { adapter: 'memory' },
    ...config,
    llm: { backends: { mock: backend }, retry: false },
  });
}

const coder = (ws: LocalWorkspace = workspace) =>
  new Agent({
    name: 'coder',
    model: 'mock/m',
    instructions: 'You code.',
    tools: workspaceTools(),
    workspace: ws,
  });

function toolResults(messages: readonly Message[]): Array<Record<string, unknown>> {
  return messages
    .filter((m) => m.role === 'tool')
    .map((m) => {
      try {
        return JSON.parse(String(m.content)) as Record<string, unknown>;
      } catch {
        return { text: String(m.content) };
      }
    });
}

describe('a run in a sandboxed workspace', () => {
  it('runs run_command without an approval, even without permission setup', async () => {
    const cog = setup([turn(call('c1', 'run_command', { command: 'echo hello' }))]);
    const result = await cog.run(coder(), { input: 'go', threadId: 't-auto' });
    expect(result.status).toBe('completed');
    const [output] = toolResults(result.messages);
    expect(output.stdout).toBe('hello\n');
    expect(output.sandbox).toEqual({ sandboxed: true, kind: 'seatbelt', violations: [] });
    await cog.close();
  });

  it('still pauses without a sandbox', async () => {
    const plain = new LocalWorkspace({ root });
    const cog = setup([turn(call('c1', 'run_command', { command: 'echo hello' }))]);
    const result = await cog.run(coder(plain), { input: 'go', threadId: 't-plain' });
    expect(result.status).toBe('paused');
    await cog.close();
    await plain.dispose();
  });

  it('still pauses for exec and for run_command bound to a workspace without the sandbox', async () => {
    const plain = new LocalWorkspace({ root });
    for (const tools of [[exec], workspaceTools(plain)]) {
      const cog = setup([
        turn(call('c1', tools[0] === exec ? 'exec' : 'run_command', { command: 'echo hi > x' })),
      ]);
      const agent = new Agent({
        name: 'coder',
        model: 'mock/m',
        instructions: 'You code.',
        tools,
        workspace,
      });
      const result = await cog.run(agent, { input: 'go', threadId: `t-${tools.length}` });
      expect(result.status).toBe('paused');
      expect(existsSync(join(root, 'x'))).toBe(false);
      await cog.close();
    }
    await plain.dispose();
  });

  it('records the sandbox as what decided, and asks for a critical removal', async () => {
    const heard: PermissionDecisionEvent[] = [];
    const cog = setup(
      [
        turn(call('c1', 'run_command', { command: 'ls' })),
        turn(call('c2', 'run_command', { command: 'rm -rf .' })),
      ],
      { permissions: { ask: ['Bash'] } }
    );
    const result = await cog.run(coder(), {
      input: 'go',
      threadId: 't-rules',
      onPermissionDecision: (event) => heard.push(event),
    });
    expect(heard[0]).toMatchObject({ toolCallId: 'c1', decision: 'allow', decidedBy: 'sandbox' });
    expect(result.status).toBe('paused');
    expect(result.pendingApprovals?.[0]).toMatchObject({ toolCallId: 'c2' });
    expect(result.pendingApprovals?.[0].reason).toContain('critical path');
    expect(existsSync(join(root, 'notes.txt'))).toBe(true);
    await cog.close();
  });

  it('decides a host as a WebFetch call: rules first, then a person, remembered for the session', async () => {
    const onApproval = vi.fn(async (request: ToolApprovalRequest) => {
      if (request.toolName === 'WebFetch') return { approved: true as const };
      return { approved: true as const };
    });
    const cog = setup(
      [
        turn(call('c1', 'run_command', { command: 'echo fetch one' })),
        turn(call('c2', 'run_command', { command: 'echo fetch two' })),
      ],
      { permissions: { mode: 'default' } }
    );
    const result = await cog.run(coder(), { input: 'go', threadId: 't-host', onApproval });
    expect(result.status).toBe('completed');
    expect(hostAnswers).toEqual([true, true]);
    const asked = onApproval.mock.calls.filter(([request]) => request.toolName === 'WebFetch');
    expect(asked).toHaveLength(1);
    expect(asked[0][0]).toMatchObject({
      arguments: { url: 'https://example.com:443/', command: 'echo fetch one' },
      suggestedRule: 'WebFetch(domain:example.com)',
    });
    await cog.close();
  });

  it('asks the onApproval of a direct invokeTool about an unknown host', async () => {
    const onApproval = vi.fn(async (_request: ToolApprovalRequest) => ({
      approved: true as const,
    }));
    const cog = setup([], { permissions: { mode: 'default' } });
    const [runCommand] = workspaceTools(workspace, { tools: ['run_command'] });
    const result = await cog.invokeTool(
      runCommand,
      { command: 'echo fetch' },
      { onApproval, workspace }
    );
    expect(result.error).toBeUndefined();
    expect(hostAnswers).toEqual([true]);
    expect(onApproval.mock.calls.some(([request]) => request.toolName === 'WebFetch')).toBe(true);
    await cog.close();
  });

  it('lets a WebFetch deny rule refuse a host and an allow rule let it through without asking', async () => {
    const onApproval = vi.fn(async () => ({ approved: true as const }));
    const denied = setup([turn(call('c1', 'run_command', { command: 'echo fetch' }))], {
      permissions: { deny: ['WebFetch(domain:example.com)'] },
    });
    await denied.run(coder(), { input: 'go', threadId: 't-deny', onApproval });
    const allowed = setup([turn(call('c1', 'run_command', { command: 'echo fetch' }))], {
      permissions: { allow: ['WebFetch(domain:example.com)'] },
    });
    await allowed.run(coder(), { input: 'go', threadId: 't-allow', onApproval });
    expect(hostAnswers).toEqual([false, true]);
    expect(onApproval).not.toHaveBeenCalled();
    await denied.close();
    await allowed.close();
  });

  it('refuses hosts in dontAsk mode and allows them in bypassPermissions mode', async () => {
    for (const mode of ['dontAsk', 'bypassPermissions'] as const) {
      const cog = setup([turn(call('c1', 'run_command', { command: 'echo fetch' }))], {
        permissions: { mode },
      });
      await cog.run(coder(), { input: 'go', threadId: `t-${mode}` });
      await cog.close();
    }
    expect(hostAnswers).toEqual([false, true]);
  });

  it('deletes with delete_file into the trash, from where it comes back', async () => {
    const cog = setup([turn(call('c1', 'delete_file', { path: 'notes.txt' }))], {
      permissions: { mode: 'acceptEdits' },
    });
    const result = await cog.run(coder(), { input: 'clean up', threadId: 't-trash' });
    expect(result.status).toBe('completed');
    const [output] = toolResults(result.messages);
    expect(output).toMatchObject({ path: 'notes.txt', recoverable: true });
    expect(existsSync(join(root, 'notes.txt'))).toBe(false);
    const [entry] = await workspace.listTrash();
    expect(entry.path).toBe('notes.txt');
    await workspace.restoreFromTrash(entry.id);
    expect(existsSync(join(root, 'notes.txt'))).toBe(true);
    await cog.close();
  });
});
