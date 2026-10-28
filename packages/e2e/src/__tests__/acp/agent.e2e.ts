import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  client as createClientApp,
  ndJsonStream,
  type ClientConnection,
  type RequestPermissionRequest,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { startFakeOllama, type FakeOllama } from '../../helpers/fake-ollama';
import { getOllamaUrl, getTestModel, ollamaSkipReason } from '../../helpers/setup';

const CLI = fileURLToPath(new URL('../../../../cli/dist/index.js', import.meta.url));
const SCRATCH_ROOT = fileURLToPath(new URL('../../../.tmp-acp-e2e', import.meta.url));

interface Editor {
  agent: ClientConnection['agent'];
  child: ChildProcessWithoutNullStreams;
  updates: SessionNotification[];
  permissions: RequestPermissionRequest[];
  writes: Array<{ path: string; content: string }>;
  stderr: () => string;
  exited: Promise<number | null>;
  close(): void;
}

/** `cogitator acp` launched as an editor launches it, driven by the SDK's client over stdio */
function launch(args: string[], cwd: string, env: NodeJS.ProcessEnv): Editor {
  const child = spawn(process.execPath, [CLI, 'acp', ...args], {
    cwd,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const updates: SessionNotification[] = [];
  const permissions: RequestPermissionRequest[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const app = createClientApp({ name: 'e2e-editor' })
    .onNotification('session/update', ({ params }) => {
      updates.push(params);
    })
    .onRequest('session/request_permission', ({ params }) => {
      permissions.push(params);
      return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
    })
    .onRequest('fs/read_text_file', ({ params }) => ({
      content: readFileSync(params.path, 'utf8'),
    }))
    .onRequest('fs/write_text_file', ({ params }) => {
      writes.push({ path: params.path, content: params.content });
      writeFileSync(params.path, params.content);
      return {};
    });
  const connection = app.connect(
    ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    )
  );
  return {
    agent: connection.agent,
    child,
    updates,
    permissions,
    writes,
    stderr: () => stderr,
    exited,
    close: () => {
      connection.close();
      child.stdin.end();
    },
  };
}

function text(updates: readonly SessionNotification[], sessionId: string): string {
  return updates
    .filter((n) => n.sessionId === sessionId)
    .map((n) =>
      n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text'
        ? n.update.content.text
        : ''
    )
    .join('');
}

describe('cogitator acp over stdio (fake Ollama)', () => {
  let ollama: FakeOllama;
  let workDir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    ollama = await startFakeOllama(
      (messages) => {
        const last = messages.at(-1);
        if (last?.role === 'tool') return { content: 'The file is written.' };
        const content = last?.content ?? '';
        if (content.includes('write a greeting')) {
          return {
            toolCalls: [
              {
                name: 'write_file',
                arguments: { path: 'greeting.txt', content: 'hello from acp\n' },
              },
            ],
          };
        }
        return { content: `echo: ${content}` };
      },
      ['fake-model', 'other-model']
    );
  });

  afterAll(async () => {
    await ollama.close();
    rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    workDir = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'run-')));
    env = {
      HOME: workDir,
      CLAUDE_CONFIG_DIR: join(workDir, '.claude-home'),
      OLLAMA_URL: ollama.url,
      OLLAMA_HOST: '',
      OLLAMA_API_KEY: '',
      COGITATOR_MODEL: '',
      COGITATOR_SESSIONS_DB: join(workDir, 'sessions.db'),
    };
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('initializes, prompts a session and keeps stdout to protocol lines', async () => {
    const editor = launch(['-m', 'ollama/fake-model'], workDir, env);
    const init = await editor.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'e2e', version: '1' },
    });
    expect(init.agentInfo).toMatchObject({ name: 'cogitator', title: 'Cogitator' });
    expect(init.authMethods?.map((method) => method.id)).toEqual(['cogitator']);
    await editor.agent.request('authenticate', { methodId: 'cogitator' });

    await expect(
      editor.agent.request('session/new', { cwd: SCRATCH_ROOT, mcpServers: [] })
    ).rejects.toThrow(/outside/);
    const session = await editor.agent.request('session/new', { cwd: workDir, mcpServers: [] });
    const model = session.configOptions?.find((option) => option.id === 'model');
    expect(model?.type === 'select' && model.currentValue).toBe('ollama/fake-model');
    expect(
      model?.type === 'select' && model.options.map((o) => ('value' in o ? o.value : ''))
    ).toEqual(['ollama/fake-model', 'ollama/other-model']);
    const response = await editor.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello there' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(text(editor.updates, session.sessionId)).toBe('echo: hello there');

    const listed = await editor.agent.request('session/list', { cwd: workDir });
    expect(listed.sessions).toEqual([
      expect.objectContaining({ sessionId: session.sessionId, title: 'hello there' }),
    ]);
    editor.close();
    expect(await editor.exited).toBe(0);
  });

  it('asks before an edit and writes it through the editor', async () => {
    const editor = launch(['-m', 'ollama/fake-model'], workDir, env);
    await editor.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    const { sessionId } = await editor.agent.request('session/new', {
      cwd: workDir,
      mcpServers: [],
    });
    const response = await editor.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Please write a greeting' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(editor.permissions).toHaveLength(1);
    expect(editor.permissions[0]).toMatchObject({
      toolCall: {
        kind: 'edit',
        locations: [{ path: join(workDir, 'greeting.txt') }],
        content: [
          { type: 'diff', path: join(workDir, 'greeting.txt'), newText: 'hello from acp\n' },
        ],
      },
    });
    expect(editor.writes).toEqual([
      { path: join(workDir, 'greeting.txt'), content: 'hello from acp\n' },
    ]);
    expect(text(editor.updates, sessionId)).toContain('The file is written.');
    editor.close();
    await editor.exited;
  });

  it('loads a session kept by an earlier process', async () => {
    const first = launch(['-m', 'ollama/fake-model'], workDir, env);
    await first.agent.request('initialize', { protocolVersion: 1 });
    const { sessionId } = await first.agent.request('session/new', {
      cwd: workDir,
      mcpServers: [],
    });
    await first.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'remember me' }],
    });
    first.close();
    await first.exited;

    const second = launch(['-m', 'ollama/fake-model'], workDir, env);
    await second.agent.request('initialize', { protocolVersion: 1 });
    await second.agent.request('session/load', { sessionId, cwd: workDir, mcpServers: [] });
    expect(
      second.updates
        .filter((n) => n.sessionId === sessionId)
        .map((n) => n.update)
        .filter(
          (u) =>
            u.sessionUpdate === 'user_message_chunk' || u.sessionUpdate === 'agent_message_chunk'
        )
    ).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'remember me' } },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'echo: remember me' },
      },
    ]);
    second.close();
    await second.exited;
    expect(existsSync(join(workDir, 'sessions.db'))).toBe(true);
  });

  it('starts without a model and refuses authenticate with hints', async () => {
    const editor = launch([], workDir, { ...env, OLLAMA_URL: 'http://127.0.0.1:9' });
    const init = await editor.agent.request('initialize', { protocolVersion: 1 });
    expect(init.authMethods?.length).toBeGreaterThan(0);
    await expect(
      editor.agent.request('authenticate', { methodId: 'cogitator' })
    ).rejects.toMatchObject({
      code: -32000,
    });
    editor.close();
    await editor.exited;
  });
});

describe('cogitator acp on a live Ollama model', async () => {
  const skip = await ollamaSkipReason();

  it.skipIf(skip !== null)('answers a prompt', async () => {
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    const workDir = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'live-')));
    try {
      const editor = launch(['-m', `ollama/${getTestModel()}`], workDir, {
        HOME: workDir,
        OLLAMA_URL: getOllamaUrl(),
        COGITATOR_SESSIONS_DB: join(workDir, 'sessions.db'),
      });
      await editor.agent.request('initialize', { protocolVersion: 1 });
      const { sessionId } = await editor.agent.request('session/new', {
        cwd: workDir,
        mcpServers: [],
      });
      const response = await editor.agent.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Reply with one short sentence about the sea.' }],
      });
      expect(response.stopReason).toBe('end_turn');
      expect(text(editor.updates, sessionId).trim().length).toBeGreaterThan(0);
      editor.close();
      await editor.exited;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
