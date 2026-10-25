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
  RunMiddleware,
  ToolCall,
} from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { agentAsTool } from '../agent-tool';
import { workspaceTools } from '../tools/workspace-tools';
import { fileRead } from '../tools/filesystem';
import { hooksMiddleware } from '../hooks/middleware';
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

describe('second review round', () => {
  it('keeps the runtime hooks and an agent hooks middleware apart', async () => {
    const allow = script('runtime-allow', decide('allow'));
    const deny = script(
      'agent-deny',
      decide('deny', { permissionDecisionReason: 'agent says no' })
    );
    const { cog } = setup([turn(call('c1', 'note', { text: 'a' }))], {
      hooks: { hooks: { PreToolUse: [{ hooks: [allow.hook] }] } },
    });
    const own = new Agent({
      name: 'coder',
      model: 'mock/m',
      instructions: 'You code.',
      tools: [note],
      workspace,
      middleware: [hooksMiddleware({ hooks: { PreToolUse: [{ hooks: [deny.hook] }] } })],
    });
    const result = await cog.run(own, { input: 'go' });
    expect(noted).not.toHaveBeenCalled();
    expect(toolTexts(result.messages)[0]).toContain('agent says no');
    expect(seen(allow.log)).toHaveLength(1);
    expect(seen(deny.log)).toHaveLength(1);
    await cog.close();
  });

  it('declines an approval a PermissionRequest prompt hook refuses, over another hook that allows', async () => {
    const judge = new MockLLMBackend().setResponses([
      { content: '{"ok": false, "reason": "not to that address"}' },
    ]);
    const allow = script(
      'permit-allow',
      print({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      })
    );
    const onApproval = vi.fn(async () => ({ approved: true as const }));
    const { cog } = setup([turn(call('c1', 'send_email', { to: 'a@b.co', body: 'x' }))], {
      llm: { backends: { judge } },
      hooks: {
        promptModel: 'judge/small',
        hooks: {
          PermissionRequest: [
            { hooks: [allow.hook, { type: 'prompt', prompt: 'May it send? $ARGUMENTS' }] },
          ],
        },
      },
    });
    const result = await cog.run(agent(), { input: 'mail', onApproval });
    expect(sent).not.toHaveBeenCalled();
    expect(onApproval).not.toHaveBeenCalled();
    expect(toolTexts(result.messages)[0]).toContain('not to that address');
    await cog.close();
  });

  it("resolves the host file tools' paths against the working directory and keeps absolute paths", async () => {
    const target = join(base, 'host.txt');
    writeFileSync(target, 'host file');
    const claude = script('host-read', decide('allow', { updatedInput: { file_path: target } }));
    const { cog } = setup([turn(call('c1', 'file_read', { path: 'nowhere.txt' }))], {
      hooks: { hooks: { PreToolUse: [{ matcher: 'Read', hooks: [claude.hook] }] } },
    });
    const host = new Agent({
      name: 'host',
      model: 'mock/m',
      instructions: 'Read.',
      tools: [fileRead],
    });
    const result = await cog.run(host, { input: 'go' });
    expect(seen(claude.log)[0]?.input.tool_input).toEqual({
      file_path: join(process.cwd(), 'nowhere.txt'),
    });
    expect(toolTexts(result.messages)[0]).toContain('host file');
    await cog.close();
  });

  it('counts only the calls that start against the tool call budget', async () => {
    const deny = script('deny-first', `if (input.tool_input.text === 'a') { ${decide('deny')} }`);
    const { cog } = setup(
      [turn(call('c1', 'note', { text: 'a' }), call('c2', 'note', { text: 'b' }))],
      {
        budget: { session: { maxToolCalls: 1 } },
        hooks: { hooks: { PreToolUse: [{ hooks: [deny.hook] }] } },
      }
    );
    const result = await cog.run(agent(), { input: 'go', threadId: 't-budget' });
    expect(result.status).toBe('completed');
    expect(noted).toHaveBeenCalledWith({ text: 'b' }, expect.anything());
    await cog.close();
  });

  it('gives PostToolBatch after a resume the results the step had before the pause', async () => {
    const structured = tool({
      name: 'lookup',
      description: 'Look up',
      parameters: z.object({}),
      execute: async () => ({ success: true }),
    });
    const batch = script('batch-structured');
    const { cog } = setup(
      [turn(call('c1', 'lookup', {}), call('c2', 'send_email', { to: 'a@b.co', body: 'x' }))],
      {
        hooks: {
          hooks: {
            PreToolUse: [{ hooks: [script('noop2').hook] }],
            PostToolBatch: [{ hooks: [batch.hook] }],
          },
        },
      }
    );
    const both = new Agent({
      name: 'coder',
      model: 'mock/m',
      instructions: 'You code.',
      tools: [structured, sendEmail],
      workspace,
    });
    const paused = await cog.run(both, { input: 'go', threadId: 't-batch' });
    await cog.resume(both, paused.checkpoint!, { decisions: { c2: { approved: true } } });
    const calls = seen(batch.log)[0]?.input.tool_calls as Array<{ tool_response: unknown }>;
    expect(calls[0]?.tool_response).toEqual({ success: true });
    await cog.close();
  });

  it('stops before the model call when a beforeModel middleware or a wrapModelCall asks to', async () => {
    const { cog, backend } = setup([turn(call('c1', 'note', { text: 'a' }))]);
    const stopper: RunMiddleware = {
      name: 'stopper',
      beforeModel: (_event, context) => {
        if (context.iteration === 2) context.stop?.('enough');
      },
    };
    const result = await cog.run(agent(), { input: 'go', middleware: [stopper] });
    expect(backend.getCallCount()).toBe(1);
    expect(result.stopped).toEqual({ reason: 'enough', middleware: 'stopper' });
    await cog.close();

    const second = setup([turn(call('c2', 'note', { text: 'b' }))]);
    const late: RunMiddleware = {
      name: 'late',
      wrapModelCall: async (request, next, context) => {
        context.stop?.('no more calls');
        return next(request);
      },
    };
    noted.mockClear();
    const stopped = await second.cog.run(agent(), { input: 'go', middleware: [late] });
    expect(second.backend.getCallCount()).toBe(0);
    expect(noted).not.toHaveBeenCalled();
    expect(stopped.stopped?.reason).toBe('no more calls');
    await second.cog.close();
  });
});

