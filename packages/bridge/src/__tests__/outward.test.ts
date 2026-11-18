import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { A2AServer } from '@cogitator-ai/a2a';
import { agentTools } from '@cogitator-ai/mcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeClient } from '../client';
import { hostBridge, type BridgeHost } from '../host';
import { AGENT_QUESTION_REASON, bridgeAgents, type BridgeAgents } from '../outward';
import { bridgePaths, canonicalPath } from '../paths';
import type { RenderedLetter, Rights } from '../types';
import { FakeAdapter } from './bridge-kit';
import { socketDir, tempDir } from './helpers';

let home: string;
let removeHome: () => void;
let project: string;
let removeProject: () => void;
let host: BridgeHost | undefined;
let adapter: FakeAdapter;
const doors: BridgeAgents[] = [];
const errors: Error[] = [];
const clients: BridgeClient[] = [];

function fakeHarness(harness: string): FakeAdapter {
  let started = 0;
  return new FakeAdapter({
    harness,
    createSession: async () => ({ sessionId: `${harness}-thread-${(started += 1)}` }),
  });
}

async function door(agents?: Parameters<typeof bridgeAgents>[0]['agents']): Promise<BridgeAgents> {
  const opened = await bridgeAgents({
    socketPath: bridgePaths({ home }).socket,
    project,
    ...(agents && { agents }),
  });
  doors.push(opened);
  return opened;
}

async function start(
  options: {
    rights?: Rights;
    agents?: Parameters<typeof bridgeAgents>[0]['agents'];
    adapters?: FakeAdapter[];
  } = {}
): Promise<BridgeAgents> {
  host = await hostBridge({
    home,
    tickMs: 25,
    adapters: options.adapters ?? [adapter],
    onError: (error) => errors.push(error),
    ...(options.rights && { rights: async () => options.rights ?? 'ask' }),
  });
  return door(options.agents);
}

/** The session the bridge started for a job, as a client that speaks for it. */
async function worker(job: number, of: FakeAdapter = adapter): Promise<BridgeClient> {
  const session = await vi.waitFor(() => {
    const found = of.sessions.find((request) => request.job.number === job);
    if (!found) throw new Error(`No ${of.harness} session was started for job #${job} yet`);
    return found;
  });
  const client = await BridgeClient.connect({
    socketPath: bridgePaths({ home }).socket,
    caller: {
      harness: of.harness,
      sessionId: `${of.harness}-thread-${of.sessions.indexOf(session) + 1}`,
      cwd: project,
      project,
      agentName: session.agentName,
    },
  });
  clients.push(client);
  return client;
}

/** The first letter of a kind in the inbox of a session, once it is there. */
function mail(client: BridgeClient, kind: RenderedLetter['kind']): Promise<RenderedLetter> {
  return vi.waitFor(async () => {
    const found = (await client.inbox()).find((letter) => letter.kind === kind);
    if (!found) throw new Error(`No ${kind} yet`);
    return found;
  });
}

const toolContext = { signal: new AbortController().signal } as never;

beforeEach(() => {
  ({ dir: home, remove: removeHome } = socketDir());
  const made = tempDir('cogitator-bridge-outward-');
  project = canonicalPath(made.dir);
  removeProject = made.remove;
  mkdirSync(join(project, '.git'));
  errors.length = 0;
  adapter = fakeHarness('codex');
});

afterEach(async () => {
  await Promise.all(doors.splice(0).map((opened) => opened.close()));
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await host?.close();
  host = undefined;
  removeHome();
  removeProject();
  expect(errors).toEqual([]);
});

