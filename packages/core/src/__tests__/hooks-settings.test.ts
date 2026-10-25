import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ModelTurnEvent,
  RunMiddleware,
  RunMiddlewareContext,
  Tool,
  ToolCall,
} from '@cogitator-ai/types';
import { compileMatcher } from '../hooks/middleware';
import { loadHookSettings, readHookSettings, trustsProject } from '../hooks/settings';
import { readStdout } from '../hooks/output';
import { MiddlewarePipeline, middlewareStop } from '../middleware/pipeline';
import { compactionMiddleware } from '../middleware/builtins';
import type { ContextManager } from '../context/index';

let base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'hook-settings-')));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const command = (text: string) => ({ type: 'command' as const, command: text });

describe('readHookSettings', () => {
  it('reads valid handlers and warns about the rest', () => {
    const warnings: string[] = [];
    const hooks = readHookSettings(
      {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [command('a'), { type: 'agent', prompt: 'x' }, { type: 'command' }],
          },
        ],
        FileChanged: [{ hooks: [command('b')] }],
        Nope: [],
        Stop: 'not a list',
      },
      'project',
      'settings.json',
      warnings
    );
    expect(hooks).toEqual([
      {
        event: 'PreToolUse',
        handler: { type: 'command', command: 'a' },
        source: 'settings.json',
        layer: 'project',
        matcher: 'Bash',
      },
    ]);
    expect(warnings).toEqual([
      expect.stringContaining('is an agent hook'),
      expect.stringContaining('is not a valid hook handler'),
      expect.stringContaining('Cogitator has no FileChanged event'),
      expect.stringContaining('Nope is not a hook event'),
      expect.stringContaining('hooks.Stop is not a list'),
    ]);
    const more: string[] = [];
    readHookSettings(
      { Stop: [{ hooks: [{ type: 'command', command: 'x', once: true, asyncRewake: true }] }] },
      'user',
      'u.json',
      more
    );
    expect(more).toEqual([
      expect.stringContaining('sets asyncRewake'),
      expect.stringContaining('sets once'),
    ]);
  });
});

