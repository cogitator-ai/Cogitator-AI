import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tool, workspaceTools } from '@cogitator-ai/core';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import {
  answer,
  callTools,
  connectClient,
  createTestAgent,
  messageText,
  scriptedBackend,
  waitUntil,
} from './helpers';

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'acp-agent-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const deploy = tool({
  name: 'deploy',
  description: 'Deploys',
  parameters: z.object({ target: z.string() }),
  requiresApproval: true,
  execute: async ({ target }) => `deployed ${target}`,
});

describe('AcpAgent', () => {
  it('initializes with its capabilities and an auth method the registry accepts', async () => {
    const { acp } = createTestAgent({ backend: new MockLLMBackend() });
    const editor = connectClient(acp);
    const init = await editor.initialize();
    expect(init.protocolVersion).toBe(1);
    expect(init.agentCapabilities).toMatchObject({
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: { list: {}, delete: {}, resume: {}, close: {} },
    });
    expect(init.authMethods).toEqual([expect.objectContaining({ id: 'cogitator' })]);
    expect(await editor.agent.request('authenticate', { methodId: 'cogitator' })).toEqual({});
    await expect(editor.agent.request('authenticate', { methodId: 'nope' })).rejects.toThrow();
    await acp.close();
  });

  it('runs a prompt as a turn of the session thread and streams it as message chunks', async () => {
    const backend = new MockLLMBackend().setStreamChunks([
      { content: 'Hello ' },
      { content: 'there' },
    ]);
    const { acp, host } = createTestAgent({ backend });
    const editor = connectClient(acp);
    await editor.initialize();
    const session = await editor.agent.request('session/new', { cwd: dir, mcpServers: [] });
    expect(session.modes).toMatchObject({ currentModeId: 'default' });
    expect(session.configOptions?.map((option) => [option.id, option.category])).toEqual([
      ['mode', 'mode'],
      ['model', 'model'],
      ['reasoning_effort', 'thought_level'],
    ]);
    const response = await editor.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Say hello' }],
    });
    expect(response.stopReason).toBe('end_turn');
    const updates = editor.updates(session.sessionId);
    expect(messageText(updates)).toBe('Hello there');
    expect(updates).toContainEqual(
      expect.objectContaining({ sessionUpdate: 'session_info_update', title: 'Say hello' })
    );
    const thread = await host.resumeThread(session.sessionId);
    expect(thread.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Say hello'],
      ['assistant', 'Hello there'],
    ]);
    expect(thread.thread.metadata).toMatchObject({ 'acp.cwd': dir, title: 'Say hello' });
    await acp.close();
  });

  it('offers the runtime commands and the agent skills, and expands a skill prompt', async () => {
    const skills = join(dir, '.agents', 'skills', 'deploy-check');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(skills, { recursive: true });
    writeFileSync(
      join(skills, 'SKILL.md'),
      '---\nname: deploy-check\ndescription: Checks a deploy\n---\nCheck the deploy.'
    );
    const scripted = scriptedBackend([answer('checked')]);
    const { acp } = createTestAgent({
      backend: scripted.backend,
      agent: { skills: [{ workspace: true }] },
      config: {
        commands: {
          commands: { review: { template: 'Review $ARGUMENTS', argumentHint: '[path]' } },
        },
      },
    });
    const editor = connectClient(acp);
    await editor.initialize();
    const { sessionId } = await editor.agent.request('session/new', { cwd: dir, mcpServers: [] });
    await waitUntil(() =>
      editor.updates(sessionId).some((u) => u.sessionUpdate === 'available_commands_update')
    );
    const update = editor
      .updates(sessionId)
      .find((u) => u.sessionUpdate === 'available_commands_update');
    expect(update).toMatchObject({
      availableCommands: [
        { name: 'review', input: { hint: '[path]' } },
        { name: 'deploy-check', description: 'Checks a deploy' },
      ],
    });
    await editor.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/deploy-check staging' }],
    });
    const user = scripted.requests[0]!.messages.filter((m) => m.role === 'user').at(-1);
    expect(user?.content).toContain('Use the deploy-check skill');
    await acp.close();
  });

  it('asks session/request_permission and saves an always answer as a rule', async () => {
    const scripted = scriptedBackend([
      callTools([{ id: 'c1', name: 'deploy', arguments: { target: 'prod' } }]),
      answer('done one'),
      callTools([{ id: 'c2', name: 'deploy', arguments: { target: 'prod' } }]),
      answer('done two'),
    ]);
    const { acp } = createTestAgent({
      backend: scripted.backend,
      agent: { tools: [deploy] },
      config: { permissions: {} },
    });
    const editor = connectClient(acp, {
      onPermission: () => ({ outcome: { outcome: 'selected', optionId: 'allow_always' } }),
    });
    await editor.initialize();
    const { sessionId } = await editor.agent.request('session/new', { cwd: dir, mcpServers: [] });
    await editor.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'ship' }],
    });
    await editor.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'ship again' }],
    });
    expect(editor.permissions).toHaveLength(1);
    expect(editor.permissions[0]).toMatchObject({
      sessionId,
      toolCall: {
        toolCallId: 'c1',
        kind: 'other',
        status: 'pending',
        rawInput: { target: 'prod' },
      },
    });
    expect(editor.permissions[0]!.options.map((option) => option.kind)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
      'reject_always',
    ]);
    const updates = editor.updates(sessionId);
    expect(updates).toContainEqual(
      expect.objectContaining({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'deploy' })
    );
    expect(updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c2',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'deployed prod' } }],
      })
    );
    await acp.close();
  });

  it('refuses calls after reject_always without asking again', async () => {
    const scripted = scriptedBackend([
      callTools([{ id: 'c1', name: 'deploy', arguments: { target: 'prod' } }]),
      answer('refused'),
      callTools([{ id: 'c2', name: 'deploy', arguments: { target: 'prod' } }]),
      answer('refused again'),
    ]);
    const { acp } = createTestAgent({
      backend: scripted.backend,
      agent: { tools: [deploy] },
      config: { permissions: {} },
    });
    const editor = connectClient(acp, {
      onPermission: () => ({ outcome: { outcome: 'selected', optionId: 'reject_always' } }),
    });
    await editor.initialize();
    const { sessionId } = await editor.agent.request('session/new', { cwd: dir, mcpServers: [] });
    for (const text of ['ship', 'ship again']) {
      await editor.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    }
    expect(editor.permissions).toHaveLength(1);
    const failed = editor
      .updates(sessionId)
      .filter((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'failed');
    expect(failed.map((u) => (u.sessionUpdate === 'tool_call_update' ? u.toolCallId : ''))).toEqual(
      ['c1', 'c2']
    );
    await acp.close();
  });

  it('sends the todo list as the plan and hides write_todos', async () => {
    const scripted = scriptedBackend([
      callTools([
        {
          id: 't1',
          name: 'write_todos',
          arguments: {
            todos: [
              { id: 'a', content: 'Read the code', status: 'completed' },
              { id: 'b', content: 'Fix the bug', status: 'in_progress' },
            ],
          },
        },
      ]),
      answer('planned'),
    ]);
    const { acp } = createTestAgent({ backend: scripted.backend, agent: { todos: true } });
    const editor = connectClient(acp);
    await editor.initialize();
    const { sessionId } = await editor.agent.request('session/new', { cwd: dir, mcpServers: [] });
    await editor.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    });
    const updates = editor.updates(sessionId);
    expect(updates).toContainEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read the code', priority: 'medium', status: 'completed' },
        { content: 'Fix the bug', priority: 'medium', status: 'in_progress' },
      ],
    });
    expect(
      updates.some(
        (u) =>
          (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') &&
          u.toolCallId === 't1'
      )
    ).toBe(false);
    await acp.close();
  });

  it('edits files through the editor with a diff in the question, and runs commands in its terminals', async () => {
    writeFileSync(join(dir, 'app.ts'), 'const a = 1;\n');
    const scripted = scriptedBackend([
      callTools([
        {
          id: 'e1',
          name: 'edit_file',
          arguments: { path: 'app.ts', oldString: 'a = 1', newString: 'a = 2' },
        },
      ]),
      callTools([{ id: 'r1', name: 'run_command', arguments: { command: 'npm test' } }]),
      answer('edited and tested'),
    ]);
    const { acp } = createTestAgent({
      backend: scripted.backend,
      agent: { tools: workspaceTools() },
      config: { permissions: {} },
    });
    const files = new Map([[join(dir, 'app.ts'), 'const a = 1; // unsaved\n']]);
    const editor = connectClient(acp, {
      capabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      files,
      terminal: () => ({ output: 'all tests passed', exitCode: 0 }),
    });
    await editor.initialize();
    const { sessionId } = await editor.agent.request('session/new', { cwd: dir, mcpServers: [] });
    const response = await editor.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'edit' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(editor.writes).toEqual([
      { path: join(dir, 'app.ts'), content: 'const a = 2; // unsaved\n' },
    ]);
    expect(readFileSync(join(dir, 'app.ts'), 'utf8')).toBe('const a = 1;\n');
    expect(editor.permissions[0]).toMatchObject({
      toolCall: {
        toolCallId: 'e1',
        kind: 'edit',
        locations: [{ path: join(dir, 'app.ts') }],
        content: [
          {
            type: 'diff',
            path: join(dir, 'app.ts'),
            oldText: 'const a = 1; // unsaved\n',
            newText: 'const a = 2; // unsaved\n',
          },
        ],
      },
    });
    const terminal = [...editor.terminals.values()][0]!;
    expect(terminal.request).toMatchObject({
      command: '/bin/sh',
      args: ['-c', 'npm test'],
      cwd: dir,
    });
    expect(terminal.released).toBe(true);
    expect(editor.updates(sessionId)).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'r1',
        status: 'completed',
        content: [{ type: 'terminal', terminalId: 'term_1' }],
      })
    );
    await acp.close();
  });

  it('cancels the prompt going on with session/cancel', async () => {
    const scripted = scriptedBackend([{ hold: true, first: 'thinking' }]);
    const { acp } = createTestAgent({ backend: scripted.backend });
    const editor = connectClient(acp);
    await editor.initialize();
    const { sessionId } = await editor.agent.request('session/new', { cwd: dir, mcpServers: [] });
    const prompt = editor.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'wait' }],
    });
    await waitUntil(() => messageText(editor.updates(sessionId)) === 'thinking');
    await editor.agent.notify('session/cancel', { sessionId });
    expect((await prompt).stopReason).toBe('cancelled');
    await acp.close();
  });

  it('sets the mode and the model of a session and keeps them across a load', async () => {
    const scripted = scriptedBackend([answer('first'), answer('second')]);
    const { acp, host } = createTestAgent({ backend: scripted.backend });
    const editor = connectClient(acp);
    await editor.initialize();
    const { sessionId } = await editor.agent.request('session/new', { cwd: dir, mcpServers: [] });
    await editor.agent.request('session/set_mode', { sessionId, modeId: 'acceptEdits' });
    expect(editor.updates(sessionId)).toContainEqual({
      sessionUpdate: 'current_mode_update',
      currentModeId: 'acceptEdits',
    });
    const set = await editor.agent.request('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'mock/other',
    });
    expect(set.configOptions.find((option) => option.id === 'model')).toMatchObject({
      currentValue: 'mock/other',
    });
    await expect(
      editor.agent.request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: 'x/y',
      })
    ).rejects.toThrow();
    await editor.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'one' }],
    });
    expect(scripted.requests[0]!.model).toBe('other');
    expect((await host.getThread(sessionId)).permissionMode).toBe('acceptEdits');

    const other = connectClient(acp);
    await other.initialize();
    const loaded = await other.agent.request('session/load', {
      sessionId,
      cwd: dir,
      mcpServers: [],
    });
    expect(loaded?.modes?.currentModeId).toBe('acceptEdits');
    expect(loaded?.configOptions?.find((option) => option.id === 'model')?.currentValue).toBe(
      'mock/other'
    );
    expect(other.updates(sessionId).slice(0, 2)).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'one' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first' } },
    ]);
    const listed = await other.agent.request('session/list', { cwd: dir });
    expect(listed.sessions).toEqual([
      expect.objectContaining({ sessionId, cwd: dir, title: 'one' }),
    ]);
    await other.agent.request('session/delete', { sessionId });
    expect((await other.agent.request('session/list', {})).sessions).toEqual([]);
    await expect(
      other.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'x' }] })
    ).rejects.toMatchObject({ code: -32002 });
    await acp.close();
  });

  it('asks to approve the plan of plan mode and goes on in the mode picked', async () => {
    const scripted = scriptedBackend([
      callTools([{ id: 'p1', name: 'exit_plan_mode', arguments: { plan: '1. Fix the bug' } }]),
      answer('fixed'),
    ]);
    const { acp, host } = createTestAgent({
      backend: scripted.backend,
      config: { permissions: {} },
    });
    const editor = connectClient(acp, {
      onPermission: (params) => ({
        outcome: { outcome: 'selected', optionId: params.options[0]!.optionId },
      }),
    });
    await editor.initialize();
    const { sessionId } = await editor.agent.request('session/new', { cwd: dir, mcpServers: [] });
    await editor.agent.request('session/set_mode', { sessionId, modeId: 'plan' });
    const response = await editor.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'plan it' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(editor.permissions[0]).toMatchObject({
      toolCall: {
        title: 'Ready to code?',
        kind: 'switch_mode',
        content: [{ type: 'content', content: { type: 'text', text: '1. Fix the bug' } }],
      },
    });
    expect(messageText(editor.updates(sessionId))).toContain('fixed');
    expect(editor.updates(sessionId)).toContainEqual({
      sessionUpdate: 'current_mode_update',
      currentModeId: 'acceptEdits',
    });
    expect((await host.getThread(sessionId)).status).toBe('idle');
    expect((await host.getThread(sessionId)).permissionMode).toBe('acceptEdits');
    await acp.close();
  });

  it('cancels a prompt while it asks about the plan, without going on', async () => {
    const scripted = scriptedBackend([
      callTools([{ id: 'p1', name: 'exit_plan_mode', arguments: { plan: '1. Fix it' } }]),
      answer('should not run'),
    ]);
    const { acp, host } = createTestAgent({
      backend: scripted.backend,
      config: { permissions: {} },
    });
    let sessionId = '';
    const editor = connectClient(acp, {
      onPermission: async (params) => {
        await editor.agent.notify('session/cancel', { sessionId });
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { outcome: { outcome: 'selected', optionId: params.options[0]!.optionId } };
      },
    });
    await editor.initialize();
    sessionId = (await editor.agent.request('session/new', { cwd: dir, mcpServers: [] })).sessionId;
    await editor.agent.request('session/set_mode', { sessionId, modeId: 'plan' });
    const response = await editor.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'plan it' }],
    });
    expect(response.stopReason).toBe('cancelled');
    expect(scripted.requests).toHaveLength(1);
    expect((await host.getThread(sessionId)).status).toBe('paused');
    await acp.close();
  });

  it('ends a prompt as cancelled when its session closes', async () => {
    const scripted = scriptedBackend([{ hold: true, first: 'working' }]);
    const { acp } = createTestAgent({ backend: scripted.backend });
    const editor = connectClient(acp);
    await editor.initialize();
    const { sessionId } = await editor.agent.request('session/new', { cwd: dir, mcpServers: [] });
    const prompt = editor.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'wait' }],
    });
    await waitUntil(() => messageText(editor.updates(sessionId)) === 'working');
    await editor.agent.request('session/close', { sessionId });
    expect((await prompt).stopReason).toBe('cancelled');
    await expect(
      editor.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'x' }] })
    ).rejects.toMatchObject({ code: -32002 });
    await acp.close();
  });

  it('refuses a session outside its roots', async () => {
    const { acp, host } = createTestAgent({
      backend: new MockLLMBackend(),
      acp: { roots: [join(dir, 'project')] },
    });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'project', 'src'), { recursive: true });
    const editor = connectClient(acp);
    await editor.initialize();
    await expect(
      editor.agent.request('session/new', { cwd: join(dir, 'elsewhere'), mcpServers: [] })
    ).rejects.toThrow(/outside/);
    expect((await host.listThreads({})).threads).toEqual([]);
    const inside = await editor.agent.request('session/new', {
      cwd: join(dir, 'project', 'src'),
      mcpServers: [],
    });
    expect(inside.sessionId).toBeTruthy();
    await acp.close();
  });

  it('answers a question of a tool with the next prompt', async () => {
    const pick = tool({
      name: 'pick_branch',
      description: 'Asks which branch',
      parameters: z.object({}),
      execute: async (_args, context) => {
        const branch = await context.interrupt!({ reason: 'branch', message: 'Which branch?' });
        return `on ${String(branch)}`;
      },
    });
    const scripted = scriptedBackend([
      callTools([{ id: 'b1', name: 'pick_branch', arguments: {} }]),
      (request) => {
        const last = request.messages.at(-1);
        return answer(typeof last?.content === 'string' ? `done ${last.content}` : 'done');
      },
    ]);
    const { acp, host } = createTestAgent({ backend: scripted.backend, agent: { tools: [pick] } });
    const editor = connectClient(acp);
    await editor.initialize();
    const { sessionId } = await editor.agent.request('session/new', { cwd: dir, mcpServers: [] });
    const first = await editor.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'deploy' }],
    });
    expect(first.stopReason).toBe('end_turn');
    expect(messageText(editor.updates(sessionId))).toContain('Which branch?');
    expect((await host.getThread(sessionId)).status).toBe('paused');
    await editor.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'main' }],
    });
    expect((await host.getThread(sessionId)).status).toBe('idle');
    expect(messageText(editor.updates(sessionId))).toContain('done "on main"');
    expect(scripted.requests).toHaveLength(2);
    await acp.close();
  });

  it('adds the tools of the MCP servers the editor names', async () => {
    const lookup = tool({
      name: 'mcp__docs__lookup',
      description: 'Looks up docs',
      parameters: z.object({ q: z.string() }),
      execute: async ({ q }) => `docs for ${q}`,
    });
    let closed = false;
    const connected: string[] = [];
    const scripted = scriptedBackend([
      callTools([{ id: 'm1', name: 'mcp__docs__lookup', arguments: { q: 'acp' } }]),
      answer('found'),
    ]);
    const { acp } = createTestAgent({
      backend: scripted.backend,
      acp: {
        mcp: async (servers) => {
          connected.push(
            ...servers.map((server) => `${server.name}:${String(server.config.command)}`)
          );
          return {
            tools: [lookup],
            close: async () => {
              closed = true;
            },
          };
        },
      },
    });
    const editor = connectClient(acp);
    await editor.initialize();
    const { sessionId } = await editor.agent.request('session/new', {
      cwd: dir,
      mcpServers: [{ name: 'docs', command: '/usr/bin/docs-mcp', args: [], env: [] }],
    });
    expect(connected).toEqual(['docs:/usr/bin/docs-mcp']);
    await editor.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'q' }],
    });
    expect(scripted.requests[0]!.tools?.map((t) => t.name)).toContain('mcp__docs__lookup');
    expect(editor.updates(sessionId)).toContainEqual(
      expect.objectContaining({ toolCallId: 'm1', status: 'completed' })
    );
    await editor.agent.request('session/close', { sessionId });
    expect(closed).toBe(true);
    await acp.close();
  });
});
