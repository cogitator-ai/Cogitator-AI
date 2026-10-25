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
  DelegationCompleteEvent,
  DelegationStartEvent,
  Message,
  PermissionMode,
  ToolCall,
} from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { workspaceTools } from '../tools/workspace-tools';
import { LocalWorkspace } from '../workspace/local-workspace';
import { narrowMode } from '../subagents/service';

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

const seenModes: Array<PermissionMode | undefined> = [];
const whoami = tool({
  name: 'whoami',
  description: 'Reports the permission mode',
  parameters: z.object({}),
  annotations: { readOnlyHint: true },
  execute: async (_args, context) => {
    seenModes.push(context.permissions?.mode);
    return context.permissions?.mode ?? 'none';
  },
});

function runtime(
  scripts: { outer: MockChatResponse[]; inner?: MockChatResponse[] },
  config: CogitatorConfig = {}
) {
  const outer = new MockLLMBackend().setResponses(scripts.outer);
  const inner = new MockLLMBackend().setResponses(scripts.inner ?? [{ content: 'inner done' }]);
  const cog = new Cogitator({
    memory: { adapter: 'memory' },
    ...config,
    llm: { ...config.llm, backends: { outer, inner }, retry: false },
  });
  return { cog, outer, inner };
}

const lead = (extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) =>
  new Agent({
    name: 'lead',
    model: 'outer/m',
    instructions: 'You delegate.',
    tools: [lookup, whoami],
    ...extra,
  });

describe('narrowMode', () => {
  it.each<[PermissionMode | undefined, PermissionMode | undefined, PermissionMode | undefined]>([
    ['default', 'plan', 'plan'],
    ['default', 'dontAsk', 'dontAsk'],
    ['default', 'acceptEdits', undefined],
    ['default', 'bypassPermissions', undefined],
    ['plan', 'acceptEdits', undefined],
    ['plan', 'default', undefined],
    ['acceptEdits', 'default', 'default'],
    ['bypassPermissions', 'plan', 'plan'],
    ['auto', 'acceptEdits', undefined],
    [undefined, 'acceptEdits', undefined],
    [undefined, 'plan', 'plan'],
    ['default', undefined, undefined],
  ])('a %s run with a %s subagent runs it in %s', (parent, own, expected) => {
    expect(narrowMode(parent, own)).toBe(expected);
  });
});

