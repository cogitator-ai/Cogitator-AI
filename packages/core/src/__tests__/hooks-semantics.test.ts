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
  CogitatorConfig,
  CommandHookHandler,
  HookRunRecord,
  Message,
  ToolCall,
} from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { agentAsTool } from '../agent-tool';
import { workspaceTools } from '../tools/workspace-tools';
import { LocalWorkspace } from '../workspace/local-workspace';
import { answer, callTools, deferred, scriptedBackend } from './helpers/scripted-backend';

let base: string;
let root: string;
let workspace: LocalWorkspace;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'hooks-semantics-')));
  root = join(base, 'project');
  mkdirSync(join(root, 'hooks'), { recursive: true });
  workspace = new LocalWorkspace({ root });
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

const sent = vi.fn(async ({ to, body }: { to: string; body: string }) => `sent ${body} to ${to}`);
const sendEmail = tool({
  name: 'send_email',
  description: 'Send an email',
  parameters: z.object({ to: z.string().email(), body: z.string() }),
  requiresApproval: true,
  execute: sent,
});
const noted = vi.fn(async ({ text }: { text: string }) => `noted ${text}`);
const note = tool({
  name: 'note',
  description: 'Note something',
  parameters: z.object({ text: z.string() }),
  execute: noted,
});

beforeEach(() => {
  sent.mockClear();
  noted.mockClear();
});

function setup(responses: MockChatResponse[], config: CogitatorConfig = {}) {
  const backend = new MockLLMBackend().setResponses([...responses, { content: 'done' }]);
  const cog = new Cogitator({
    memory: { adapter: 'memory' },
    ...config,
    llm: { ...config.llm, backends: { mock: backend, ...config.llm?.backends }, retry: false },
  });
  return { cog, backend };
}

const agent = () =>
  new Agent({
    name: 'coder',
    model: 'mock/m',
    instructions: 'You code.',
    tools: [...workspaceTools(), sendEmail, note],
    workspace,
  });

/** A node hook script: the event's JSON appended as a line to `<name>.log`, then `body` */
function script(name: string, body = ''): { hook: CommandHookHandler; log: string } {
  const file = join(root, 'hooks', `${name}.cjs`);
  const log = join(base, `${name}.log`);
  writeFileSync(
    file,
    `const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ input, secret: process.env.HOOK_SECRET ?? null }) + '\\n');
${body}
`
  );
  return { hook: { type: 'command', command: process.execPath, args: [file] }, log };
}

function seen(log: string): Array<{ input: Record<string, unknown>; secret: string | null }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReturnType<typeof seen>[number]);
}

