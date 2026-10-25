import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MockLLMBackend, type MockChatResponse } from '@cogitator-ai/test-utils';
import {
  ErrorCode,
  type CogitatorConfig,
  type CommandHookHandler,
  type HookRunRecord,
  type HookSettings,
  type Message,
  type ToolCall,
} from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { agentAsTool } from '../agent-tool';
import { workspaceTools } from '../tools/workspace-tools';
import { LocalWorkspace } from '../workspace/local-workspace';

let base: string;
let root: string;
let workspace: LocalWorkspace;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'hooks-runtime-')));
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

const ran = vi.fn(async ({ to }: { to: string; body: string }) => `sent to ${to}`);
const sendEmail = tool({
  name: 'send_email',
  description: 'Send an email',
  parameters: z.object({ to: z.string().email(), body: z.string() }),
  requiresApproval: true,
  execute: ran,
});
const noted = vi.fn(async ({ text }: { text: string }) => `noted ${text}`);
const note = tool({
  name: 'note',
  description: 'Note something',
  parameters: z.object({ text: z.string() }),
  execute: noted,
});
const broken = tool({
  name: 'broken',
  description: 'Always fails',
  parameters: z.object({}),
  execute: async () => {
    throw new Error('it broke');
  },
});

beforeEach(() => {
  ran.mockClear();
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

const agent = (extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) =>
  new Agent({
    name: 'coder',
    model: 'mock/m',
    instructions: 'You code.',
    tools: [...workspaceTools(), sendEmail, note, broken],
    workspace,
    ...extra,
  });

/**
 * A node script for a command hook: it reads the event's JSON from stdin, appends it (with the
 * environment and the working directory it saw) as a line to `<name>.log`, then runs `body`
 */
function script(name: string, body = ''): { command: string; args: string[]; log: string } {
  const file = join(root, 'hooks', `${name}.cjs`);
  const log = join(base, `${name}.log`);
  writeFileSync(
    file,
    `const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ input, cwd: process.cwd(), claude: process.env.CLAUDE_PROJECT_DIR, cogitator: process.env.COGITATOR_PROJECT_DIR }) + '\\n');
${body}
`
  );
  return { command: process.execPath, args: [file], log };
}

function seen(log: string): Array<{
  input: Record<string, unknown>;
  cwd: string;
  claude?: string;
  cogitator?: string;
}> {
  try {
    return readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ReturnType<typeof seen>[number]);
  } catch {
    return [];
  }
}

const command = (
  hook: ReturnType<typeof script>,
  extra: Partial<CommandHookHandler> = {}
): CommandHookHandler => ({ type: 'command', command: hook.command, args: hook.args, ...extra });

const json = (value: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(value))});`;

function toolTexts(messages: readonly Message[]): string[] {
  return messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
}

function systemTexts(messages: readonly Message[]): string[] {
  return messages.filter((m) => m.role === 'system').map((m) => String(m.content));
}

describe('hooks are off by default', () => {
  it('runs as before without hooks', async () => {
    const { cog } = setup([turn(call('c1', 'note', { text: 'a' }))]);
    const result = await cog.run(agent(), { input: 'go' });
    expect(result.output).toBe('done');
    expect(noted).toHaveBeenCalledOnce();
    expect(result.stopped).toBeUndefined();
    await cog.close();
  });
});

describe('PreToolUse', () => {
  it('blocks a call with exit code 2, the model reads stderr, the tool does not run', async () => {
    const hook = script('pre', `process.stderr.write('no notes today'); process.exit(2);`);
    const { cog } = setup([turn(call('c1', 'note', { text: 'a' }))], {
      hooks: { hooks: { PreToolUse: [{ matcher: 'note', hooks: [command(hook)] }] } },
    });
    const result = await cog.run(agent(), { input: 'go' });
    expect(noted).not.toHaveBeenCalled();
    expect(toolTexts(result.messages)[0]).toContain('PreToolUse:note hook error');
    expect(toolTexts(result.messages)[0]).toContain('no notes today');
    const [entry] = seen(hook.log);
    expect(entry?.input).toMatchObject({
      hook_event_name: 'PreToolUse',
      tool_name: 'note',
      tool_input: { text: 'a' },
      tool_use_id: 'c1',
      cwd: root,
    });
    expect(entry?.cwd).toBe(root);
    expect(entry?.claude).toBe(root);
    expect(entry?.cogitator).toBe(root);
    await cog.close();
  });

  it('denies with a JSON decision and its reason', async () => {
    const hook = script(
      'deny',
      json({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'notes are read-only',
        },
      })
    );
    const { cog } = setup([turn(call('c1', 'note', { text: 'a' }))], {
      hooks: { hooks: { PreToolUse: [{ hooks: [command(hook)] }] } },
    });
    const result = await cog.run(agent(), { input: 'go' });
    expect(noted).not.toHaveBeenCalled();
    expect(toolTexts(result.messages)[0]).toContain('Permission denied: notes are read-only');
    await cog.close();
  });

  it('changes the arguments, and refuses arguments the schema rejects', async () => {
    const rewrite = script(
      'rewrite',
      json({
        hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { text: 'rewritten' } },
      })
    );
    const { cog } = setup([turn(call('c1', 'note', { text: 'a' }))], {
      hooks: { hooks: { PreToolUse: [{ hooks: [command(rewrite)] }] } },
    });
    const result = await cog.run(agent(), { input: 'go' });
    expect(noted).toHaveBeenCalledWith({ text: 'rewritten' }, expect.anything());
    expect(toolTexts(result.messages)[0]).toContain('noted rewritten');
    await cog.close();

    const invalid = script(
      'invalid',
      json({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { text: 42 } } })
    );
    const second = setup([turn(call('c2', 'note', { text: 'b' }))], {
      hooks: { hooks: { PreToolUse: [{ hooks: [command(invalid)] }] } },
    });
    noted.mockClear();
    const refused = await second.cog.run(agent(), { input: 'go' });
    expect(noted).not.toHaveBeenCalled();
    expect(toolTexts(refused.messages)[0]).toContain("do not match the tool's schema");
    await second.cog.close();
  });

  it('allow lets a tool that needs approval run without asking, ask makes a free call ask', async () => {
    const allow = script(
      'allow',
      json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
    );
    const { cog } = setup([turn(call('c1', 'send_email', { to: 'a@b.co', body: 'hi' }))], {
      hooks: { hooks: { PreToolUse: [{ matcher: 'send_email', hooks: [command(allow)] }] } },
    });
    const result = await cog.run(agent(), { input: 'mail' });
    expect(result.status).toBe('completed');
    expect(ran).toHaveBeenCalledOnce();
    await cog.close();

    const ask = script(
      'ask',
      json({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'check the note first',
        },
      })
    );
    const second = setup([turn(call('c2', 'note', { text: 'b' }))], {
      hooks: { hooks: { PreToolUse: [{ matcher: 'note', hooks: [command(ask)] }] } },
    });
    const paused = await second.cog.run(agent(), { input: 'go' });
    expect(paused.status).toBe('paused');
    expect(paused.pendingApprovals?.[0]).toMatchObject({ toolName: 'note' });
    expect(noted).not.toHaveBeenCalled();
    await second.cog.close();
  });

  it('allow does not get past an ask rule', async () => {
    const allow = script(
      'allow-rule',
      json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
    );
    const { cog } = setup([turn(call('c1', 'note', { text: 'a' }))], {
      permissions: { ask: ['note'] },
      hooks: { hooks: { PreToolUse: [{ hooks: [command(allow)] }] } },
    });
    const result = await cog.run(agent(), { input: 'go' });
    expect(result.status).toBe('paused');
    await cog.close();
  });

  it('defer pauses the run, and the hook decides again on resume', async () => {
    const counter = join(base, 'defer-count');
    const hook = script(
      'defer',
      `const fs2 = require('node:fs');