describe('third review round', () => {
  it('checks the thread before SessionStart hooks run, and logs them to the thread', async () => {
    const { hook, log } = script('session-start');
    const { cog } = setup([{ content: 'one' }], {
      hooks: { hooks: { SessionStart: [{ hooks: [hook] }] } },
    });
    await cog.run(agent(), { input: 'go', threadId: 't-owned', userId: 'alice' });
    expect(seen(log)).toHaveLength(1);
    const memory = await cog.getMemory();
    const entries = await memory!.getEntries({ threadId: 't-owned', types: 'all' });
    const logged = (entries.success ? entries.data : []).filter(
      (entry) => entry.type === 'custom' && entry.event?.event === 'SessionStart'
    );
    expect(logged).toHaveLength(1);
    await expect(
      cog.run(agent(), { input: 'go', threadId: 't-owned', userId: 'mallory' })
    ).rejects.toMatchObject({ code: 'THREAD_ACCESS_DENIED' });
    expect(seen(log)).toHaveLength(1);
    await cog.close();
  });

  it('keeps an approval for a call that paused to ask its own question', async () => {
    const ask = tool({
      name: 'ask_amount',
      description: 'Ask',
      parameters: z.object({}),
      requiresApproval: true,
      execute: async (_args, context) => {
        const amount = await context.interrupt?.({ reason: 'amount', message: 'How much?' });
        return `amount ${String(amount)}`;
      },
    });
    const backend = new MockLLMBackend().setResponses([
      turn(call('c1', 'ask_amount', {})),
      { content: 'done' },
    ]);
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { mock: backend }, retry: false },
      hooks: {},
    });
    const asker = new Agent({ name: 'asker', model: 'mock/m', instructions: 'Ask.', tools: [ask] });
    const paused = await cog.run(asker, {
      input: 'go',
      threadId: 't-question',
      onApproval: async () => ({ approved: true }),
    });
    expect(paused.interrupts?.[0]).toMatchObject({ kind: 'input' });
    const question = paused.interrupts?.[0];
    const resumed = await cog.resume(asker, paused.checkpoint!, {
      responses: { [question!.id]: 7 },
    });
    expect(resumed.status).toBe('completed');
    expect(toolTexts(resumed.messages).join('\n')).toContain('amount 7');
    await cog.close();
  });

  it('stops the run on continue: false from a PermissionRequest hook', async () => {
    const { hook } = script(
      'permit-stop',
      print({
        continue: false,
        stopReason: 'emails are frozen',
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      })
    );
    const { cog, backend } = setup([turn(call('c1', 'send_email', { to: 'a@b.co', body: 'x' }))], {
      hooks: { hooks: { PermissionRequest: [{ hooks: [hook] }] } },
    });
    const result = await cog.run(agent(), { input: 'mail' });
    expect(sent).not.toHaveBeenCalled();
    expect(result.stopped?.reason).toBe('emails are frozen');
    expect(backend.getCallCount()).toBe(1);
    await cog.close();
  });

  it('times out an MCP hook whose caller ignores the signal, and blocks with onFailure', async () => {
    const callTool = vi.fn(() => new Promise<{ text: string }>(() => undefined));
    const runs: HookRunRecord[] = [];
    const { cog } = setup([turn(call('c1', 'note', { text: 'a' }))], {
      hooks: {
        mcp: { callTool },
        onHookRun: (run) => runs.push(run),
        hooks: {
          PreToolUse: [
            {
              hooks: [{ type: 'mcp_tool', server: 's', tool: 't', timeout: 1, onFailure: 'block' }],
            },
          ],
        },
      },
    });
    const result = await cog.run(agent(), { input: 'go' });
    expect(runs[0]?.outcome).toBe('timeout');
    expect(noted).not.toHaveBeenCalled();
    expect(toolTexts(result.messages)[0]).toContain('Permission denied');
    await cog.close();
  }, 30_000);
});