const print = (value: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(value))});`;
const decide = (permissionDecision: string, extra: Record<string, unknown> = {}) =>
  print({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, ...extra } });

const toolTexts = (messages: readonly Message[]) =>
  messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
const systemTexts = (messages: readonly Message[] | undefined) =>
  (messages ?? [])
    .filter((m) => m.role === 'system')
    .map((m) => String(m.content))
    .join('\n');

describe('a PreToolUse allow in the permission flow', () => {
  it('does not get past the ask that guards a deny rule from a command it cannot read', async () => {
    const { hook } = script('allow-hidden', decide('allow'));
    const { cog } = setup(
      [turn(call('c1', 'run_command', { command: 'X=tou; eval "${X}ch pwned"' }))],
      {
        permissions: { deny: ['Bash(touch *)'] },
        hooks: { hooks: { PreToolUse: [{ hooks: [hook] }] } },
      }
    );
    const result = await cog.run(agent(), { input: 'go' });
    expect(result.status).toBe('paused');
    expect(existsSync(join(root, 'pwned'))).toBe(false);
    await cog.close();
  });

  it('lets a call run in dontAsk mode, and skips the auto mode classifier', async () => {
    const { hook } = script('allow-modes', decide('allow'));
    const hooks = { hooks: { PreToolUse: [{ hooks: [hook] }] } };
    const mail = call('c1', 'send_email', { to: 'a@b.co', body: 'hi' });
    const dontAsk = setup([turn(mail)], { permissions: { mode: 'dontAsk' }, hooks });
    expect((await dontAsk.cog.run(agent(), { input: 'mail' })).status).toBe('completed');
    expect(sent).toHaveBeenCalledOnce();
    await dontAsk.cog.close();

    const classify = vi.fn(async () => ({ decision: 'deny' as const, reason: 'no' }));
    const auto = setup([turn(mail)], {
      permissions: { mode: 'auto', classifier: { classify } },
      hooks,
    });
    expect((await auto.cog.run(agent(), { input: 'mail' })).status).toBe('completed');
    expect(classify).not.toHaveBeenCalled();
    expect(sent).toHaveBeenCalledTimes(2);
    await auto.cog.close();
  });

  it('still refuses what a deny rule names', async () => {
    const { hook } = script('allow-deny', decide('allow'));
    const { cog } = setup([turn(call('c1', 'note', { text: 'a' }))], {
      permissions: { deny: ['note'] },
      hooks: { hooks: { PreToolUse: [{ hooks: [hook] }] } },
    });
    const result = await cog.run(agent(), { input: 'go' });
    expect(noted).not.toHaveBeenCalled();
    expect(toolTexts(result.messages)[0]).toContain('Permission denied');
    await cog.close();
  });
});

describe('arguments hooks give a call', () => {
  it('takes PermissionRequest updatedInput without a permissions config', async () => {
    const { hook } = script(
      'permit-input',
      print({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow', updatedInput: { to: 'c@d.co', body: 'changed' } },
        },
      })
    );
    const { cog } = setup([turn(call('c1', 'send_email', { to: 'a@b.co', body: 'hi' }))], {
      hooks: { hooks: { PermissionRequest: [{ hooks: [hook] }] } },
    });
    await cog.run(agent(), { input: 'mail' });
    expect(sent).toHaveBeenCalledWith({ to: 'c@d.co', body: 'changed' }, expect.anything());
    await cog.close();
  });

  it('keeps the arguments a person approved, and asks again when the hook changes them', async () => {
    const counter = join(base, 'count');
    const { hook } = script(
      'sandbox',
      `let n = 0; try { n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')); } catch {}
fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
const text = n === 2 ? 'production' : 'sandbox';
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', updatedInput: { text } } }));`
    );
    const { cog } = setup([turn(call('c1', 'note', { text: 'model' }))], {
      hooks: { hooks: { PreToolUse: [{ hooks: [hook] }] } },
    });
    const paused = await cog.run(agent(), { input: 'go', threadId: 't-args' });
    expect(paused.pendingApprovals?.[0]?.arguments).toEqual({ text: 'sandbox' });
    expect(paused.checkpoint?.turn.changed?.[0]?.arguments).toEqual({ text: 'sandbox' });
    const resumed = await cog.resume(agent(), paused.checkpoint!, {
      decisions: { c1: { approved: true } },
    });
    expect(resumed.status).toBe('completed');
    expect(noted).toHaveBeenCalledWith({ text: 'sandbox' }, expect.anything());
    await cog.close();

    noted.mockClear();
    writeFileSync(counter, '1');
    const again = setup([turn(call('c2', 'note', { text: 'model' }))], {
      hooks: { hooks: { PreToolUse: [{ hooks: [hook] }] } },
    });
    const first = await again.cog.run(agent(), { input: 'go', threadId: 't-args2' });
    expect(first.pendingApprovals?.[0]?.arguments).toEqual({ text: 'sandbox' });
    const second = await again.cog.resume(agent(), first.checkpoint!, {
      decisions: { c2: { approved: true } },
    });
    expect(second.status).toBe('paused');
    expect(second.pendingApprovals?.[0]?.arguments).toEqual({ text: 'production' });
    expect(noted).not.toHaveBeenCalled();
    await again.cog.close();
  });
});