describe('loadHookSettings', () => {
  const write = (path: string, value: unknown) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  };
  const project = () => join(base, 'project');
  const places = () => ({
    userDirs: [join(base, 'user')],
    managedDirs: [join(base, 'managed')],
  });

  it('merges the layers, code first, each handler once', async () => {
    const same = { hooks: { Stop: [{ hooks: [command('same')] }] } };
    write(join(base, 'user', 'settings.json'), same);
    write(join(project(), '.claude', 'settings.json'), {
      hooks: { Stop: [{ hooks: [command('same'), command('project')] }] },
    });
    const loaded = await loadHookSettings(
      project(),
      { ...places(), root: project(), trusted: true },
      { hooks: { Stop: [{ hooks: [command('code')] }] } }
    );
    expect(loaded.hooks.map((hook) => [hook.layer, hook.handler])).toEqual([
      ['session', { type: 'command', command: 'code' }],
      ['project', { type: 'command', command: 'same' }],
      ['project', { type: 'command', command: 'project' }],
    ]);
  });

  it('leaves out an untrusted project, with a warning', async () => {
    write(join(project(), '.cogitator', 'settings.local.json'), {
      hooks: { Stop: [{ hooks: [command('local')] }] },
    });
    const loaded = await loadHookSettings(project(), places(), undefined);
    expect(loaded.hooks).toEqual([]);
    expect(loaded.warnings).toEqual([expect.stringContaining('is not trusted')]);
  });

  it('trusts the configured root only, or the trustedRoots', async () => {
    write(join(project(), '.claude', 'settings.json'), {
      hooks: { Stop: [{ hooks: [command('project')] }] },
    });
    const other = join(base, 'other');
    expect(trustsProject({ root: project(), trusted: true }, project())).toBe(true);
    expect(trustsProject({ root: other, trusted: true }, project())).toBe(false);
    expect(trustsProject({ trustedRoots: [other, project()] }, project())).toBe(true);
    expect(trustsProject({ trusted: true }, project())).toBe(false);
    const elsewhere = await loadHookSettings(
      project(),
      { ...places(), root: other, trusted: true },
      undefined
    );
    expect(elsewhere.hooks).toEqual([]);
    const listed = await loadHookSettings(
      project(),
      { ...places(), trustedRoots: [project()] },
      undefined
    );
    expect(listed.hooks.map((hook) => hook.handler)).toEqual([command('project')]);
  });

  it('keeps managed hooks only under allowManagedHooksOnly, and their own disableAllHooks', async () => {
    write(join(base, 'managed', 'managed-settings.json'), {
      allowManagedHooksOnly: true,
      hooks: { Stop: [{ hooks: [command('managed')] }] },
    });
    write(join(base, 'user', 'settings.json'), {
      disableAllHooks: true,
      hooks: { Stop: [{ hooks: [command('user')] }] },
    });
    const only = await loadHookSettings(project(), places(), undefined);
    expect(only.hooks.map((hook) => hook.handler)).toEqual([command('managed')]);

    write(join(base, 'managed', 'managed-settings.d', '10-off.json'), { disableAllHooks: true });
    const off = await loadHookSettings(project(), places(), undefined);
    expect(off.hooks).toEqual([]);
  });

  it('collects the HTTP allowlists, the managed one as a ceiling the others only narrow', async () => {
    write(join(base, 'user', 'settings.json'), {
      allowedHttpHookUrls: ['https://a.example/*'],
      httpHookAllowedEnvVars: ['TOKEN'],
    });
    const loaded = await loadHookSettings(project(), places(), {
      allowedHttpHookUrls: ['https://b.example/*'],
    });
    expect(loaded.allowedHttpHookUrls).toEqual([['https://a.example/*', 'https://b.example/*']]);
    expect(loaded.httpHookAllowedEnvVars).toEqual([['TOKEN']]);

    write(join(base, 'managed', 'managed-settings.json'), {
      allowedHttpHookUrls: ['https://a.example/hooks/*'],
      httpHookAllowedEnvVars: ['TOKEN', 'OTHER'],
    });
    const capped = await loadHookSettings(project(), places(), undefined);
    expect(capped.allowedHttpHookUrls).toEqual([
      ['https://a.example/hooks/*'],
      ['https://a.example/*'],
    ]);
    expect(capped.httpHookAllowedEnvVars).toEqual([['TOKEN', 'OTHER'], ['TOKEN']]);

    const none = await loadHookSettings(
      join(base, 'other'),
      { managedDirs: [], userDirs: [] },
      undefined
    );
    expect(none.allowedHttpHookUrls).toBeUndefined();
  });
});

describe('readStdout', () => {
  it.each([
    ['', { kind: 'text', text: '' }],
    ['plain words', { kind: 'text', text: 'plain words' }],
    ['[1, 2]', { kind: 'text', text: '[1, 2]' }],
    ['  {"continue": false}  ', { kind: 'json', output: { continue: false } }],
    ['{"a": 1}\n{"b": 2}', { kind: 'text', text: '{"a": 1}\n{"b": 2}' }],
  ])('reads %j', (stdout, expected) => {
    expect(readStdout(stdout)).toEqual(expected);
  });

  it.each([
    ['{not json}', 'not valid JSON'],
    ['{"decision": "maybe"}', 'does not match the hook output schema'],
    ['{"continue": true}\n{"decision": "block"}', 'several JSON values'],
  ])('fails on %j', (stdout, error) => {
    const read = readStdout(stdout);
    expect(read.kind).toBe('invalid');
    expect(read.kind === 'invalid' && read.error).toContain(error);
  });
});

describe('compileMatcher', () => {
  it.each([
    [undefined, ['anything'], true],
    ['*', ['x'], true],
    ['', ['x'], true],
    ['Bash', ['Bash'], true],
    ['Bash', ['BashOutput'], false],
    ['Edit|Write', ['Write'], true],
    ['Edit, Write', ['Edit'], true],
    ['mcp__memory', ['mcp__memory__create'], false],
    ['mcp__memory__.*', ['mcp__memory__create'], true],
    ['^Notebook', ['NotebookEdit'], true],
    ['Edit.*', ['NotebookEdit'], true],
    ['[unclosed', ['[unclosed'], false],
  ])('%j against %j is %s', (matcher, values, expected) => {
    expect(compileMatcher(matcher)(values)).toBe(expected);
  });
});

