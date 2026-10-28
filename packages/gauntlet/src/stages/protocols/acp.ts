import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { ACP_AGENT_SESSION_KEY, AcpAgentProvider } from '@cogitator-ai/acp';
import { SessionHost } from '@cogitator-ai/app-server';
import {
  APP_SERVER_PROTOCOL_VERSION,
  type ApprovalRequestParams,
} from '@cogitator-ai/app-server/client';
import { LocalWorkspace } from '@cogitator-ai/core';
import type {
  WorkspaceExecOptions,
  WorkspaceExecResult,
  WorkspaceReadOptions,
} from '@cogitator-ai/types';
import type { StageContext, StageDefinition } from '../../runner/types.js';
import { SCRIBE_AGENT } from './session-fixtures.js';
import {
  ACP,
  APP_SERVER,
  MEMORY,
  TSX_LOADER,
  TurnLog,
  connectInProcess,
  fixtureEnv,
  protocolFixture,
  textInput,
  type ToolCallSeen,
  type WiredClient,
} from './sessions.js';
import { CORE, excerpt } from './shared.js';

const FIXTURE = protocolFixture('acp-agent.ts');

/** The commands the permission rules decide, so no person is asked about them. */
const ALLOWED_COMMAND = 'pwd';
const REFUSED_FILE = 'refused.txt';

/**
 * The workspace the provider serves the agent's files and terminals from, recording what it
 * read and ran, so a check can tell a read through the ACP client from one of the disk.
 */
class RecordingWorkspace extends LocalWorkspace {
  readonly reads: Array<{ path: string; ok: boolean }> = [];
  readonly commands: string[] = [];

  override async read(path: string, options: WorkspaceReadOptions = {}): Promise<string> {
    const absolute = resolve(this.root, path);
    try {
      const text = await super.read(path, options);
      this.reads.push({ path: absolute, ok: true });
      return text;
    } catch (error) {
      this.reads.push({ path: absolute, ok: false });
      throw error;
    }
  }

  override exec(command: string, options: WorkspaceExecOptions = {}): Promise<WorkspaceExecResult> {
    this.commands.push(command);
    return super.exec(command, options);
  }
}

/** One launch of the ACP agent: the provider, the host it serves and a client of that host. */
interface Launch {
  provider: AcpAgentProvider;
  host: SessionHost;
  wired: WiredClient;
  turns: TurnLog;
  /** Every `approval/request` the client was asked, refused. */
  asked: ApprovalRequestParams[];
  close(): Promise<void>;
}

