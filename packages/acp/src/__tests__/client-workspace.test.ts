import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agent as createAgentApp, client as createClientApp } from '@agentclientprotocol/sdk';
import { LocalWorkspace } from '@cogitator-ai/core';
import { WorkspaceError } from '@cogitator-ai/types';
import { AcpClientWorkspace } from '../agent/client-workspace';

let dir: string;
let base: LocalWorkspace;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'acp-workspace-')));
  base = new LocalWorkspace({ root: dir });
  await base.start();
});

afterEach(async () => {
  await base.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function editor(files: Map<string, string>, hang = false) {
  const created: string[] = [];
  let killed = 0;
  const app = createClientApp({ name: 'editor' })
    .onRequest('fs/read_text_file', ({ params }) => {
      const content = files.get(params.path);
      if (content === undefined) throw new Error('missing');
      return { content };
    })
    .onRequest('fs/write_text_file', ({ params }) => {
      files.set(params.path, params.content);
      return {};
    })
    .onRequest('terminal/create', ({ params }) => {
      created.push(params.args?.at(-1) ?? params.command);
      return { terminalId: 't1' };
    })
    .onRequest('terminal/wait_for_exit', () =>
      hang ? new Promise<never>(() => undefined) : { exitCode: 3 }
    )
    .onRequest('terminal/output', () => ({ output: 'out', truncated: false }))
    .onRequest('terminal/kill', () => {
      killed++;
      return {};
    })
    .onRequest('terminal/release', () => ({}));
  const connection = createAgentApp({ name: 'agent' }).connect(app);
  return { context: connection.client, created, killed: () => killed };
}

describe('AcpClientWorkspace', () => {
  it('reads and writes through the editor inside the root', async () => {
    const files = new Map([[join(dir, 'a.txt'), 'unsaved text']]);
    writeFileSync(join(dir, 'a.txt'), 'saved text');
    const { context } = editor(files);
    const workspace = new AcpClientWorkspace({
      base,
      client: context,
      sessionId: 's',
      capabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    expect(await workspace.read('a.txt')).toBe('unsaved text');
    expect(new TextDecoder().decode(await workspace.readBytes('a.txt'))).toBe('unsaved text');
    await workspace.write('sub/b.txt', 'new');
    expect(files.get(join(dir, 'sub/b.txt'))).toBe('new');
    await expect(workspace.read('/etc/hosts')).rejects.toMatchObject({ code: 'OUTSIDE_ROOT' });
    await expect(workspace.read('missing.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0]));
    expect([...(await workspace.readBytes('bin.dat'))]).toEqual([0, 1, 2, 0]);
    expect(await workspace.withCwd('sub').read('a.txt')).toBe('unsaved text');
  });

  it('goes to the workspace on this machine for what the editor did not offer', async () => {
    writeFileSync(join(dir, 'a.txt'), 'saved text');
    const { context, created } = editor(new Map());
    const workspace = new AcpClientWorkspace({
      base,
      client: context,
      sessionId: 's',
      capabilities: {},
    });
    expect(await workspace.read('a.txt')).toBe('saved text');
    await workspace.write('c.txt', 'local');
    expect(readFileSync(join(dir, 'c.txt'), 'utf8')).toBe('local');
    const result = await workspace.exec('echo local');
    expect(result.stdout.trim()).toBe('local');
    expect(created).toEqual([]);
    expect(workspace.uses).toEqual({ read: false, write: false, terminal: false });
    expect(workspace.snapshot).toBeTypeOf('function');
  });

  it('runs commands in terminals of the editor, killing one past its timeout', async () => {
    const terminals: string[] = [];
    const quick = editor(new Map());
    const workspace = new AcpClientWorkspace({
      base,
      client: quick.context,
      sessionId: 's',
      capabilities: { terminal: true },
      onTerminal: (id) => {
        terminals.push(id);
      },
    });
    expect(await workspace.exec('npm test')).toMatchObject({
      stdout: 'out',
      exitCode: 3,
      timedOut: false,
    });
    expect(quick.created).toEqual(['npm test']);
    expect(terminals).toEqual(['t1']);

    const slow = editor(new Map(), true);
    const hanging = new AcpClientWorkspace({
      base,
      client: slow.context,
      sessionId: 's',
      capabilities: { terminal: true },
    });
    expect(await hanging.exec('sleep 100', { timeout: 30 })).toMatchObject({
      exitCode: 124,
      timedOut: true,
    });
    expect(slow.killed()).toBe(1);
    const controller = new AbortController();
    const aborted = hanging.exec('sleep 100', { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(aborted).rejects.toSatisfy((error: unknown) =>
      WorkspaceError.is(error, 'ABORTED')
    );
    await expect(hanging.exec('ls', { cwd: '../..' })).rejects.toMatchObject({
      code: 'OUTSIDE_ROOT',
    });
  });
});