describe('subagents in a run', () => {
  it('gives no delegation tools without subagents', async () => {
    const { cog, outer } = runtime({ outer: [{ content: 'hi' }] });
    await cog.run(lead(), { input: 'hello' });
    expect(toolNames(outer.getLastCall())).toEqual(['lookup', 'whoami']);
    await cog.close();
  });

  it('delegates to a subagent in code by subagent_type, with its prompt and its tools', async () => {
    const started: DelegationStartEvent[] = [];
    const completed: DelegationCompleteEvent[] = [];
    const { cog, outer, inner } = runtime(
      {
        outer: [
          turn(
            call('o1', 'agent', {
              description: 'research',
              prompt: 'look up cats',
              subagent_type: 'researcher',
            })
          ),
          { content: 'reported' },
        ],
        inner: [turn(call('i1', 'lookup', { q: 'cats' })), { content: 'cats are cats' }],
      },
      {
        subagents: {
          agents: {
            researcher: {
              description: 'Researches topics',
              prompt: 'You research.',
              tools: ['lookup'],
              model: 'inner/m',
            },
          },
          onDelegationStart: (event) => started.push(event),
          onDelegationComplete: (event) => completed.push(event),
        },
      }
    );
    const result = await cog.run(lead(), { input: 'go' });
    expect(result.output).toBe('reported');
    expect(toolNames(outer.getCalls()[0])).toEqual([
      'agent',
      'lookup',
      'send_message',
      'task_output',
      'task_stop',
      'whoami',
    ]);
    const agentTool = outer.getCalls()[0]?.tools?.find((schema) => schema.name === 'agent');
    expect(agentTool?.description).toContain('- researcher: Researches topics');
    expect(toolNames(inner.getCalls()[0])).toEqual(['lookup']);
    expect(inner.getCalls()[0]?.messages[0]?.content).toContain('You research.');
    expect(inner.getCalls()[0]?.messages.at(-1)?.content).toBe('look up cats');
    const answer = JSON.parse(toolTexts(result.messages)[0] ?? '{}') as Record<string, unknown>;
    expect(answer).toMatchObject({ status: 'completed', output: 'cats are cats', success: true });
    expect(String(answer.agentId)).toMatch(/^agent_/);
    expect(started).toEqual([
      expect.objectContaining({ agent: 'researcher', task: 'look up cats', background: false }),
    ]);
    expect(completed).toEqual([
      expect.objectContaining({
        agent: 'researcher',
        status: 'completed',
        output: 'cats are cats',
      }),
    ]);
    await cog.close();
  });

  it('takes tools away with disallowedTools, and an unknown type gets an error the model reads', async () => {
    const { cog, inner } = runtime(
      {
        outer: [
          turn(call('o1', 'agent', { description: 'x', prompt: 'p', subagent_type: 'nosy' })),
          turn(call('o2', 'agent', { description: 'x', prompt: 'p', subagent_type: 'ghost' })),
          { content: 'done' },
        ],
      },
      {
        subagents: {
          agents: {
            nosy: { description: 'd', disallowedTools: ['whoami', 'Agent'], model: 'inner/m' },
          },
        },
      }
    );
    const result = await cog.run(lead(), { input: 'go' });
    expect(toolNames(inner.getCalls()[0])).toEqual(['lookup']);
    expect(toolTexts(result.messages)[1]).toContain(
      'There is no subagent \\"ghost\\". Available: nosy'
    );
    await cog.close();
  });

  it('refuses a subagent whose tools list names none of the tools', async () => {
    const { cog, inner } = runtime(
      {
        outer: [
          turn(call('o1', 'agent', { description: 'x', prompt: 'p', subagent_type: 'empty' })),
          { content: 'done' },
        ],
      },
      { subagents: { agents: { empty: { description: 'd', tools: ['Reed'], model: 'inner/m' } } } }
    );
    const result = await cog.run(lead(), { input: 'go' });
    expect(toolTexts(result.messages)[0]).toContain('would get no tools');
    expect(inner.getCallCount()).toBe(0);
    await cog.close();
  });

  it('narrows the permission mode and never widens it', async () => {
    seenModes.length = 0;
    const { cog } = runtime(
      {
        outer: [
          turn(call('o1', 'agent', { description: 'x', prompt: 'p', subagent_type: 'planner' })),
          turn(call('o2', 'agent', { description: 'x', prompt: 'p', subagent_type: 'editor' })),
          { content: 'done' },
        ],
        inner: [
          turn(call('i1', 'whoami', {})),
          { content: 'ok' },
          turn(call('i2', 'whoami', {})),
          { content: 'ok' },
        ],
      },
      {
        permissions: {},
        subagents: {
          agents: {
            planner: { description: 'plans', permissionMode: 'plan', model: 'inner/m' },
            editor: { description: 'edits', permissionMode: 'bypassPermissions', model: 'inner/m' },
          },
        },
      }
    );
    await cog.run(lead(), { input: 'go' });
    expect(seenModes).toEqual(['plan', 'default']);
    await cog.close();
  });

  it('lets an Agent(name) deny rule refuse a subagent', async () => {
    const { cog, inner } = runtime(
      {
        outer: [
          turn(call('o1', 'agent', { description: 'x', prompt: 'p', subagent_type: 'researcher' })),
          { content: 'done' },
        ],
      },
      {
        permissions: { deny: ['Agent(researcher)'] },
        subagents: { agents: { researcher: { description: 'd', model: 'inner/m' } } },
      }
    );
    const result = await cog.run(lead(), { input: 'go' });
    expect(toolTexts(result.messages)[0]).toContain('Permission denied');
    expect(inner.getCallCount()).toBe(0);
    await cog.close();
  });

  it('limits which subagents an agent delegates to, and offers one tool per subagent with tools: each', async () => {
    const { cog, outer } = runtime(
      { outer: [{ content: 'hi' }] },
      {
        subagents: {
          tools: 'each',
          agents: {
            researcher: { description: 'Researches', model: 'inner/m' },
            writer: { description: 'Writes', model: 'inner/m' },
          },
        },
      }
    );
    await cog.run(lead({ subagents: ['writer'] }), { input: 'hello' });
    expect(toolNames(outer.getLastCall())).toEqual([
      'lookup',
      'send_message',
      'task_output',
      'task_stop',
      'whoami',
      'writer',
    ]);
    await cog.run(lead({ subagents: false }), { input: 'hello' });
    expect(toolNames(outer.getLastCall())).toEqual(['lookup', 'whoami']);
    await cog.close();
  });

  it('stops nesting at maxDepth and maps maxTurns to the iteration limit', async () => {
    const { cog, inner } = runtime(
      {
        outer: [
          turn(call('o1', 'agent', { description: 'x', prompt: 'p', subagent_type: 'looper' })),
          { content: 'done' },
        ],
        inner: [
          turn(call('i1', 'lookup', { q: 'a' })),
          turn(call('i2', 'lookup', { q: 'b' })),
          { content: 'never' },
        ],
      },
      {
        subagents: {
          maxDepth: 1,
          agents: { looper: { description: 'loops', maxTurns: 1, model: 'inner/m' } },
        },
      }
    );
    const result = await cog.run(lead(), { input: 'go' });
    expect(toolNames(inner.getCalls()[0])).toEqual(['lookup', 'whoami']);
    expect(JSON.parse(toolTexts(result.messages)[0] ?? '{}')).toMatchObject({
      status: 'completed',
    });
    expect(inner.getCallCount()).toBeLessThanOrEqual(2);
    await cog.close();
  });

  it('shows the delegate the conversation of the run with messages: conversation', async () => {
    const { cog, inner } = runtime(
      {
        outer: [
          turn(
            call('o1', 'agent', {
              description: 'x',
              prompt: 'summarize',
              subagent_type: 'summarizer',
            })
          ),
          { content: 'done' },
        ],
      },
      {
        subagents: {
          messages: 'conversation',
          agents: { summarizer: { description: 'Summarizes', model: 'inner/m' } },
        },
      }
    );
    await cog.run(lead(), { input: 'The launch moved to Friday.' });
    const seen = inner.getCalls()[0]?.messages ?? [];
    expect(seen.map((message) => [message.role, String(message.content)]).slice(1)).toEqual([
      ['user', 'The launch moved to Friday.'],
      ['user', 'summarize'],
    ]);
    await cog.close();
  });

  it('preloads skills and connects inline MCP servers for a subagent', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'subagent-skills-')));
    mkdirSync(join(dir, 'release'), { recursive: true });
    writeFileSync(
      join(dir, 'release', 'SKILL.md'),
      '---\nname: release\ndescription: How to release\n---\nAlways tag the release first.\n'
    );
    const closed = vi.fn(async () => undefined);
    const ping = tool({
      name: 'mcp__pinger__ping',
      description: 'Pings',
      parameters: z.object({}),
      mcp: { server: 'pinger', tool: 'ping' },
      execute: async () => 'pong',
    });
    const connect = vi.fn(async () => ({ tools: [ping], close: closed }));
    const { cog, inner } = runtime(
      {
        outer: [
          turn(
            call('o1', 'agent', { description: 'x', prompt: 'release', subagent_type: 'releaser' })
          ),
          { content: 'done' },
        ],
        inner: [turn(call('i1', 'mcp__pinger__ping', {})), { content: 'released' }],
      },
      {
        subagents: {
          mcp: connect,
          agents: {
            releaser: {
              description: 'Releases',
              prompt: 'You release.',
              model: 'inner/m',
              skills: ['release'],
              mcpServers: [{ name: 'pinger', config: { type: 'stdio', command: 'pinger' } }],
            },
          },
        },
      }
    );
    const { SkillRegistry } = await import('../skills/skill-registry');
    await cog.run(lead({ skills: [new SkillRegistry({ dirs: [dir] })] }), { input: 'go' });
    const system = String(inner.getCalls()[0]?.messages[0]?.content);
    expect(system).toContain('You release.');
    expect(system).toContain('<skill name="release">\nAlways tag the release first.');
    expect(toolTexts(inner.getLastCall()?.messages ?? [])[0]).toContain('pong');
    expect(connect).toHaveBeenCalledWith(
      [{ name: 'pinger', config: { type: 'stdio', command: 'pinger' } }],
      expect.objectContaining({ agent: 'releaser' })
    );
    expect(closed).toHaveBeenCalledTimes(1);
    rmSync(dir, { recursive: true, force: true });
    await cog.close();
  });

  it('bubbles a subagent approval up with approvalMode bubble', async () => {
    const deploy = tool({
      name: 'deploy',
      description: 'Deploys',
      parameters: z.object({}),
      requiresApproval: true,
      execute: async () => 'deployed',
    });
    const { cog } = runtime(
      {
        outer: [
          turn(call('o1', 'agent', { description: 'x', prompt: 'ship', subagent_type: 'shipper' })),
          { content: 'done' },
        ],
        inner: [turn(call('i1', 'deploy', {})), { content: 'shipped' }],
      },
      {
        subagents: {
          approvalMode: 'bubble',
          agents: { shipper: { description: 'ships', model: 'inner/m' } },
        },
      }
    );
    const agent = lead({ tools: [deploy] });
    const paused = await cog.run(agent, { input: 'go', threadId: 't-ship' });
    expect(paused.pendingApprovals?.map((request) => request.toolCallId)).toEqual(['o1/i1']);
    const resumed = await cog.resume(agent, 't-ship', {
      decisions: { 'o1/i1': { approved: true } },
    });
    expect(resumed.status).toBe('completed');
    expect(JSON.parse(toolTexts(resumed.messages)[0] ?? '{}')).toMatchObject({ output: 'shipped' });
    await cog.close();
  });
});