function launch(
  ctx: StageContext,
  workspace: RecordingWorkspace,
  databases: { host: string; agent: string },
  secret: string,
  stderr: string[]
): Launch {
  const provider = new AcpAgentProvider({
    agent: {
      command: process.execPath,
      args: ['--import', TSX_LOADER, FIXTURE],
      env: fixtureEnv(ctx, databases.agent, secret),
    },
    workspace,
    name: SCRIBE_AGENT,
    description: 'A Cogitator agent served over ACP by a child process',
    model: ctx.model,
    permissions: { rules: { allow: [`Bash(${ALLOWED_COMMAND})`], deny: ['Bash(touch *)'] } },
    onStderr: (chunk) => stderr.push(chunk),
    onError: (error) => stderr.push(`provider: ${error.message}`),
  });
  const cogitator = ctx.createCogitator({
    memory: { adapter: 'sqlite', sqlite: { path: databases.host } },
  });
  const host = new SessionHost({
    cogitator,
    agents: {},
    providers: { [SCRIBE_AGENT]: provider },
    exposeErrors: true,
  });
  const wired = connectInProcess(ctx, host);
  const turns = new TurnLog(wired.client, ctx);
  const asked: ApprovalRequestParams[] = [];
  wired.client.onRequest('approval/request', (params) => {
    asked.push(params);
    return { outcome: { outcome: 'selected', optionId: 'reject_once' } };
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    wired.client.close();
    await provider.close();
    await host.close();
    await cogitator.close();
  };
  ctx.onCleanup(close);
  return { provider, host, wired, turns, asked, close };
}

async function initialize(run: Launch) {
  return run.wired.client.initialize({
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    clientInfo: { name: 'gauntlet', version: '1.0.0' },
    capabilities: { approvals: 'request' },
  });
}

/** Runs one prompt on the thread and returns its completed turn and the tool calls it showed. */
async function prompt(run: Launch, threadId: string, text: string) {
  const { turn } = await run.wired.client.turnStart({ threadId, input: textInput(text) });
  const done = await run.turns.completed(turn.id, 150_000);
  if (done.status !== 'completed') {
    throw new Error(`The turn ended ${done.status}: ${done.error?.message ?? done.output ?? ''}`);
  }
  return { done, calls: run.turns.toolCalls(turn.id), events: run.turns.events(turn.id) };
}

/** Whether a call ended refused: failed, or answered with the refusal as its result. */
function refused(call: ToolCallSeen): boolean {
  return (
    call.failed ||
    /denied|refused|rejected|not allowed|outside/i.test(JSON.stringify(call.result ?? null))
  );
}

function describeCalls(calls: readonly ToolCallSeen[]) {
  return calls.map((call) => ({
    name: call.name,
    args: excerpt(call.args, 120),
    refused: refused(call),
    result: excerpt(JSON.stringify(call.result ?? null), 160),
  }));
}

/**
 * An ACP agent made with `createAcpAgent` and served on stdio by a child process, run back as
 * an external agent of a `SessionHost` through `AcpAgentProvider` and driven through the
 * app-server: its stream, its permission requests, the files and terminals the client serves,
 * and its session loaded again after both sides restarted.
 */
export const acpStage: StageDefinition = {
  id: 'acp',
  title: 'ACP both ways',
  description:
    'A Cogitator agent served over ACP on stdio runs as an external agent of another SessionHost: its stream maps to turn events, the permission rules decide its commands, its files and terminals stay inside the workspace, and its session loads again after a restart.',
  packages: [ACP, APP_SERVER, CORE, MEMORY],
  needs: ['handshake'],
  requires: [{ kind: 'env', name: 'OPENROUTER_API_KEY', why: 'the ACP agent calls OpenRouter' }],
  timeoutMs: 420_000,
  async run(ctx) {
    const secret = randomUUID().replace(/-/g, '');
    const codeword = `QUILL-${secret.slice(0, 6).toUpperCase()}`;
    const outsideWord = `HARBOUR-${secret.slice(6, 12).toUpperCase()}`;
    const root = join(ctx.tmpDir, 'acp-project');
    await mkdir(root, { recursive: true });
    const realRoot = realpathSync(root);
    await writeFile(join(realRoot, 'notes.txt'), `Codeword: ${codeword}\n`);
    await writeFile(join(ctx.tmpDir, 'outside.txt'), `Outside codeword: ${outsideWord}\n`);
    const workspace = new RecordingWorkspace({ root: realRoot });
    await workspace.start();
    ctx.onCleanup(() => workspace.dispose());
    const databases = {
      host: join(ctx.tmpDir, 'host-sessions.db'),
      agent: join(ctx.tmpDir, 'agent-sessions.db'),
    };
    const stderr: string[] = [];
    const inside = (path: string) => !relative(realRoot, path).startsWith('..');

    const first = launch(ctx, workspace, databases, secret, stderr);

    await ctx.check('the ACP agent is listed as an external agent', async (evidence) => {
      const result = await initialize(first);
      evidence('agents', result.agents);
      const scribe = result.agents.find((agent) => agent.name === SCRIBE_AGENT);
      if (!scribe?.external) throw new Error(`${SCRIBE_AGENT} is not listed as external`);
    });

    const thread = await ctx.check(
      'a prompt streams the reply and a read served by the client workspace',
      async (evidence) => {
        const { thread } = await first.wired.client.threadStart({ agent: SCRIBE_AGENT });
        const { done, calls, events } = await prompt(
          first,
          thread.id,
          'Read the file notes.txt with read_file and tell me the codeword written in it.'
        );
        const types = [...new Set(events.map((event) => event.type))];
        evidence('eventTypes', types);
        evidence('toolCalls', describeCalls(calls));
        evidence('workspaceReads', workspace.reads);
        evidence('output', excerpt(done.output ?? ''));
        evidence('stderr', excerpt(stderr.join(''), 400));
        if (!types.includes('text-delta')) throw new Error('No text streamed from the ACP agent');
        if (!calls.some((call) => JSON.stringify(call.result ?? null).includes(codeword))) {
          throw new Error('No tool result of the ACP agent carries the codeword of notes.txt');
        }
        if (!workspace.reads.some((read) => read.ok && read.path.endsWith('notes.txt'))) {
          throw new Error(
            'notes.txt was not read through the client workspace (fs/read_text_file)'
          );
        }
        if (!(done.output ?? '').includes(codeword)) {
          throw new Error('The answer lacks the codeword of notes.txt');
        }
        return thread;
      }
    );

    await ctx.check(
      'the permission rules allow one command and refuse another',
      async (evidence) => {
        const { done, calls } = await prompt(
          first,
          thread.id,
          `Use run_command twice: first run the command \`${ALLOWED_COMMAND}\`, then run the command \`touch ${REFUSED_FILE}\`. Tell me what each one returned.`
        );
        const allowed = calls.find((call) => call.args.includes(ALLOWED_COMMAND) && !call.failed);
        const touch = calls.find((call) => call.args.includes('touch'));
        evidence('toolCalls', describeCalls(calls));
        evidence('terminalCommands', workspace.commands);
        evidence(
          'clientAsked',
          first.asked.map((ask) => ask.toolCall.toolName)
        );
        evidence('output', excerpt(done.output ?? ''));
        if (!workspace.commands.some((command) => command.includes(ALLOWED_COMMAND))) {
          throw new Error(`${ALLOWED_COMMAND} did not run in a terminal of the client workspace`);
        }
        if (!allowed || !JSON.stringify(allowed.result ?? null).includes('acp-project')) {
          throw new Error(`The ${ALLOWED_COMMAND} call has no result naming the workspace`);
        }
        if (!touch) throw new Error('The agent never asked to run touch');
        if (!refused(touch)) throw new Error('The touch call was not refused');
        if (workspace.commands.some((command) => command.includes('touch'))) {
          throw new Error('touch reached a terminal although a deny rule refuses it');
        }
        if (existsSync(join(realRoot, REFUSED_FILE))) {
          throw new Error(`${REFUSED_FILE} exists, the refused command ran`);
        }
      }
    );

    await ctx.check('a read outside the workspace root is refused', async (evidence) => {
      const before = workspace.reads.length;
      const { done, calls } = await prompt(
        first,
        thread.id,
        'Read the file ../outside.txt with read_file and tell me what it says.'
      );
      const reads = workspace.reads.slice(before);
      evidence('toolCalls', describeCalls(calls));
      evidence('workspaceReads', reads);
      evidence('output', excerpt(done.output ?? ''));
      if (calls.length === 0) throw new Error('The agent never tried to read ../outside.txt');
      if (reads.some((read) => read.ok && !inside(read.path))) {
        throw new Error('The client workspace read a file outside its root');
      }
      if (calls.some((call) => JSON.stringify(call.result ?? null).includes(outsideWord))) {
        throw new Error('A tool result carries the text of the file outside the root');
      }
      if ((done.output ?? '').includes(outsideWord)) {
        throw new Error('The answer carries the text of the file outside the root');
      }
      if (!calls.some(refused)) throw new Error('No read of the agent was refused');
    });

    await ctx.check('session/load after a restart brings the thread back', async (evidence) => {
      const before = await first.wired.client.threadResume({ threadId: thread.id });
      const sessionId = before.thread.metadata[ACP_AGENT_SESSION_KEY];
      await first.close();
      await writeFile(join(realRoot, 'notes.txt'), 'This note was cleared.\n');

      const second = launch(ctx, workspace, databases, secret, stderr);
      await initialize(second);
      const resumed = await second.wired.client.threadResume({ threadId: thread.id });
      evidence('agentSessionId', sessionId);
      evidence(
        'roles',
        resumed.messages.map((message) => message.role)
      );
      if (typeof sessionId !== 'string') throw new Error('The thread keeps no ACP session id');
      if (!resumed.messages.some((m) => m.role === 'assistant' && m.text.includes(codeword))) {
        throw new Error('The restarted host lost the answer with the codeword');
      }
      const { done, calls } = await prompt(
        second,
        thread.id,
        'Without using any tool: which codeword did you read from notes.txt earlier in this conversation?'
      );
      const after = await second.wired.client.threadResume({ threadId: thread.id });
      evidence('toolCalls', describeCalls(calls));
      evidence('output', excerpt(done.output ?? ''));
      evidence('sessionAfter', after.thread.metadata[ACP_AGENT_SESSION_KEY]);
      if (after.thread.metadata[ACP_AGENT_SESSION_KEY] !== sessionId) {
        throw new Error('The provider opened a new ACP session instead of loading the old one');
      }
      if (!(done.output ?? '').includes(codeword)) {
        throw new Error(
          'The restarted agent does not remember the codeword: its session did not load'
        );
      }
    });
  },
};