const context = (extra: Partial<RunMiddlewareContext> = {}): RunMiddlewareContext => ({
  runId: 'run',
  agentId: 'a',
  agentName: 'a',
  iteration: 1,
  signal: new AbortController().signal,
  state: new Map(),
  ...extra,
});

describe('the pipeline of the new events', () => {
  const tool = { name: 't' } as Tool;
  const toolCall: ToolCall = { id: 'c', name: 't', arguments: { n: 1 } };

  it('merges beforeToolCall verdicts: deny over defer over ask over allow, the last arguments', async () => {
    const seenArgs: unknown[] = [];
    const layers: RunMiddleware[] = [
      {
        name: 'one',
        beforeToolCall: ({ toolCall: call }) => {
          seenArgs.push(call.arguments);
          return { decision: 'allow', updatedArguments: { n: 2 } };
        },
      },
      {
        name: 'two',
        beforeToolCall: ({ toolCall: call }) => {
          seenArgs.push(call.arguments);
          return { decision: 'ask', reason: 'check' };
        },
      },
      { name: 'three', beforeToolCall: () => ({ decision: 'allow', updatedArguments: { n: 3 } }) },
    ];
    const verdict = await new MiddlewarePipeline(layers).beforeToolCall(
      { toolCall, tool, resumed: false },
      context()
    );
    expect(verdict).toEqual({ decision: 'ask', reason: 'check', updatedArguments: { n: 3 } });
    expect(seenArgs).toEqual([{ n: 1 }, { n: 2 }]);
    const denied = await new MiddlewarePipeline([
      ...layers,
      { name: 'four', beforeToolCall: () => ({ decision: 'deny' }) },
    ]).beforeToolCall({ toolCall, tool, resumed: false }, context());
    expect(denied?.decision).toBe('deny');
    expect(denied?.reason).toBeUndefined();
  });

  it('names the middleware that stops the run', async () => {
    const stops: string[] = [];
    const stop = middlewareStop((reason, middleware) => stops.push(`${middleware}: ${reason}`));
    await new MiddlewarePipeline([
      { name: 'quiet', afterToolBatch: () => undefined },
      { name: 'guard', afterToolBatch: (_event, ctx) => ctx.stop?.('enough') },
    ]).afterToolBatch({ calls: [] }, context({ stop }));
    expect(stops).toEqual(['guard: enough']);
  });

  it('takes the first decideApproval answer and joins beforeStop messages', async () => {
    const pipeline = new MiddlewarePipeline([
      { name: 'none', decideApproval: () => undefined },
      { name: 'yes', decideApproval: () => ({ approved: true }) },
      { name: 'no', decideApproval: () => ({ approved: false }) },
      { name: 'a', beforeStop: () => ({ continueWith: 'first' }) },
      { name: 'b', beforeStop: () => ({ continueWith: 'second' }) },
    ]);
    const request = {
      toolCallId: 'c',
      toolName: 't',
      arguments: {},
      description: 'T',
    };
    expect(await pipeline.decideApproval({ request, tool }, context())).toEqual({ approved: true });
    expect(
      await pipeline.beforeStop({ output: 'x', continuations: 0, continued: false }, context())
    ).toEqual(['first', 'second']);
  });

  it('lets beforeCompaction keep a turn from being compacted', async () => {
    const compress = vi.fn();
    const manager = {
      shouldCompress: () => true,
      compress,
    } as unknown as ContextManager;
    const asked: string[] = [];
    const layer = compactionMiddleware(manager, {
      before: async (_context, event) => {
        asked.push(event.scope);
        return { skip: true, reason: 'not now' };
      },
      after: async () => undefined,
    });
    const event: ModelTurnEvent = { messages: [{ role: 'user', content: 'x' }], model: 'p/m' };
    expect(await layer.beforeModel?.(event, context())).toBeUndefined();
    expect(asked).toEqual(['turn']);
    expect(compress).not.toHaveBeenCalled();
  });
});