describe('the agents of a bridge, offered to the outside', () => {
  it('offers every harness the bridge can start, and hands a run over as a job', async () => {
    const { agents, runtime } = await start();
    expect(Object.keys(agents)).toEqual(['codex']);
    expect(agents.codex.config.description).toContain('Hands a job to codex');

    const running = runtime.run(agents.codex, { input: 'Review the parser' });
    const codex = await worker(1);
    const job = await codex.job(1);
    expect(job).toMatchObject({ from: expect.stringMatching(/^outside@/), cwd: project });
    expect(adapter.sessions[0].firstLetter.text).toContain('Review the parser');
    await codex.send({ job: 1, kind: 'report', body: 'Two problems found' });

    const result = await running;
    expect(result).toMatchObject({
      output: 'Two problems found',
      runId: 'bridge-job-1',
      agentId: agents.codex.id,
      toolCalls: [],
    });
    expect(result.status).toBeUndefined();
    expect(result.threadId).toEqual(expect.any(String));
  });

  it('pauses a run on the question of the agent, and goes on with the answer', async () => {
    const { agents, runtime } = await start();
    const first = await (async () => {
      const running = runtime.run(agents.codex, { input: 'Ship the fix', threadId: 'thread-a' });
      const codex = await worker(1);
      await codex.inbox();
      await codex.send({ job: 1, kind: 'question', body: 'To staging or to production?' });
      return running;
    })();
    const codex = await worker(1);

    expect(first).toMatchObject({ status: 'paused', output: '', threadId: 'thread-a' });
    expect(first.interrupts).toEqual([
      {
        id: expect.any(String),
        kind: 'input',
        reason: AGENT_QUESTION_REASON,
        message: 'To staging or to production?',
      },
    ]);
    const question = first.interrupts?.[0].id ?? '';
    expect(await runtime.pausedRun('thread-a')).toEqual({ runId: 'bridge-job-1' });
    expect(await runtime.pausedRun('thread-b')).toBeUndefined();

    await expect(runtime.resume(agents.codex, 'thread-b')).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'No job waits for an answer on this thread',
    });
    await expect(
      runtime.resume(agents.codex, 'thread-a', { responses: { other: 'Staging' } })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      runtime.resume(agents.codex, 'thread-a', {
        responses: { [question]: 'Staging' },
        userId: 'somebody-else',
      })
    ).rejects.toMatchObject({ message: 'No job waits for an answer on this thread' });

    const second = runtime.resume(agents.codex, 'thread-a', {
      responses: { [question]: 'Staging' },
    });
    expect((await mail(codex, 'answer')).body).toBe('Staging');
    await codex.send({ job: 1, kind: 'report', body: 'Shipped to staging' });
    expect(await second).toMatchObject({ output: 'Shipped to staging', runId: 'bridge-job-1' });
    expect(await runtime.pausedRun('thread-a')).toBeUndefined();
    expect(adapter.sessions).toHaveLength(1);
  });

  it('keeps what a job ended with while its thread waited with a question, and lets one question wait at a time', async () => {
    const { agents, runtime } = await start();
    const first = runtime.run(agents.codex, { input: 'Ship the fix', threadId: 'thread-a' });
    const codex = await worker(1);
    await codex.inbox();
    await codex.send({ job: 1, kind: 'question', body: 'To staging or to production?' });
    const question = (await first).interrupts?.[0].id ?? '';

    await codex.send({ job: 1, kind: 'question', body: 'And with the migration?' });
    expect((await mail(codex, 'answer')).body).toContain('One question at a time');

    await codex.send({ job: 1, kind: 'report', body: 'Shipped to staging, as the ticket says' });
    await vi.waitFor(async () => expect((await codex.job(1)).state).toBe('completed'));
    expect(
      await runtime.resume(agents.codex, 'thread-a', { responses: { [question]: 'Staging' } })
    ).toMatchObject({ output: 'Shipped to staging, as the ticket says', runId: 'bridge-job-1' });

    const next = runtime.run(agents.codex, { input: 'Now the docs', threadId: 'thread-a' });
    await vi.waitFor(async () => expect((await codex.job(2)).state).toBe('working'));
    await codex.send({ job: 2, kind: 'report', body: 'Docs are in' });
    expect((await next).runId).toBe('bridge-job-2');
  });

  it('takes a job back when its caller moves on or withdraws instead of answering', async () => {
    const { agents, runtime } = await start();
    const first = runtime.run(agents.codex, { input: 'Ship the fix', threadId: 'thread-a' });
    const codex = await worker(1);
    await codex.inbox();
    await codex.send({ job: 1, kind: 'question', body: 'To staging or to production?' });
    await first;

    const second = runtime.run(agents.codex, {
      input: 'Never mind, fix the typo',
      threadId: 'thread-a',
    });
    await vi.waitFor(async () =>
      expect(await codex.job(1)).toMatchObject({
        state: 'canceled',
        reason: expect.stringContaining('the caller moved on to another job on this thread'),
      })
    );
    await vi.waitFor(async () => expect((await codex.job(2)).state).toBe('working'));
    await codex.inbox();
    await codex.send({ job: 2, kind: 'question', body: 'Which typo?' });
    expect((await second).status).toBe('paused');

    expect(await runtime.cancelPause('thread-a', { reason: 'the question expired' })).toBe(true);
    await vi.waitFor(async () =>
      expect(await codex.job(2)).toMatchObject({
        state: 'canceled',
        reason: expect.stringContaining('the question expired'),
      })
    );
    expect(await runtime.cancelPause('thread-a')).toBe(false);
    expect(await runtime.pausedRun('thread-a')).toBeUndefined();
  });

  it('hands the answer to the agent that took the job over when the one that asked ran into its limit', async () => {
    const claude = fakeHarness('claude');
    const { agents, runtime } = await start({ adapters: [adapter, claude], agents: ['codex'] });
    const first = runtime.run(agents.codex, { input: 'Ship the fix', threadId: 'thread-a' });
    const codex = await worker(1);
    await codex.inbox();
    await codex.send({ job: 1, kind: 'question', body: 'To staging or to production?' });
    const question = (await first).interrupts?.[0].id ?? '';

    await host?.dispatcher.limited((await codex.job(1)).to, {
      until: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const successor = await worker(1, claude);
    const second = runtime.resume(agents.codex, 'thread-a', {
      responses: { [question]: 'Staging' },
    });
    expect((await mail(successor, 'note')).body).toBe(
      'The answer to what the agent before you asked on this job: Staging'
    );
    await successor.send({ job: 1, kind: 'report', body: 'Shipped to staging' });
    expect((await second).output).toBe('Shipped to staging');
  });

  it('rejects a run whose agent could not do the job, and takes a job back when its caller gives up', async () => {
    const { agents, runtime } = await start();
    const failing = runtime.run(agents.codex, { input: 'Do the impossible' });
    const codex = await worker(1);
    await codex.send({ job: 1, kind: 'report', body: 'No way', outcome: 'failed' });
    await expect(failing).rejects.toThrow('codex could not do the job: No way');

    const stop = new AbortController();
    const given = runtime.run(agents.codex, { input: 'Take your time', signal: stop.signal });
    await vi.waitFor(async () => expect((await codex.job(2)).state).toBe('working'));
    stop.abort();
    await expect(given).rejects.toThrow('Job #2 was taken back: the caller gave up on it');
    await vi.waitFor(async () => expect((await codex.job(2)).state).toBe('canceled'));

    const slow = runtime.run(agents.codex, { input: 'Too slow', timeout: 30 });
    await expect(slow).rejects.toThrow(/Job #3 was taken back: it took longer than 30 ms/);
    await expect(runtime.run({ name: 'nobody' }, { input: 'Hello' })).rejects.toMatchObject({
      code: 'unknown_agent',
    });
  });

  it('allows a call the rules of the project allow', async () => {
    const allowed = await start({ rights: 'allow' });
    const running = allowed.runtime.run(allowed.agents.codex, { input: 'Run the tests' });
    const codex = await worker(1);
    const asked = await codex.send({
      job: 1,
      kind: 'permission',
      body: 'Run npm test',
      ask: { tool: 'Bash', access: 'command', command: 'npm test', cwd: project },
    });
    const verdict = await codex.verdict({ letter: asked.letter.id, timeoutMs: 5000 });
    expect(verdict).toMatchObject({ state: 'decided', verdict: 'allow' });
    await codex.send({ job: 1, kind: 'report', body: 'Green' });
    expect((await running).output).toBe('Green');
  });

  it('refuses in words a request for leave nobody is there to give, and rejects a run whose job the bridge failed', async () => {
    const { agents, runtime } = await start();
    const running = runtime.run(agents.codex, { input: 'Push the branch' });
    const codex = await worker(1);
    await codex.inbox();
    await codex.send({ job: 1, kind: 'permission', body: 'May I push to main?' });
    expect((await mail(codex, 'answer')).body).toBe(
      'Nobody is there to allow this: the job came from outside this machine'
    );
    await codex.send({ job: 1, kind: 'report', body: 'Left the branch as it is' });
    expect((await running).output).toBe('Left the branch as it is');

    await Promise.all(doors.splice(0).map((opened) => opened.close()));
    await host?.close();
    const broken = new FakeAdapter({
      harness: 'qwen',
      createSession: async () => {
        throw new Error('qwen: command not found');
      },
    });
    const second = await start({ adapters: [broken] });
    await expect(second.runtime.run(second.agents.qwen, { input: 'Anything' })).rejects.toThrow(
      /Job #2 failed: the bridge could not start a qwen session/
    );
  });

  it('keeps the mail of two doors to the same project apart', async () => {
    const one = await start({ agents: ['codex:new'] });
    const two = await door(['codex:new']);
    const first = one.runtime.run(one.agents.codex, { input: 'The first job' });
    const second = two.runtime.run(two.agents.codex, { input: 'The second job' });
    const firstWorker = await worker(1);
    const secondWorker = await worker(2);
    expect((await firstWorker.job(1)).from).not.toBe((await secondWorker.job(2)).from);

    await secondWorker.send({ job: 2, kind: 'report', body: 'Second done' });
    await firstWorker.send({ job: 1, kind: 'report', body: 'First done' });
    expect((await first).output).toBe('First done');
    expect((await second).output).toBe('Second done');
  });

  it('takes its jobs back when it closes, and refuses a run after', async () => {
    const { agents, runtime, close } = await start();
    const asking = runtime.run(agents.codex, { input: 'Ship the fix', threadId: 'thread-a' });
    const codex = await worker(1);
    await codex.inbox();
    await codex.send({ job: 1, kind: 'question', body: 'To staging or to production?' });
    await asking;
    const running = runtime.run(agents.codex, { input: 'Take your time' });
    await vi.waitFor(async () => expect((await codex.job(2)).state).toBe('working'));

    const rejected = expect(running).rejects.toThrow('The door to the bridge was closed');
    await close();
    await rejected;
    for (const job of [1, 2]) {
      expect(await codex.job(job)).toMatchObject({
        state: 'canceled',
        reason: expect.stringContaining('the door it came through was closed'),
      });
    }
    await expect(runtime.run(agents.codex, { input: 'More' })).rejects.toThrow(
      'The door to the bridge was closed'
    );
  });

  it('offers agents under names and descriptions of their own, and refuses a name twice', async () => {
    const { agents } = await start({
      agents: ['codex:new', { to: 'codex', name: 'reviewer', description: 'Reviews a diff' }],
    });
    expect(Object.keys(agents)).toEqual(['codex', 'reviewer']);
    expect(agents.reviewer.config.description).toBe('Reviews a diff');

    await expect(
      bridgeAgents({
        socketPath: bridgePaths({ home }).socket,
        project,
        agents: ['codex', 'codex:new'],
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('is an A2A service: a message is a job, a question leaves the task waiting, and the next message answers it', async () => {
    const { agents, runtime } = await start();
    const server = new A2AServer({ agents, cogitator: runtime });
    const send = (text: string, messageId: string, taskId?: string) =>
      server.handleJsonRpc({
        jsonrpc: '2.0',
        id: messageId,
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            role: 'user',
            messageId,
            parts: [{ kind: 'text', text }],
            ...(taskId && { taskId }),
          },
        },
      }) as Promise<{
        result?: { id: string; status: { state: string; message?: unknown } };
        error?: unknown;
      }>;

    const sent = send('Ship the fix', 'm-1');
    const codex = await worker(1);
    await codex.inbox();
    await codex.send({ job: 1, kind: 'question', body: 'To staging or to production?' });
    const asked = await sent;
    expect(asked.error).toBeUndefined();
    expect(asked.result?.status.state).toBe('input-required');
    expect(JSON.stringify(asked.result?.status.message)).toContain('To staging or to production?');

    const answered = send('Staging', 'm-2', asked.result?.id);
    expect((await mail(codex, 'answer')).body).toBe('Staging');
    await codex.send({ job: 1, kind: 'report', body: 'Shipped to staging' });
    const done = await answered;
    expect(done.error).toBeUndefined();
    expect(done.result?.status.state).toBe('completed');
    expect(JSON.stringify(done.result)).toContain('Shipped to staging');
    expect(adapter.sessions).toHaveLength(1);
  });

  it('is a set of MCP tools: a call is a job, and the report what the tool returns', async () => {
    const { agents, toolHost } = await start();
    const [ask] = agentTools(toolHost, Object.values(agents));
    expect(ask.name).toBe('codex');

    const called = ask.execute({ task: 'Summarize the README' } as never, toolContext);
    const codex = await worker(1);
    await codex.send({ job: 1, kind: 'report', body: 'It is a demo project' });
    expect(await called).toMatchObject({ status: 'completed', output: 'It is a demo project' });
    await expect(toolHost.resume()).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('spells a question out for a tool call, with the thread to answer it on', async () => {
    const { agents, toolHost } = await start();
    const [ask] = agentTools(toolHost, Object.values(agents));
    const first = ask.execute({ task: 'Ship the fix', threadId: 'thread-a' } as never, toolContext);
    const codex = await worker(1);
    await codex.inbox();
    await codex.send({ job: 1, kind: 'question', body: 'To staging or to production?' });
    expect(await first).toMatchObject({
      status: 'completed',
      threadId: 'thread-a',
      output:
        'codex asks before it goes on:\n\nTo staging or to production?\n\nAnswer by calling this tool again with the threadId "thread-a" and your answer as the task.',
    });

    const second = ask.execute({ task: 'Staging', threadId: 'thread-a' } as never, toolContext);
    expect((await mail(codex, 'answer')).body).toBe('Staging');
    await codex.send({ job: 1, kind: 'report', body: 'Shipped to staging' });
    expect(await second).toMatchObject({ status: 'completed', output: 'Shipped to staging' });
    expect(adapter.sessions).toHaveLength(1);
  });
});