describe('background subagents', () => {
  it('runs a subagent in the background and hands its result to the run before it stops', async () => {
    const { cog, outer } = runtime(
      {
        outer: [
          turn(
            call('o1', 'agent', {
              description: 'x',
              prompt: 'dig',
              subagent_type: 'digger',
              run_in_background: true,
            })
          ),
          { content: 'waiting for the digger' },
          { content: 'the digger found gold' },
        ],
        inner: [{ content: 'gold' }],
      },
      { subagents: { agents: { digger: { description: 'digs', model: 'inner/m' } } } }
    );
    const result = await cog.run(lead(), { input: 'go' });
    expect(result.output).toBe('the digger found gold');
    expect(JSON.parse(toolTexts(result.messages)[0] ?? '{}')).toMatchObject({ status: 'running' });
    const last = outer.getLastCall()?.messages.at(-1);
    expect(last?.role).toBe('user');
    expect(String(last?.content)).toContain('<task-notification>');
    expect(String(last?.content)).toContain('Background agent "digger"');
    expect(String(last?.content)).toContain('gold');
    await cog.close();
  });

  it('reads a background result with task_output and continues a finished agent with send_message', async () => {
    const { cog, inner } = runtime(
      {
        outer: [
          turn(
            call('o1', 'agent', {
              description: 'x',
              prompt: 'count',
              subagent_type: 'counter',
              run_in_background: true,
              name: 'cnt',
            })
          ),
          turn(call('o2', 'task_output', { task_id: 'cnt' })),
          turn(call('o3', 'send_message', { to: 'cnt', message: 'and again' })),
          { content: 'waiting' },
          { content: 'all counted' },
        ],
        inner: [{ content: 'one' }, { content: 'two' }],
      },
      { subagents: { agents: { counter: { description: 'counts', model: 'inner/m' } } } }
    );
    const result = await cog.run(lead(), { input: 'go' });
    const texts = toolTexts(result.messages);
    expect(JSON.parse(texts[1] ?? '{}')).toMatchObject({
      agent: 'counter',
      status: 'completed',
      output: 'one',
    });
    expect(JSON.parse(texts[2] ?? '{}')).toMatchObject({ delivered: true, resumed: true });
    expect(result.output).toBe('all counted');
    const second = inner.getCalls()[1]?.messages.map((message) => String(message.content));
    expect(second).toContain('count');
    expect(second).toContain('one');
    expect(second?.at(-1)).toBe('and again');
    await cog.close();
  });

  it('charges the tool calls of a background agent to the session of the run that started it', async () => {
    const { cog, inner } = runtime(
      {
        outer: [
          turn(call('o0', 'lookup', { q: 'first' })),
          turn(
            call('o1', 'agent', {
              description: 'x',
              prompt: 'look twice',
              subagent_type: 'looker',
              run_in_background: true,
            })
          ),
          { content: 'waiting' },
          { content: 'done' },
        ],
        inner: [
          turn(call('i1', 'lookup', { q: 'a' })),
          turn(call('i2', 'lookup', { q: 'b' })),
          { content: 'looked' },
        ],
      },
      {
        budget: { session: { maxToolCalls: 3 } },
        subagents: { agents: { looker: { description: 'looks', model: 'inner/m' } } },
      }
    );
    await cog.run(lead(), { input: 'go', threadId: 't-budget' });
    const texts = toolTexts(inner.getLastCall()?.messages ?? []);
    expect(texts[0]).toContain('found a');
    expect(texts[1]).toContain('budget');
    await cog.close();
  });

  it('stops a background agent with task_stop, and the ones a paused run started', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = tool({
      name: 'slow',
      description: 'Takes its time',
      parameters: z.object({}),
      execute: async (_args, context) => {
        await Promise.race([
          gate,
          new Promise((_, reject) =>
            context.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            })
          ),
        ]);
        return 'slow done';
      },
    });
    const { cog } = runtime(
      {
        outer: [
          turn(
            call('o1', 'agent', {
              description: 'x',
              prompt: 'wait',
              subagent_type: 'sloth',
              run_in_background: true,
              name: 's',
            })
          ),
          turn(call('o2', 'task_stop', { task_id: 's' })),
          { content: 'stopped it' },
        ],
        inner: [turn(call('i1', 'slow', {})), { content: 'never' }],
      },
      { subagents: { agents: { sloth: { description: 'slow', model: 'inner/m' } } } }
    );
    const result = await cog.run(lead({ tools: [slow] }), { input: 'go' });
    expect(JSON.parse(toolTexts(result.messages)[1] ?? '{}')).toMatchObject({ status: 'stopped' });
    expect(result.output).toBe('stopped it');
    release();
    await cog.close();
  });
});

