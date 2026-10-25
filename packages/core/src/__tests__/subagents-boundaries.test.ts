import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MockLLMBackend, type MockChatResponse } from '@cogitator-ai/test-utils';
import type {
  ChatRequest,
  CogitatorConfig,
  Message,
  PermissionMode,
  ToolApprovalRequest,
  ToolCall,
} from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { workspaceTools } from '../tools/workspace-tools';
import { LocalWorkspace } from '../workspace/local-workspace';
import { agentMemoryDir } from '../subagents/memory';
import { resolveDefinitionModel } from '../subagents/models';
import { ruleMatchesCall } from '../permissions/engine';

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

const toolNames = (request: ChatRequest | undefined): string[] =>
  (request?.tools ?? []).map((schema) => schema.name).sort();

const toolTexts = (messages: readonly Message[]): string[] =>
  messages.filter((message) => message.role === 'tool').map((message) => String(message.content));

const lookup = tool({
  name: 'lookup',
  description: 'Looks something up',
  parameters: z.object({ q: z.string() }),
  annotations: { readOnlyHint: true },
  execute: async ({ q }) => `found ${q}`,
});

const modes: Array<PermissionMode | undefined> = [];
const whoami = tool({
  name: 'whoami',
  description: 'Reports the permission mode',
  parameters: z.object({}),
  annotations: { readOnlyHint: true },
  execute: async (_args, context) => {
    modes.push(context.permissions?.mode);
    return context.permissions?.mode ?? 'none';
  },
});

function runtime(
  scripts: Record<string, MockChatResponse[]>,
  config: CogitatorConfig = {}
): { cog: Cogitator; llm: Record<string, MockLLMBackend> } {
  const llm = Object.fromEntries(
    Object.entries(scripts).map(([name, responses]) => [
      name,
      new MockLLMBackend().setResponses(responses),
    ])
  );
  const cog = new Cogitator({
    memory: { adapter: 'memory' },
    ...config,
    llm: { ...config.llm, backends: { ...llm }, retry: false },
  });
  return { cog, llm };
}

const lead = (extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) =>
  new Agent({
    name: 'lead',
    model: 'outer/m',
    instructions: 'You delegate.',
    tools: [lookup, whoami],
    ...extra,
  });

const pingTool = () =>
  tool({
    name: 'mcp__pinger__ping',
    description: 'Pings',
    parameters: z.object({}),
    mcp: { server: 'pinger', tool: 'ping' },
    execute: async () => 'pong',
  });