describe('exit codes and processes', () => {
  it('applies the JSON of a hook that exits 1, and reports the run as an error', async () => {
    const { hook } = script(
      'exit-one',
      `${decide('deny', { permissionDecisionReason: 'json wins' })} process.exit(1);`
    );
    const runs: HookRunRecord[] = [];
    const { cog } = setup([turn(call('c1', 'note', { text: 'a' }))], {
      hooks: { hooks: { PreToolUse: [{ hooks: [hook] }] }, onHookRun: (run) => runs.push(run) },
    });
    const result = await cog.run(agent(), { input: 'go' });
    expect(noted).not.toHaveBeenCalled();
    expect(toolTexts(result.messages)[0]).toContain('json wins');
    expect(runs[0]).toMatchObject({ outcome: 'error', exitCode: 1, decision: 'deny' });
    await cog.close();
  });

  it('kills a process the hook left in the background holding its output', async () => {
    const pidFile = join(base, 'sleep.pid');
    const runs: HookRunRecord[] = [];
    const { cog } = setup([turn(call('c1', 'note', { text: 'a' }))], {
      hooks: {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `sleep 30 & echo $! > "${pidFile}"; echo started`,
                  timeout: 60,
                },
              ],
            },
          ],
        },
        onHookRun: (run) => runs.push(run),
      },
    });
    await cog.run(agent(), { input: 'go' });
    expect(runs[0]).toMatchObject({ outcome: 'error' });
    expect(runs[0]?.reason).toContain('kept its output open');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 });
    expect(noted).toHaveBeenCalledOnce();
    await cog.close();
  }, 30_000);

  it('passes only the allowed environment with hooks.env', async () => {
    vi.stubEnv('HOOK_SECRET', 'zzz');
    const { hook, log } = script('env');
    const open = setup([turn(call('c1', 'note', { text: 'a' }))], {
      hooks: { hooks: { PreToolUse: [{ hooks: [hook] }] } },
    });
    await open.cog.run(agent(), { input: 'go' });
    await open.cog.close();
    const narrow = setup([turn(call('c2', 'note', { text: 'b' }))], {
      hooks: { hooks: { PreToolUse: [{ hooks: [hook] }] }, env: { allow: ['PATH'] } },
    });
    await narrow.cog.run(agent(), { input: 'go' });
    await narrow.cog.close();
    vi.unstubAllEnvs();
    expect(seen(log).map((entry) => entry.secret)).toEqual(['zzz', null]);
  });

  it('runs an async hook in the background, its context reaching a later model call', async () => {
    const release = deferred();
    const { hook } = script(
      'async',
      `${print({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'tests passed' } })}`
    );
    const { backend, requests } = scriptedBackend([
      callTools([call('c1', 'note', { text: 'a' })]),
      async () => {
        await release.promise;
        return callTools([call('c2', 'note', { text: 'b' })]);
      },
      answer('done'),
    ]);
    const cog = new Cogitator({
      llm: { backends: { mock: backend }, retry: false },
      hooks: {
        hooks: { PostToolUse: [{ matcher: 'note', hooks: [{ ...hook, async: true }] }] },
        onHookRun: () => release.resolve(),
      },
    });
    const result = await cog.run(agent(), { input: 'go' });
    expect(result.output).toBe('done');
    expect(systemTexts(requests[2]?.messages)).toContain('tests passed');
    await cog.close();
  });
});