describe('subagents from files', () => {
  let base: string;
  let project: string;
  let workspace: LocalWorkspace;

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'subagents-run-')));
    project = join(base, 'project');
    mkdirSync(join(project, '.claude', 'agents'), { recursive: true });
    workspace = new LocalWorkspace({ root: project });
    await workspace.start();
  });

  afterEach(async () => {
    await workspace.dispose();
    rmSync(base, { recursive: true, force: true });
  });

  const agentFile = (name: string, frontmatter: string, body: string) =>
    writeFileSync(
      join(project, '.claude', 'agents', `${name}.md`),
      `---\nname: ${name}\n${frontmatter}\n---\n${body}\n`
    );

  it('loads project subagents only once the project is trusted', async () => {
    agentFile('reviewer', 'description: Reviews\nmodel: inner/m', 'You review.');
    const untrusted = runtime(
      { outer: [{ content: 'hi' }] },
      { subagents: { files: { userDirs: [], managedDirs: [] } } }
    );
    await untrusted.cog.run(lead({ workspace }), { input: 'hello' });
    expect(toolNames(untrusted.outer.getLastCall())).not.toContain('agent');
    await untrusted.cog.close();

    const trusted = runtime(
      { outer: [{ content: 'hi' }] },
      { subagents: { files: { root: project, trusted: true, userDirs: [], managedDirs: [] } } }
    );
    await trusted.cog.run(lead({ workspace }), { input: 'hello' });
    expect(toolNames(trusted.outer.getLastCall())).toContain('agent');
    const listed = await trusted.cog.listSubagents({ root: project });
    expect(listed.agents.map((agent) => agent.name)).toEqual(['reviewer']);
    await trusted.cog.close();
  });

  it('trusts the project of permissions.settings with files: true', async () => {
    agentFile('reviewer', 'description: Reviews\nmodel: inner/m', 'You review.');
    const { cog } = runtime(
      { outer: [{ content: 'hi' }] },
      {
        permissions: { settings: { root: project, trusted: true, userDirs: [], managedDirs: [] } },
        subagents: { files: true },
      }
    );
    const listed = await cog.listSubagents();
    expect(listed.agents.map((agent) => agent.name)).toEqual(['reviewer']);
    await cog.close();
  });

  it('runs the hooks of a subagent frontmatter for its own tool calls', async () => {
    agentFile(
      'guarded',
      'description: Guarded\nmodel: inner/m\nhooks:\n  PreToolUse:\n    - matcher: lookup\n      hooks:\n        - type: command\n          command: "echo no lookups >&2; exit 2"',
      'You look things up.'
    );
    const { cog, inner } = runtime(
      {
        outer: [
          turn(call('o1', 'agent', { description: 'x', prompt: 'find', subagent_type: 'guarded' })),
          { content: 'done' },
        ],
        inner: [turn(call('i1', 'lookup', { q: 'x' })), { content: 'blocked' }],
      },
      { subagents: { files: { root: project, trusted: true, userDirs: [], managedDirs: [] } } }
    );
    await cog.run(lead({ workspace }), { input: 'go' });
    expect(toolTexts(inner.getLastCall()?.messages ?? [])[0]).toContain('no lookups');
    await cog.close();
  });

  it('keeps notes in the memory folder of a subagent with memory', async () => {
    agentFile(
      'scribe',
      'description: Keeps notes\nmodel: inner/m\nmemory: project',
      'You take notes.'
    );
    mkdirSync(join(project, '.claude', 'agent-memory', 'scribe'), { recursive: true });
    writeFileSync(
      join(project, '.claude', 'agent-memory', 'scribe', 'MEMORY.md'),
      '- the build uses pnpm\n'
    );
    const { cog, inner } = runtime(
      {
        outer: [
          turn(call('o1', 'agent', { description: 'x', prompt: 'note', subagent_type: 'scribe' })),
          { content: 'done' },
        ],
        inner: [
          turn(call('i1', 'agent_memory', { action: 'append', content: '- tests use vitest' })),
          { content: 'noted' },
        ],
      },
      { subagents: { files: { root: project, trusted: true, userDirs: [], managedDirs: [] } } }
    );
    await cog.run(lead({ workspace }), { input: 'go' });
    expect(String(inner.getCalls()[0]?.messages[0]?.content)).toContain('the build uses pnpm');
    expect(
      readFileSync(join(project, '.claude', 'agent-memory', 'scribe', 'MEMORY.md'), 'utf8')
    ).toBe('- the build uses pnpm\n- tests use vitest\n');
    await cog.close();
  });

  it('runs an isolated subagent in a git worktree, removed when unchanged and kept with changes', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(project, 'README.md'), 'hello\n');
    git('add', 'README.md');
    git('commit', '-q', '-m', 'init');
    agentFile(
      'isolated',
      'description: Works apart\nmodel: inner/m\nisolation: worktree',
      'You edit.'
    );
    const { cog } = runtime(
      {
        outer: [
          turn(
            call('o1', 'agent', { description: 'x', prompt: 'look', subagent_type: 'isolated' })
          ),
          turn(
            call('o2', 'agent', { description: 'x', prompt: 'edit', subagent_type: 'isolated' })
          ),
          { content: 'done' },
        ],
        inner: [
          { content: 'looked' },
          turn(call('i1', 'write_file', { path: 'NEW.md', content: 'made in a worktree' })),
          { content: 'edited' },
        ],
      },
      { subagents: { files: { root: project, trusted: true, userDirs: [], managedDirs: [] } } }
    );
    const result = await cog.run(lead({ workspace, tools: workspaceTools() }), { input: 'go' });
    const [looked, edited] = toolTexts(result.messages).map(
      (text) => JSON.parse(text) as { note?: string; output: string }
    );
    expect(looked?.note).toBeUndefined();
    expect(edited?.note).toContain('.cogitator/worktrees/isolated-');
    expect(existsSync(join(project, 'NEW.md'))).toBe(false);
    const kept = /worktree (\S+) on branch/.exec(edited?.note ?? '')?.[1] ?? '';
    expect(readFileSync(join(kept, 'NEW.md'), 'utf8')).toBe('made in a worktree');
    const worktrees = String(git('worktree', 'list'));
    expect(
      worktrees.split('\n').filter((line) => line.includes('.cogitator/worktrees'))
    ).toHaveLength(1);
    await cog.close();
  });
});

describe('the delegation hooks', () => {
  it('fire the SubagentStart and SubagentStop hooks of the runtime for a subagent', async () => {
    const fired = vi.fn();
    const { cog } = runtime(
      {
        outer: [
          turn(call('o1', 'agent', { description: 'x', prompt: 'p', subagent_type: 'helper' })),
          { content: 'done' },
        ],
      },
      {
        hooks: {
          hooks: {
            SubagentStart: [
              { matcher: 'helper', hooks: [{ type: 'command', command: 'echo start' }] },
            ],
            SubagentStop: [
              { matcher: 'helper', hooks: [{ type: 'command', command: 'echo stop' }] },
            ],
          },
          onHookRun: (record) => fired(record.event, record.outcome),
        },
        subagents: { agents: { helper: { description: 'helps', model: 'inner/m' } } },
      }
    );
    await cog.run(lead(), { input: 'go' });
    expect(fired.mock.calls).toEqual([
      ['SubagentStart', 'success'],
      ['SubagentStop', 'success'],
    ]);
    await cog.close();
  });
});