describe('continuing a subagent', () => {
  it('goes on in its own mode and with its MCP servers connected again', async () => {
    modes.length = 0;
    const closed = vi.fn(async () => undefined);
    const connect = vi.fn(async () => ({ tools: [pingTool()], close: closed }));
    const { cog, llm } = runtime(
      {
        outer: [
          turn(
            call('o1', 'agent', {
              description: 'x',
              prompt: 'plan',
              subagent_type: 'planner',
              name: 'p',
            })
          ),
          turn(call('o2', 'send_message', { to: 'p', message: 'again' })),
          { content: 'waiting' },
          { content: 'done' },
        ],
        inner: [
          turn(call('i1', 'whoami', {})),
          { content: 'planned' },
          turn(call('i2', 'whoami', {})),
          { content: 'planned again' },
        ],
      },
      {
        permissions: {},
        subagents: {
          mcp: connect,
          agents: {
            planner: {
              description: 'Plans',
              model: 'inner/m',
              permissionMode: 'plan',
              mcpServers: [{ name: 'pinger', config: { command: 'pinger' } }],
            },
          },
        },
      }
    );
    const result = await cog.run(lead(), { input: 'go' });
    expect(result.output).toBe('done');
    expect(modes).toEqual(['plan', 'plan']);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenCalledTimes(2);
    expect(toolNames(llm.inner?.getLastCall())).toContain('mcp__pinger__ping');
    await cog.close();
  });

  it('closes what a foreground subagent set up when its run fails', async () => {
    const closed = vi.fn(async () => undefined);
    const { cog } = runtime(
      {
        outer: [
          turn(call('o1', 'agent', { description: 'x', prompt: 'p', subagent_type: 'broken' })),
          { content: 'done' },
        ],
        inner: [{ error: new Error('provider down') }],
      },
      {
        subagents: {
          mcp: async () => ({ tools: [pingTool()], close: closed }),
          agents: {
            broken: {
              description: 'Fails',
              model: 'inner/m',
              mcpServers: [{ name: 'pinger', config: {} }],
            },
          },
        },
      }
    );
    const result = await cog.run(lead(), { input: 'go' });
    expect(JSON.parse(toolTexts(result.messages)[0] ?? '{}')).toMatchObject({ status: 'failed' });
    expect(closed).toHaveBeenCalledTimes(1);
    await cog.close();
  });

  it('takes the background slot before it sets anything up', async () => {
    let connected = 0;
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { cog } = runtime(
      {
        outer: [
          turn(
            call('o1', 'agent', {
              description: 'x',
              prompt: 'a',
              subagent_type: 'slow',
              run_in_background: true,
            }),
            call('o2', 'agent', {
              description: 'x',
              prompt: 'b',
              subagent_type: 'slow',
              run_in_background: true,
            })
          ),
          { content: 'waiting' },
          { content: 'done' },
        ],
        inner: [{ content: 'ok' }],
      },
      {
        subagents: {
          maxBackground: 1,
          mcp: async () => {
            connected++;
            if (connected === 1) setTimeout(open, 0);
            await gate;
            return { tools: [], close: async () => undefined };
          },
          agents: {
            slow: {
              description: 'Slow',
              model: 'inner/m',
              mcpServers: [{ name: 's', config: {} }],
            },
          },
        },
      }
    );
    const result = await cog.run(lead(), { input: 'go', parallelToolCalls: true });
    const answers = toolTexts(result.messages).map(
      (text) => JSON.parse(text) as { status: string; error?: string }
    );
    expect(answers.map((answer) => answer.status).sort()).toEqual(['failed', 'running']);
    expect(answers.find((answer) => answer.status === 'failed')?.error).toContain('limit');
    expect(connected).toBe(1);
    await cog.close();
  });

  it('shows a background subagent the conversation with messages: conversation', async () => {
    const { cog, llm } = runtime(
      {
        outer: [
          turn(
            call('o1', 'agent', {
              description: 'x',
              prompt: 'summarize',
              subagent_type: 'sum',
              run_in_background: true,
            })
          ),
          { content: 'waiting' },
          { content: 'done' },
        ],
        inner: [{ content: 'summary' }],
      },
      {
        subagents: {
          messages: 'conversation',
          agents: { sum: { description: 'Sums', model: 'inner/m' } },
        },
      }
    );
    await cog.run(lead(), { input: 'The release is on Friday.' });
    const seen = (llm.inner?.getCalls()[0]?.messages ?? []).map((message) =>
      String(message.content)
    );
    expect(seen).toContain('The release is on Friday.');
    await cog.close();
  });
});