describe('the order and shape of tool events', () => {
  it('decides each call of a step right before it runs, after the calls before it', async () => {
    const { hook, log } = script(
      'sequential',
      `fs.appendFileSync(${JSON.stringify(join(base, 'order.log'))}, String(fs.existsSync(${JSON.stringify(join(root, 'a.txt'))})) + '\\n');`
    );
    const { cog } = setup(
      [
        turn(
          call('c1', 'write_file', { path: 'a.txt', content: 'x' }),
          call('c2', 'note', { text: 'b' })
        ),
      ],
      {
        permissions: { mode: 'bypassPermissions' },
        hooks: { hooks: { PreToolUse: [{ matcher: 'note', hooks: [hook] }] } },
      }
    );
    await cog.run(agent(), { input: 'go' });
    expect(seen(log)).toHaveLength(1);
    expect(readFileSync(join(base, 'order.log'), 'utf8').trim()).toBe('true');
    await cog.close();
  });

  it("sends Claude Code's names and shapes to hooks that match them, and reads updatedInput back", async () => {
    writeFileSync(join(root, 'a.txt'), 'from a');
    writeFileSync(join(root, 'b.txt'), 'from b');
    const claude = script(
      'claude-read',
      decide('allow', { updatedInput: { file_path: join(root, 'b.txt') } })
    );
    const ours = script('our-read');
    const { cog } = setup(
      [
        turn(call('c1', 'read_file', { path: 'a.txt' })),
        turn(call('c2', 'grep', { pattern: 'x' })),
      ],
      {
        hooks: {
          hooks: {
            PreToolUse: [
              { matcher: 'Read', hooks: [claude.hook] },
              { matcher: 'read_file', hooks: [ours.hook] },
            ],
          },
        },
      }
    );
    const result = await cog.run(agent(), { input: 'go' });
    expect(seen(claude.log).map((entry) => entry.input)).toEqual([
      expect.objectContaining({
        tool_name: 'Read',
        tool_input: { file_path: join(root, 'a.txt') },
      }),
    ]);
    expect(seen(ours.log)[0]?.input).toMatchObject({
      tool_name: 'read_file',
      tool_input: { path: 'a.txt' },
    });
    expect(toolTexts(result.messages)[0]).toContain('from b');
    await cog.close();
  });

  it('keeps the context and the batch of a step that paused in the middle', async () => {
    const post = script(
      'post-context',
      print({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'noted it' } })
    );
    const batch = script('batch');
    const { cog, backend } = setup(
      [
        turn(
          call('c1', 'note', { text: 'a' }),
          call('c2', 'send_email', { to: 'a@b.co', body: 'x' })
        ),
      ],
      {
        hooks: {
          hooks: {
            PreToolUse: [{ hooks: [script('noop').hook] }],
            PostToolUse: [{ matcher: 'note', hooks: [post.hook] }],
            PostToolBatch: [{ hooks: [batch.hook] }],
          },
        },
      }
    );
    const paused = await cog.run(agent(), { input: 'go', threadId: 't-mid' });
    expect(paused.status).toBe('paused');
    expect(paused.checkpoint?.context?.join('\n')).toContain('noted it');
    await cog.resume(agent(), paused.checkpoint!, { decisions: { c2: { approved: true } } });
    expect(systemTexts(backend.getCalls()[1]?.messages)).toContain('noted it');
    expect((seen(batch.log)[0]?.input.tool_calls as unknown[]).length).toBe(2);
    await cog.close();
  });
});

describe('UserPromptSubmit, Stop and spending', () => {
  it('keeps stop_hook_active true until the next user message, across tool calls', async () => {
    const { hook, log } = script(
      'stop',
      `if (!input.stop_hook_active) process.stdout.write(JSON.stringify({ decision: 'block', reason: 'check once more' }));`
    );
    const { cog } = setup(
      [{ content: 'first' }, turn(call('c1', 'note', { text: 'a' })), { content: 'second' }],
      { hooks: { hooks: { Stop: [{ hooks: [hook] }] } } }
    );
    const result = await cog.run(agent(), { input: 'go' });
    expect(result.output).toBe('second');
    expect(seen(log).map((entry) => entry.input.stop_hook_active)).toEqual([false, true]);
    await cog.close();
  });

  it('does not run UserPromptSubmit for a delegated run', async () => {
    const { hook, log } = script('prompt');
    const inner = new MockLLMBackend().setResponses([{ content: 'inner' }]);
    const helper = new Agent({ name: 'helper', model: 'inner/m', instructions: 'Help.' });
    const backend = new MockLLMBackend().setResponses([
      turn(call('c1', 'ask_helper', { task: 'look' })),
      { content: 'outer' },
    ]);
    const cog = new Cogitator({
      llm: { backends: { mock: backend, inner }, retry: false },
      hooks: { hooks: { UserPromptSubmit: [{ hooks: [hook] }] } },
    });
    const lead = new Agent({
      name: 'lead',
      model: 'mock/m',
      instructions: 'Lead.',
      tools: [agentAsTool(cog, helper, { name: 'ask_helper', description: 'Ask' })],
    });
    await cog.run(lead, { input: 'go' });
    expect(seen(log).map((entry) => entry.input.prompt)).toEqual(['go']);
    await cog.close();
  });

  it('counts what a UserPromptSubmit prompt hook spends in the run', async () => {
    const run = async (withHook: boolean) => {
      const judge = new MockLLMBackend().setResponses([{ content: '{"ok": true}' }]);
      const { cog } = setup([], {
        llm: { backends: { judge } },
        hooks: withHook
          ? {
              promptModel: 'judge/small',
              hooks: {
                UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'Fine? $ARGUMENTS' }] }],
              },
            }
          : {},
      });
      const result = await cog.run(agent(), { input: 'go' });
      await cog.close();
      return result.usage.totalTokens;
    };
    expect(await run(true)).toBeGreaterThan(await run(false));
  });
});