describe('fourth review round', () => {
  it('starts no further call of the step once a PostToolUse hook stops the run', async () => {
    const { hook } = script(
      'post-stop',
      print({ continue: false, stopReason: 'halt after the first' })
    );
    const { cog } = setup(
      [
        turn(
          call('c1', 'note', { text: 'a' }),
          call('c2', 'note', { text: 'b' }),
          call('c3', 'send_email', { to: 'a@b.co', body: 'x' })
        ),
      ],
      { hooks: { hooks: { PostToolUse: [{ matcher: 'note', hooks: [hook] }] } } }
    );
    const result = await cog.run(agent(), { input: 'go' });
    expect(result.status).toBe('completed');
    expect(result.stopped?.reason).toBe('halt after the first');
    expect(noted).toHaveBeenCalledTimes(1);
    expect(sent).not.toHaveBeenCalled();
    const texts = toolTexts(result.messages);
    expect(texts).toHaveLength(3);
    expect(texts[1]).toContain('Not started: the run was stopped');
    await cog.close();
  });

  it('keeps stop_hook_active across a pause and resume', async () => {
    const { hook, log } = script(
      'stop-resume',
      `if (!input.stop_hook_active) process.stdout.write(JSON.stringify({ decision: 'block', reason: 'mail the report' }));`
    );
    const { cog } = setup(
      [
        { content: 'first' },
        turn(call('c1', 'send_email', { to: 'a@b.co', body: 'report' })),
        { content: 'second' },
      ],
      { hooks: { hooks: { Stop: [{ hooks: [hook] }] } } }
    );
    const paused = await cog.run(agent(), { input: 'go', threadId: 't-stop' });
    expect(paused.status).toBe('paused');
    const resumed = await cog.resume(agent(), paused.checkpoint!, {
      decisions: { c1: { approved: true } },
    });
    expect(resumed.output).toBe('second');
    expect(seen(log).map((entry) => entry.input.stop_hook_active)).toEqual([false, true]);
    await cog.close();
  });

  it('gives PostToolBatch the arguments the call ran with', async () => {
    const pre = script(
      'pre-change',
      print({
        hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { text: 'changed' } },
      })
    );
    const batch = script('batch-args');
    const { cog } = setup([turn(call('c1', 'note', { text: 'original' }))], {
      hooks: {
        hooks: {
          PreToolUse: [{ hooks: [pre.hook] }],
          PostToolBatch: [{ hooks: [batch.hook] }],
        },
      },
    });
    await cog.run(agent(), { input: 'go' });
    const calls = seen(batch.log)[0]?.input.tool_calls as Array<{ tool_input: unknown }>;
    expect(calls[0]?.tool_input).toEqual({ text: 'changed' });
    await cog.close();
  });
});