describe('what a subagent may do', () => {
  it('keeps the tool lists of every subagent above, the runtime tools included', async () => {
    const danger = tool({
      name: 'danger',
      description: 'Does something dangerous',
      parameters: z.object({}),
      execute: async () => 'boom',
    });
    const { cog, llm } = runtime(
      {
        outer: [
          turn(call('o1', 'agent', { description: 'x', prompt: 'review', subagent_type: 'rev' })),
          { content: 'done' },
        ],
        mid: [
          turn(call('m1', 'agent', { description: 'x', prompt: 'help', subagent_type: 'helper' })),
          { content: 'reviewed' },
        ],
        leaf: [{ content: 'helped' }],
      },
      {
        subagents: {
          agents: {
            rev: { description: 'Reviews', model: 'mid/m', tools: ['lookup', 'Agent'] },
            helper: { description: 'Helps', model: 'leaf/m' },
          },
        },
      }
    );
    cog.tools.register(danger);
    await cog.run(lead(), { input: 'go' });
    expect(toolNames(llm.mid?.getCalls()[0])).toEqual([
      'agent',
      'lookup',
      'send_message',
      'task_output',
      'task_stop',
    ]);
    expect(toolNames(llm.leaf?.getCalls()[0])).not.toContain('danger');
    expect(toolNames(llm.leaf?.getCalls()[0])).not.toContain('whoami');
    expect(toolNames(llm.leaf?.getCalls()[0])).toContain('lookup');
    await cog.close();
  });

  it('narrows the subagents a subagent may delegate to along the chain', async () => {
    const { cog, llm } = runtime(
      {
        outer: [
          turn(call('o1', 'agent', { description: 'x', prompt: 'review', subagent_type: 'rev' })),
          { content: 'done' },
        ],
        mid: [
          turn(
            call('m1', 'agent', { description: 'x', prompt: 'ship', subagent_type: 'deployer' })
          ),
          { content: 'reviewed' },
        ],
        leaf: [{ content: 'deployed' }],
      },
      {
        subagents: {
          agents: {
            rev: { description: 'Reviews', model: 'mid/m' },
            deployer: { description: 'Deploys', model: 'leaf/m' },
          },
        },
      }
    );
    await cog.run(lead({ subagents: ['rev'] }), { input: 'go' });
    expect(toolTexts(llm.mid?.getLastCall()?.messages ?? [])[0]).toContain('There is no subagent');
    expect(llm.leaf?.getCallCount()).toBe(0);
    await cog.close();
  });

  it('keeps agent_memory and its own MCP tools whatever its tools list says', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'subagent-memory-')));
    const workspace = new LocalWorkspace({ root: base });
    await workspace.start();
    const { cog, llm } = runtime(
      {
        outer: [
          turn(call('o1', 'agent', { description: 'x', prompt: 'note', subagent_type: 'scribe' })),
          { content: 'done' },
        ],
        inner: [{ content: 'noted' }],
      },
      {
        subagents: {
          mcp: async () => ({ tools: [pingTool()], close: async () => undefined }),
          agents: {
            scribe: {
              description: 'Notes',
              model: 'inner/m',
              tools: ['lookup', 'mcp__pinger__*'],
              memory: 'project',
              mcpServers: [{ name: 'pinger', config: {} }],
            },
          },
        },
      }
    );
    await cog.run(lead({ workspace }), { input: 'go' });
    expect(toolNames(llm.inner?.getCalls()[0])).toEqual([
      'agent_memory',
      'lookup',
      'mcp__pinger__ping',
    ]);
    await workspace.dispose();
    rmSync(base, { recursive: true, force: true });
    await cog.close();
  });

  it('keeps memory folders inside their own folder', () => {
    expect(() => agentMemoryDir('project', '..', '/repo')).toThrow('its own folder');
    expect(() => agentMemoryDir('user', '.', '/repo')).toThrow('its own folder');
    expect(agentMemoryDir('local', 'scribe', '/repo')).toBe(
      '/repo/.claude/agent-memory-local/scribe'
    );
  });

  it('lets the call ask only for inherit or an alias, and refuses an unpriced model under a cost budget', async () => {
    const { cog, llm } = runtime(
      {
        outer: [
          turn(
            call('o1', 'agent', {
              description: 'x',
              prompt: 'p',
              subagent_type: 'helper',
              model: 'openai/gpt-x',
            })
          ),
          turn(
            call('o2', 'agent', {
              description: 'x',
              prompt: 'p',
              subagent_type: 'helper',
              model: 'fast',
            })
          ),
          { content: 'done' },
        ],
        inner: [{ content: 'helped' }],
      },
      {
        llm: { modelAliases: { fast: 'inner/m' } },
        budget: { session: { maxCostUsd: 5 } },
        subagents: { agents: { helper: { description: 'Helps' } } },
      }
    );
    const result = await cog.run(lead(), { input: 'go' });
    const [first, second] = toolTexts(result.messages);
    expect(first).toContain('cannot be asked for');
    expect(second).toContain('no price is known for inner/m');
    expect(llm.inner?.getCallCount()).toBe(0);
    await cog.close();
  });

  it('routes a Claude model id without a provider to Anthropic', () => {
    expect(resolveDefinitionModel('claude-opus-5-5', undefined)).toEqual({
      inherit: false,
      model: 'anthropic/claude-opus-5-5',
    });
    expect(resolveDefinitionModel('sonnet', { sonnet: 'anthropic/claude-sonnet-5' })).toEqual({
      inherit: false,
      model: 'anthropic/claude-sonnet-5',
    });
    expect(resolveDefinitionModel('opus', undefined).inherit).toBe(true);
    expect(resolveDefinitionModel('llama3', undefined)).toMatchObject({
      model: 'llama3',
      warning: expect.stringContaining('defaultProvider'),
    });
  });

  it('hands bubbling approvals to onApproval with the qualified id and the subagent, and background ones too', async () => {
    const deploy = tool({
      name: 'deploy',
      description: 'Deploys',
      parameters: z.object({}),
      requiresApproval: true,
      execute: async () => 'deployed',
    });
    const seen: ToolApprovalRequest[] = [];
    const { cog } = runtime(
      {
        outer: [
          turn(call('o1', 'agent', { description: 'x', prompt: 'ship', subagent_type: 'shipper' })),
          turn(
            call('o2', 'agent', {
              description: 'x',
              prompt: 'ship',
              subagent_type: 'shipper',
              run_in_background: true,
            })
          ),
          { content: 'waiting' },
          { content: 'done' },
        ],
        inner: [
          turn(call('i1', 'deploy', {})),
          { content: 'shipped' },
          turn(call('i2', 'deploy', {})),
          { content: 'shipped again' },
        ],
      },
      {
        subagents: {
          approvalMode: 'bubble',
          agents: { shipper: { description: 'Ships', model: 'inner/m' } },
        },
      }
    );
    const result = await cog.run(lead({ tools: [deploy] }), {
      input: 'go',
      onApproval: (request) => {
        seen.push(request);
        return { approved: true };
      },
    });
    expect(result.output).toBe('done');
    expect(seen.map((request) => [request.toolCallId, request.subagent])).toEqual([
      ['o1/i1', 'shipper'],
      ['i2', undefined],
    ]);
    await cog.close();
  });

  it('matches SendMessage rules only to the subagent tool, and renames it next to a tool of that name', async () => {
    const teamSend = tool({
      name: 'send_message',
      description: 'Sends a message to a teammate',
      parameters: z.object({ to: z.string(), message: z.string() }),
      execute: async () => 'sent',
    });
    expect(await ruleMatchesCall('SendMessage', teamSend, { to: 'a', message: 'b' }, {})).toBe(
      false
    );
    const { cog, llm } = runtime(
      { outer: [{ content: 'hi' }] },
      { subagents: { agents: { helper: { description: 'Helps', model: 'inner/m' } } } }
    );
    await cog.run(lead({ tools: [teamSend] }), { input: 'hello' });
    const names = toolNames(llm.outer?.getLastCall());
    expect(names).toContain('send_message');
    expect(names).toContain('subagent_send_message');
    const agentTool = llm.outer?.getLastCall()?.tools?.find((schema) => schema.name === 'agent');
    expect(agentTool?.description).toContain(
      'Continue an agent that finished with subagent_send_message'
    );
    await cog.close();
  });

  it('runs foreground delegations of one step side by side with parallelToolCalls', async () => {
    let arrived = 0;
    let both: () => void = () => undefined;
    const together = new Promise<void>((resolve) => {
      both = resolve;
    });
    const meet = tool({
      name: 'meet',
      description: 'Waits for the other delegate',
      parameters: z.object({}),
      execute: async () => {
        arrived++;
        if (arrived === 2) both();
        await together;
        return 'met';
      },
    });
    const { cog } = runtime(
      {
        outer: [
          turn(
            call('o1', 'agent', { description: 'x', prompt: 'a', subagent_type: 'meeter' }),
            call('o2', 'agent', { description: 'x', prompt: 'b', subagent_type: 'meeter' })
          ),
          { content: 'done' },
        ],
        inner: [turn(call('i1', 'meet', {})), turn(call('i2', 'meet', {})), { content: 'met' }],
      },
      { subagents: { agents: { meeter: { description: 'Meets', model: 'inner/m' } } } }
    );
    const result = await cog.run(lead({ tools: [meet] }), { input: 'go', parallelToolCalls: true });
    expect(result.output).toBe('done');
    expect(arrived).toBe(2);
    await cog.close();
  });
});