let n = 0; try { n = Number(fs2.readFileSync(${JSON.stringify(counter)}, 'utf8')); } catch {}
fs2.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: n === 0 ? 'defer' : 'allow', updatedInput: { text: 'answered' } } }));`
    );
    const { cog } = setup([turn(call('c1', 'note', { text: 'a' }))], {
      hooks: { hooks: { PreToolUse: [{ hooks: [command(hook)] }] } },
    });
    const paused = await cog.run(agent(), {
      input: 'go',
      threadId: 't-defer',
      onApproval: async () => ({ approved: true }),
    });
    expect(paused.status).toBe('paused');
    expect(paused.pendingApprovals?.[0]).toMatchObject({ toolName: 'note' });
    expect(noted).not.toHaveBeenCalled();
    const resumed = await cog.resume(agent(), paused.checkpoint!, {
      decisions: { c1: { approved: true } },
    });
    expect(resumed.status).toBe('completed');
    expect(noted).toHaveBeenCalledWith({ text: 'answered' }, expect.anything());
    expect(seen(hook.log).map((entry) => entry.input.hook_event_name)).toEqual([
      'PreToolUse',
      'PreToolUse',
    ]);
    await cog.close();
  });

  it('matches Claude Code tool names, regular expressions and the if rule', async () => {
    const bash = script('bash');
    const write = script('write');
    const regex = script('regex');
    const rm = script('rm');
    const { cog } = setup(
      [
        turn(call('c1', 'run_command', { command: 'echo hi' })),
        turn(call('c2', 'write_file', { path: 'a.txt', content: 'x' })),
        turn(call('c3', 'run_command', { command: 'rm -f a.txt' })),
      ],
      {
        permissions: { mode: 'bypassPermissions' },
        hooks: {
          hooks: {
            PreToolUse: [
              { matcher: 'Bash', hooks: [command(bash)] },
              { matcher: 'Edit|Write', hooks: [command(write)] },
              { matcher: '^write_', hooks: [command(regex)] },
              { matcher: 'Bash', hooks: [command(rm, { if: 'Bash(rm *)' })] },
            ],
          },
        },
      }
    );
    await cog.run(agent(), { input: 'go' });
    expect(seen(bash.log).map((entry) => entry.input.tool_use_id)).toEqual(['c1', 'c3']);
    expect(seen(write.log).map((entry) => entry.input.tool_use_id)).toEqual(['c2']);
    expect(seen(regex.log).map((entry) => entry.input.tool_use_id)).toEqual(['c2']);
    expect(seen(rm.log).map((entry) => entry.input.tool_use_id)).toEqual(['c3']);
    await cog.close();
  });

  it('a failing hook lets the call run, onFailure block refuses it', async () => {
    const failing = script('fails', `process.stderr.write('crash'); process.exit(1);`);
    const { cog } = setup([turn(call('c1', 'note', { text: 'a' }))], {
      hooks: { hooks: { PreToolUse: [{ hooks: [command(failing)] }] } },
    });
    await cog.run(agent(), { input: 'go' });
    expect(noted).toHaveBeenCalledOnce();
    await cog.close();

    noted.mockClear();
    const strict = setup([turn(call('c2', 'note', { text: 'b' }))], {
      hooks: { hooks: { PreToolUse: [{ hooks: [command(failing, { onFailure: 'block' })] }] } },
    });
    const result = await strict.cog.run(agent(), { input: 'go' });
    expect(noted).not.toHaveBeenCalled();
    expect(toolTexts(result.messages)[0]).toContain('Permission denied');
    await strict.cog.close();
  });

  it('kills a hook at its timeout with its process group, and the call goes on', async () => {
    const pidFile = join(base, 'child.pid');
    const hook = script(
      'slow',
      `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);`
    );
    const runs: HookRunRecord[] = [];
    const { cog } = setup([turn(call('c1', 'note', { text: 'a' }))], {
      hooks: {
        hooks: { PreToolUse: [{ hooks: [command(hook, { timeout: 1 })] }] },
        onHookRun: (run) => runs.push(run),
      },
    });
    await cog.run(agent(), { input: 'go' });
    expect(noted).toHaveBeenCalledOnce();
    expect(runs[0]).toMatchObject({ event: 'PreToolUse', outcome: 'timeout' });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await vi.waitFor(
      () => {
        expect(() => process.kill(pid, 0)).toThrow();
      },
      { timeout: 10_000 }
    );
    await cog.close();
  }, 30_000);

  it('caps what a hook prints', async () => {
    const hook = script('loud', `process.stdout.write('x'.repeat(200000));`);
    const runs: HookRunRecord[] = [];
    const { cog } = setup([turn(call('c1', 'note', { text: 'a' }))], {
      hooks: {
        hooks: { PreToolUse: [{ hooks: [command(hook)] }] },
        maxOutputBytes: 1000,
        onHookRun: (run) => runs.push(run),
      },
    });
    await cog.run(agent(), { input: 'go' });
    expect(runs[0]?.outcome).toBe('success');
    expect(noted).toHaveBeenCalledOnce();
    await cog.close();
  });

  it('runs shell commands without putting the arguments on the command line', async () => {
    const marker = join(base, 'shell.out');
    const { cog } = setup([turn(call('c1', 'note', { text: '$(touch pwned)' }))], {
      hooks: {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `cat > "${marker}"; test -n "$CLAUDE_PROJECT_DIR"`,
                },
              ],
            },
          ],
        },
      },
    });
    await cog.run(agent(), { input: 'go' });
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({
      tool_input: { text: '$(touch pwned)' },
    });
    expect(() => readFileSync(join(root, 'pwned'))).toThrow();
    await cog.close();
  });
});

describe('PostToolUse, PostToolUseFailure and PostToolBatch', () => {
  it('adds context for the next model call and replaces the output the model reads', async () => {
    const hook = script(
      'post',
      json({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: 'The note is in the journal now.',
          updatedToolOutput: 'redacted',
        },
      })
    );
    const { cog, backend } = setup([turn(call('c1', 'note', { text: 'secret' }))], {
      hooks: { hooks: { PostToolUse: [{ matcher: 'note', hooks: [command(hook)] }] } },
    });
    const result = await cog.run(agent(), { input: 'go', threadId: 't-post' });
    expect(toolTexts(result.messages)[0]).toBe('"redacted"');
    const second = backend.getCalls()[1];
    expect(systemTexts(second?.messages ?? []).join('\n')).toContain(
      'PostToolUse hook additional context: The note is in the journal now.'
    );
    const [entry] = seen(hook.log);
    expect(entry?.input).toMatchObject({ tool_response: 'noted secret', tool_use_id: 'c1' });
    await cog.close();
  });

  it('fires PostToolUseFailure with the error, stderr of exit code 2 reaches the model', async () => {
    const hook = script('failure', `process.stderr.write('see the runbook'); process.exit(2);`);
    const { cog, backend } = setup([turn(call('c1', 'broken', {}))], {
      hooks: { hooks: { PostToolUseFailure: [{ hooks: [command(hook)] }] } },
    });
    await cog.run(agent(), { input: 'go' });
    const [entry] = seen(hook.log);
    expect(entry?.input).toMatchObject({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'broken',
    });
    expect(String(entry?.input.error)).toContain('it broke');
    expect(systemTexts(backend.getCalls()[1]?.messages ?? []).join('\n')).toContain(
      'see the runbook'
    );
    await cog.close();
  });

  it('stops the run from PostToolBatch, with the reason and the middleware', async () => {
    const hook = script('batch', json({ decision: 'block', reason: 'tests are red' }));
    const { cog, backend } = setup(
      [turn(call('c1', 'note', { text: 'a' }), call('c2', 'note', { text: 'b' }))],
      { hooks: { hooks: { PostToolBatch: [{ hooks: [command(hook)] }] } } }
    );
    const result = await cog.run(agent(), { input: 'go' });
    expect(result.stopped).toEqual({ reason: 'tests are red', middleware: 'cogitator:hooks' });
    expect(backend.getCallCount()).toBe(1);
    const [entry] = seen(hook.log);
    expect((entry?.input.tool_calls as unknown[]).length).toBe(2);
    await cog.close();
  });
});

describe('UserPromptSubmit, SessionStart, Stop and SessionEnd', () => {
  it('adds context after the input, and blocks a prompt with exit code 2', async () => {
    const hook = script('prompt', `process.stdout.write('Today is a holiday.');`);
    const { cog, backend } = setup([], {
      hooks: { hooks: { UserPromptSubmit: [{ hooks: [command(hook)] }] } },
    });
    await cog.run(agent(), { input: 'plan my day', threadId: 't-prompt' });
    const messages = backend.getCalls()[0]?.messages ?? [];
    const last = messages.at(-1);
    expect(last?.role).toBe('system');
    expect(String(last?.content)).toContain('Today is a holiday.');
    expect(seen(hook.log)[0]?.input).toMatchObject({ prompt: 'plan my day' });
    await cog.close();

    const blocker = script('block-prompt', `process.stderr.write('no secrets'); process.exit(2);`);
    const second = setup([], {
      hooks: { hooks: { UserPromptSubmit: [{ hooks: [command(blocker)] }] } },
    });
    await expect(second.cog.run(agent(), { input: 'password is x' })).rejects.toMatchObject({
      code: ErrorCode.GUARDRAIL_TRIPPED,
    });
    expect(second.backend.getCallCount()).toBe(0);
    await second.cog.close();
  });

  it('adds SessionStart context after the system prompt, startup then resume', async () => {
    const hook = script('start', `process.stdout.write('Branch: main');`);
    const { cog, backend } = setup([{ content: 'first' }, { content: 'second' }], {
      hooks: { hooks: { SessionStart: [{ hooks: [command(hook)] }] } },
    });
    await cog.run(agent(), { input: 'one', threadId: 't-start' });
    await cog.run(agent(), { input: 'two', threadId: 't-start' });
    const first = backend.getCalls()[0]?.messages ?? [];
    expect(first[0]?.role).toBe('system');
    expect(first[1]).toEqual({
      role: 'system',
      content: 'SessionStart hook additional context: Branch: main',
    });
    expect(seen(hook.log).map((entry) => entry.input.source)).toEqual(['startup', 'resume']);
    const secondRun = backend.getCalls()[1]?.messages ?? [];
    expect(systemTexts(secondRun).filter((text) => text.includes('Branch: main'))).toHaveLength(1);
    await cog.close();
  });

  it('keeps the run going from Stop until the hook lets it stop', async () => {
    const hook = script(
      'stop',
      `if (!input.stop_hook_active) { process.stdout.write(JSON.stringify({ decision: 'block', reason: 'run the tests first' })); }`
    );
    const { cog, backend } = setup([{ content: 'all done' }, { content: 'tests pass' }], {
      hooks: { hooks: { Stop: [{ hooks: [command(hook)] }] } },
    });
    const result = await cog.run(agent(), { input: 'fix it' });
    expect(result.output).toBe('tests pass');
    expect(backend.getCallCount()).toBe(2);
    const second = backend.getCalls()[1]?.messages ?? [];
    expect(String(second.at(-1)?.content)).toContain('run the tests first');
    expect(seen(hook.log).map((entry) => entry.input.last_assistant_message)).toEqual([
      'all done',
      'tests pass',
    ]);
    await cog.close();
  });

  it('runs SessionEnd when a run completes, pauses and fails', async () => {
    const hook = script('end');
    const config: CogitatorConfig = {
      hooks: { hooks: { SessionEnd: [{ hooks: [command(hook)] }] } },
    };
    const completed = setup([], config);
    await completed.cog.run(agent(), { input: 'go' });
    await completed.cog.close();

    const paused = setup([turn(call('c1', 'send_email', { to: 'a@b.co', body: 'x' }))], config);
    expect((await paused.cog.run(agent(), { input: 'mail' })).status).toBe('paused');
    await paused.cog.close();

    const failing = new MockLLMBackend().setResponses([{ error: new Error('model down') }]);
    const failed = new Cogitator({
      ...config,
      llm: { backends: { mock: failing }, retry: false },
    });
    await expect(failed.run(agent(), { input: 'go' })).rejects.toThrow('model down');
    await failed.close();

    expect(seen(hook.log).map((entry) => entry.input)).toEqual([
      expect.objectContaining({ hook_event_name: 'SessionEnd', reason: 'other' }),
      expect.objectContaining({ hook_event_name: 'SessionEnd', reason: 'other' }),
      expect.objectContaining({ hook_event_name: 'SessionEnd', reason: 'other' }),
    ]);
  });
});

describe('PermissionRequest and Notification', () => {
  it('answers an approval before onApproval does, logged as decided by a hook', async () => {
    const hook = script(
      'permit',
      json({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      })
    );
    const onApproval = vi.fn(async () => ({ approved: false as const }));
    const { cog } = setup([turn(call('c1', 'send_email', { to: 'a@b.co', body: 'x' }))], {
      permissions: {},
      hooks: { hooks: { PermissionRequest: [{ matcher: 'send_email', hooks: [command(hook)] }] } },
    });
    const decisions: string[] = [];
    const result = await cog.run(agent(), {
      input: 'mail',
      onApproval,
      onPermissionDecision: (event) => decisions.push(`${event.decision}:${event.decidedBy}`),
    });
    expect(result.status).toBe('completed');
    expect(onApproval).not.toHaveBeenCalled();
    expect(ran).toHaveBeenCalledOnce();
    expect(decisions).toEqual(['allow:hook']);
    await cog.close();
  });

  it('declines with the hook message, and tells Notification hooks of approvals left to a person', async () => {
    const deny = script(
      'refuse',
      json({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: 'not on Fridays' },
        },
      })
    );
    const { cog } = setup([turn(call('c1', 'send_email', { to: 'a@b.co', body: 'x' }))], {
      hooks: { hooks: { PermissionRequest: [{ hooks: [command(deny)] }] } },
    });
    const result = await cog.run(agent(), { input: 'mail' });
    expect(ran).not.toHaveBeenCalled();
    expect(toolTexts(result.messages)[0]).toContain(
      'A hook declined this tool call: not on Fridays'
    );
    await cog.close();

    const notify = script('notify');
    const second = setup([turn(call('c2', 'send_email', { to: 'a@b.co', body: 'x' }))], {
      hooks: {
        hooks: { Notification: [{ matcher: 'permission_prompt', hooks: [command(notify)] }] },
      },
    });
    expect((await second.cog.run(agent(), { input: 'mail' })).status).toBe('paused');
    await vi.waitFor(() => expect(seen(notify.log)).toHaveLength(1));
    expect(seen(notify.log)[0]?.input).toMatchObject({ notification_type: 'permission_prompt' });
    await second.cog.close();
  });
});

describe('subagents, model switches, logs and trust', () => {
  it('fires SubagentStart and SubagentStop for a delegated run, not SessionStart', async () => {
    const start = script(
      'sub-start',
      json({
        hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: 'Be brief.' },
      })
    );
    const stop = script('sub-stop');
    const session = script('session');
    const inner = new MockLLMBackend().setResponses([{ content: 'inner answer' }]);
    const helper = new Agent({ name: 'helper', model: 'inner/m', instructions: 'Help.' });
    const backend = new MockLLMBackend().setResponses([
      turn(call('c1', 'ask_helper', { task: 'look' })),
      { content: 'outer done' },
    ]);
    const cog = new Cogitator({
      llm: { backends: { mock: backend, inner }, retry: false },
      hooks: {
        hooks: {
          SubagentStart: [{ matcher: 'helper', hooks: [command(start)] }],
          SubagentStop: [{ hooks: [command(stop)] }],
          SessionStart: [{ hooks: [command(session)] }],
        },
      },
    });
    const lead = new Agent({
      name: 'lead',
      model: 'mock/m',
      instructions: 'Lead.',
      tools: [agentAsTool(cog, helper, { name: 'ask_helper', description: 'Ask the helper' })],
    });
    const result = await cog.run(lead, { input: 'go' });
    expect(result.output).toBe('outer done');
    expect(seen(start.log)[0]?.input).toMatchObject({ agent_type: 'helper' });
    expect(seen(stop.log)[0]?.input).toMatchObject({
      hook_event_name: 'SubagentStop',
      agent_type: 'helper',
      last_assistant_message: 'inner answer',
    });
    expect(seen(session.log)).toHaveLength(1);
    expect(systemTexts(inner.getCalls()[0]?.messages ?? []).join('\n')).toContain('Be brief.');
    await cog.close();
  });

  it('blocks a handoff to an agent on another model with PreModelSwitch', async () => {
    const hook = script('switch', `process.stderr.write('stay on this model'); process.exit(2);`);
    const expert = new Agent({ name: 'expert', model: 'other/m', instructions: 'Expert.' });
    const other = new MockLLMBackend().setResponses([{ content: 'expert here' }]);
    const { cog, backend } = setup(
      [turn(call('c1', 'transfer_to_expert', { reason: 'hard' })), { content: 'stayed' }],
      {
        llm: { backends: { other } },
        hooks: { hooks: { PreModelSwitch: [{ hooks: [command(hook)] }] } },
      }
    );
    const result = await cog.run(agent({ handoffs: [expert] }), { input: 'go' });
    expect(result.finalAgent).toBeUndefined();
    expect(other.getCallCount()).toBe(0);
    expect(seen(hook.log)[0]?.input).toMatchObject({ from_model: 'mock/m', to_model: 'other/m' });
    expect(systemTexts(backend.getCalls()[1]?.messages ?? []).join('\n')).toContain(
      'stay on this model'
    );
    await cog.close();
  });

  it('logs every hook run as a custom entry of the thread', async () => {
    const hook = script('logged');
    const { cog } = setup([turn(call('c1', 'note', { text: 'a' }))], {
      hooks: { hooks: { PreToolUse: [{ hooks: [command(hook)] }] } },
    });
    await cog.run(agent(), { input: 'go', threadId: 't-log' });
    const memory = await cog.getMemory();
    const entries = await memory!.getEntries({ threadId: 't-log', types: 'all' });
    const hooks = (entries.success ? entries.data : []).filter(
      (entry) => entry.type === 'custom' && entry.event?.kind === 'hook'
    );
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.event).toMatchObject({
      event: 'PreToolUse',
      type: 'command',
      outcome: 'success',
      source: 'code',
      exitCode: 0,
    });
    await cog.close();
  });

  it('runs a project settings file hook only once the project is trusted', async () => {
    const hook = script('project');
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [command(hook)] }] } })
    );
    const places = { userDirs: [join(base, 'user')], managedDirs: [join(base, 'managed')] };
    const untrusted = setup([turn(call('c1', 'note', { text: 'a' }))], {
      hooks: { settings: places },
    });
    await untrusted.cog.run(agent(), { input: 'go' });
    expect(seen(hook.log)).toHaveLength(0);
    await untrusted.cog.close();

    const trusted = setup([turn(call('c2', 'note', { text: 'b' }))], {
      hooks: { settings: { ...places, trusted: true } },
    });
    await trusted.cog.run(agent(), { input: 'go' });
    expect(seen(hook.log)).toHaveLength(1);
    await trusted.cog.close();

    const byPermissions = setup([turn(call('c3', 'note', { text: 'c' }))], {
      permissions: { settings: { ...places, trusted: true } },
      hooks: { settings: true },
    });
    await byPermissions.cog.run(agent(), { input: 'go' });
    expect(seen(hook.log)).toHaveLength(2);
    await byPermissions.cog.close();
  });

  it('runs user settings hooks and honors disableAllHooks of a higher layer', async () => {
    const hook = script('user');
    const user = join(base, 'user');
    mkdirSync(user, { recursive: true });
    writeFileSync(
      join(user, 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [command(hook)] }] } })
    );
    const places = { userDirs: [user], managedDirs: [join(base, 'managed')], trusted: true };
    const on = setup([turn(call('c1', 'note', { text: 'a' }))], { hooks: { settings: places } });
    await on.cog.run(agent(), { input: 'go' });
    expect(seen(hook.log)).toHaveLength(1);
    await on.cog.close();

    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'settings.local.json'),
      JSON.stringify({ disableAllHooks: true })
    );
    const off = setup([turn(call('c2', 'note', { text: 'b' }))], { hooks: { settings: places } });
    await off.cog.run(agent(), { input: 'go' });
    expect(seen(hook.log)).toHaveLength(1);
    await off.cog.close();
  });

  it('runs PreToolUse hooks for invokeTool too', async () => {
    const hook = script('invoke', `process.stderr.write('not here'); process.exit(2);`);
    const cog = new Cogitator({
      hooks: { hooks: { PreToolUse: [{ hooks: [command(hook)] }] } },
    });
    const result = await cog.invokeTool(note, { text: 'a' }, { workspace });
    expect(result.error).toContain('not here');
    expect(noted).not.toHaveBeenCalled();
    await cog.close();
  });
});

describe('prompt and mcp_tool hooks', () => {
  it('asks a model for a prompt hook and denies what it refuses', async () => {
    const judge = new MockLLMBackend().setResponses([
      { content: '{"ok": false, "reason": "the note looks like a password"}' },
    ]);
    const { cog } = setup([turn(call('c1', 'note', { text: 'hunter2' }))], {
      llm: { backends: { judge } },
      hooks: {
        promptModel: 'judge/small',
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: 'prompt', prompt: 'Is this safe? $ARGUMENTS', continueOnBlock: true },
              ],
            },
          ],
        },
      },
    });
    const result = await cog.run(agent(), { input: 'go' });
    expect(noted).not.toHaveBeenCalled();
    expect(toolTexts(result.messages)[0]).toContain('the note looks like a password');
    const asked = judge.getCalls()[0]?.messages ?? [];
    expect(String(asked.at(-1)?.content)).toContain('"tool_input":{"text":"hunter2"}');
    expect(result.output).toBe('done');
    await cog.close();
  });

  it('calls an MCP tool with the input substituted, and skips without a caller', async () => {
    const callTool = vi.fn(async () => ({
      text: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
      }),
    }));
    const hooks: HookSettings = {
      PreToolUse: [
        {
          hooks: [
            {
              type: 'mcp_tool',
              server: 'guard',
              tool: 'check',
              input: { text: '${tool_input.text}' },
            },
          ],
        },
      ],
    };
    const { cog } = setup([turn(call('c1', 'note', { text: 'a' }))], {
      hooks: { hooks, mcp: { callTool } },
    });
    await cog.run(agent(), { input: 'go' });
    expect(callTool).toHaveBeenCalledWith('guard', 'check', { text: 'a' }, expect.any(AbortSignal));
    expect(noted).not.toHaveBeenCalled();
    await cog.close();

    const runs: HookRunRecord[] = [];
    const without = setup([turn(call('c2', 'note', { text: 'b' }))], {
      hooks: { hooks, onHookRun: (run) => runs.push(run) },
    });
    await without.cog.run(agent(), { input: 'go' });
    expect(noted).toHaveBeenCalledOnce();
    expect(runs[0]?.outcome).toBe('skipped');
    await without.cog.close();
  });
});