describe('fifth review round', () => {
  it('stops a parallel call waiting for its turn when an earlier PreToolUse hook stops the run', async () => {
    const lookedUp = vi.fn(async ({ q }: { q: string }) => `found ${q}`);
    const lookup = tool({
      name: 'lookup',
      description: 'Look up',
      parameters: z.object({ q: z.string() }),
      isConcurrencySafe: true,
      execute: lookedUp,
    });
    const { hook } = script(
      'parallel-stop',
      `if (input.tool_input.q === 'a') process.stdout.write(JSON.stringify({ continue: false, stopReason: 'stop now' }));`
    );
    const { cog } = setup(
      [turn(call('c1', 'lookup', { q: 'a' }), call('c2', 'lookup', { q: 'b' }))],
      { hooks: { hooks: { PreToolUse: [{ hooks: [hook] }] } } }
    );
    const parallel = new Agent({
      name: 'p',
      model: 'mock/m',
      instructions: 'Look.',
      tools: [lookup],
    });
    const result = await cog.run(parallel, { input: 'go', parallelToolCalls: true });
    expect(result.stopped?.reason).toBe('stop now');
    expect(lookedUp).not.toHaveBeenCalled();
    await cog.close();
  });

  it('counts a refusing UserPromptSubmit prompt hook in the usage and the session', async () => {
    const judge = new MockLLMBackend().setResponses([{ content: '{"ok": false, "reason": "no"}' }]);
    const { cog } = setup([], {
      llm: { backends: { judge } },
      budget: { session: { maxTokens: 100_000 } },
      hooks: {
        promptModel: 'judge/small',
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'Fine? $ARGUMENTS' }] }] },
      },
    });
    let usage: { totalTokens: number } | undefined;
    await expect(
      cog.run(agent(), {
        input: 'go',
        threadId: 't-early',
        onRunError: (_error, _runId, spent) => {
          usage = spent;
        },
      })
    ).rejects.toMatchObject({ code: 'GUARDRAIL_TRIPPED' });
    expect(usage?.totalTokens).toBeGreaterThan(0);
    const memory = await cog.getMemory();
    const thread = await memory!.getThread('t-early');
    const spend = thread.success ? (thread.data?.metadata.budget as { tokens: number }) : undefined;
    expect(spend?.tokens).toBeGreaterThan(0);
    await cog.close();
  });

  it('sends context a beforeModel middleware adds with that same model call', async () => {
    const { cog, backend } = setup([]);
    const noteFirst: RunMiddleware = {
      name: 'note-first',
      beforeModel: (_event, context) => {
        if (context.iteration === 1) context.addContext?.('fresh note');
      },
    };
    await cog.run(agent(), { input: 'go', middleware: [noteFirst] });
    expect(systemTexts(backend.getCalls()[0]?.messages)).toContain('fresh note');
    await cog.close();
  });
});