describe('subagents of a repository', () => {
  let base: string;
  let repo: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'subagents-repo-')));
    repo = join(base, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, '.claude', 'agents'), { recursive: true });
    mkdirSync(join(repo, 'apps', 'web', '.claude', 'agents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const write = (dir: string, name: string, description: string, extra = '') =>
    writeFileSync(
      join(dir, '.claude', 'agents', `${name}.md`),
      `---\nname: ${name}\ndescription: ${description}\n${extra}---\nYou help.\n`
    );

  it('reads the folders from the working directory up to the repository root, the closest first', async () => {
    write(repo, 'reviewer', 'root reviewer');
    write(repo, 'shipper', 'root shipper');
    write(join(repo, 'apps', 'web'), 'reviewer', 'web reviewer');
    const subagents = new Cogitator({
      subagents: { files: { trustedRoots: [repo], userDirs: [], managedDirs: [] } },
    });
    const workspace = new LocalWorkspace({ root: repo, cwd: 'apps/web' });
    const { SubagentService } = await import('../subagents/service');
    const service = new SubagentService(subagents, {
      config: { files: { trustedRoots: [repo], userDirs: [], managedDirs: [] } },
      files: { trustedRoots: [repo], userDirs: [], managedDirs: [] },
      hooks: () => ({ deps: {}, config: {} }),
    });
    const catalog = await service.catalog(workspace);
    expect(catalog.agents.map((agent) => [agent.name, agent.description])).toEqual([
      ['reviewer', 'web reviewer'],
      ['shipper', 'root shipper'],
    ]);
    await subagents.close();
  });

  it('skips frontmatter hooks the managed settings turn off', async () => {
    const managed = join(base, 'managed');
    mkdirSync(managed, { recursive: true });
    writeFileSync(
      join(managed, 'managed-settings.json'),
      JSON.stringify({ disableAllHooks: true })
    );
    write(
      repo,
      'guarded',
      'Guarded',
      'model: inner/m\nhooks:\n  PreToolUse:\n    - matcher: lookup\n      hooks:\n        - type: command\n          command: "echo blocked >&2; exit 2"\n'
    );
    const workspace = new LocalWorkspace({ root: repo });
    const { cog, llm } = runtime(
      {
        outer: [
          turn(call('o1', 'agent', { description: 'x', prompt: 'find', subagent_type: 'guarded' })),
          { content: 'done' },
        ],
        inner: [turn(call('i1', 'lookup', { q: 'x' })), { content: 'found' }],
      },
      {
        permissions: {
          settings: { root: repo, trusted: true, userDirs: [], managedDirs: [managed] },
        },
        subagents: { files: true },
      }
    );
    await cog.run(lead({ workspace }), { input: 'go' });
    expect(toolTexts(llm.inner?.getLastCall()?.messages ?? [])[0]).toContain('found x');
    await cog.close();
  });

  it('goes on in the same worktree when a finished subagent is continued', async () => {
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git('add', 'README.md');
    git('commit', '-q', '-m', 'init');
    write(repo, 'editor', 'Edits', 'model: inner/m\nisolation: worktree\n');
    const workspace = new LocalWorkspace({ root: repo });
    const { cog, llm } = runtime(
      {
        outer: [
          turn(
            call('o1', 'agent', {
              description: 'x',
              prompt: 'edit',
              subagent_type: 'editor',
              name: 'ed',
            })
          ),
          turn(call('o2', 'send_message', { to: 'ed', message: 'read it back' })),
          { content: 'waiting' },
          { content: 'done' },
        ],
        inner: [
          turn(call('i1', 'write_file', { path: 'NOTE.md', content: 'from the first run' })),
          { content: 'edited' },
          turn(call('i2', 'read_file', { path: 'NOTE.md' })),
          { content: 'read' },
        ],
      },
      { subagents: { files: { root: repo, trusted: true, userDirs: [], managedDirs: [] } } }
    );
    await cog.run(lead({ workspace, tools: workspaceTools() }), { input: 'go' });
    expect(toolTexts(llm.inner?.getLastCall()?.messages ?? []).at(-1)).toContain(
      'from the first run'
    );
    expect(existsSync(join(repo, 'NOTE.md'))).toBe(false);
    await cog.close();
  });

  it('keeps a worktree that holds ignored files the subagent made', async () => {
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, '.gitignore'), 'dist/\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'init');
    write(repo, 'builder', 'Builds', 'model: inner/m\nisolation: worktree\n');
    const workspace = new LocalWorkspace({ root: repo });
    const { cog } = runtime(
      {
        outer: [
          turn(
            call('o1', 'agent', { description: 'x', prompt: 'build', subagent_type: 'builder' })
          ),
          { content: 'done' },
        ],
        inner: [
          turn(call('i1', 'write_file', { path: 'dist/out.js', content: 'built' })),
          { content: 'built' },
        ],
      },
      { subagents: { files: { root: repo, trusted: true, userDirs: [], managedDirs: [] } } }
    );
    const result = await cog.run(lead({ workspace, tools: workspaceTools() }), { input: 'go' });
    const answer = JSON.parse(toolTexts(result.messages)[0] ?? '{}') as { note?: string };
    const kept = /worktree (\S+) on branch/.exec(answer.note ?? '')?.[1] ?? '';
    expect(kept).not.toBe('');
    expect(readFileSync(join(kept, 'dist', 'out.js'), 'utf8')).toBe('built');
    expect(existsSync(join(repo, 'dist'))).toBe(false);
    await cog.close();
  });
});
