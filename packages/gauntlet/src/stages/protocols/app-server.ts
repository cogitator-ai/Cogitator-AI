import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { APP_SERVER_ERROR_CODES } from '@cogitator-ai/app-server';
import { APP_SERVER_PROTOCOL_VERSION } from '@cogitator-ai/app-server/client';
import type { StageDefinition } from '../../runner/types.js';
import { CLERK_AGENT, stampCode } from './session-fixtures.js';
import {
  APP_SERVER,
  MEMORY,
  TurnLog,
  fixtureEnv,
  protocolFixture,
  refusalCode,
  spawnAppServerFixture,
  textInput,
  type StdioFixture,
} from './sessions.js';
import { CORE, excerpt } from './shared.js';

const FIXTURE = protocolFixture('app-server.ts');
const DOCUMENT = 'DOC-311';

/** How long an interrupted turn may take to complete once `turn/interrupt` answered. */
const INTERRUPT_SETTLES_MS = 15_000;

function initialize(fixture: StdioFixture) {
  return fixture.client.initialize({
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    clientInfo: { name: 'gauntlet', version: '1.0.0' },
    capabilities: { approvals: 'pause' },
  });
}

/**
 * The app-server as an editor or a desktop app drives it: a child process on stdio, the generated
 * client on the other end, an approval that pauses a turn and a resume that finishes it, the trace
 * of a turn, an interrupt, and a second process on the same SQLite file that finds the thread.
 */
export const appServerStage: StageDefinition = {
  id: 'app-server',
  title: 'App-server over stdio',
  description:
    'A SessionHost served as NDJSON JSON-RPC on stdio by a child process, driven by the generated client: a turn pauses on an approval and resumes, its trace is kept, a long turn is interrupted, and a restarted server resumes the thread from SQLite.',
  packages: [APP_SERVER, CORE, MEMORY],
  needs: ['handshake'],
  requires: [{ kind: 'env', name: 'OPENROUTER_API_KEY', why: 'the fixture calls OpenRouter' }],
  timeoutMs: 300_000,
  async run(ctx) {
    const secret = randomUUID().replace(/-/g, '');
    const stamp = stampCode(secret);
    const env = fixtureEnv(ctx, join(ctx.tmpDir, 'sessions.db'), secret);
    const first = spawnAppServerFixture(ctx, FIXTURE, env);
    const turns = new TurnLog(first.client, ctx);

    await ctx.check('a request before initialize is refused with -32010', async (evidence) => {
      const code = await refusalCode(first.client.threadList());
      evidence('code', code);
      if (code !== APP_SERVER_ERROR_CODES.notInitialized) {
        throw new Error(`Expected ${APP_SERVER_ERROR_CODES.notInitialized}, got ${code}`);
      }
    });

    await ctx.check('initialize answers with the agents and capabilities', async (evidence) => {
      const result = await initialize(first);
      evidence('protocolVersion', result.protocolVersion);
      evidence('serverInfo', result.serverInfo);
      evidence('agents', result.agents);
      evidence('capabilities', result.capabilities);
      if (result.protocolVersion !== APP_SERVER_PROTOCOL_VERSION) {
        throw new Error(`The server speaks protocol ${result.protocolVersion}`);
      }
      const clerk = result.agents.find((agent) => agent.name === CLERK_AGENT);
      if (!clerk?.default) throw new Error(`${CLERK_AGENT} is not listed as the default agent`);
      if (clerk.model !== ctx.model) throw new Error(`${CLERK_AGENT} runs ${String(clerk.model)}`);
      if (!result.capabilities.approvals.includes('pause') || !result.capabilities.traces) {
        throw new Error('The server does not offer paused approvals and traces');
      }
    });

    const thread = await ctx.check('thread/start opens a thread', async (evidence) => {
      const { thread } = await first.client.threadStart({ agent: CLERK_AGENT });
      evidence('threadId', thread.id);
      evidence('status', thread.status);
      if (thread.agent !== CLERK_AGENT || thread.status !== 'idle') {
        throw new Error(`The thread runs ${String(thread.agent)} and is ${thread.status}`);
      }
      return thread;
    });

    const paused = await ctx.check(
      'turn/start answers before turn/started, which comes before its events',
      async (evidence) => {
        const { turn } = await first.client.turnStart({
          threadId: thread.id,
          input: textInput(`Stamp document ${DOCUMENT} with the archive stamp.`),
        });
        await turns.completed(turn.id);
        const order = first.wire.flatMap((entry, index) =>
          entry.turnId === turn.id ? [{ index, kind: entry.kind, method: entry.method }] : []
        );
        const answer = order.find((entry) => entry.kind === 'response');
        const started = order.find((entry) => entry.method === 'turn/started');
        const event = order.find((entry) => entry.method === 'turn/event');
        evidence(
          'order',
          order.slice(0, 4).map((entry) => entry.method ?? entry.kind)
        );
        if (!answer || !started || !event) {
          throw new Error('The answer, turn/started or a turn/event of the turn is missing');
        }
        if (!(answer.index < started.index && started.index < event.index)) {
          throw new Error(
            `Wire order: answer ${answer.index}, turn/started ${started.index}, first event ${event.index}`
          );
        }
        return turn;
      }
    );

    const approval = await ctx.check(
      'a tool needing approval ends the turn paused with it pending',
      async (evidence) => {
        const turn = await turns.completed(paused.id);
        const pending = turn.pending?.approvals ?? [];
        const calls = turns.toolCalls(paused.id);
        evidence('status', turn.status);
        evidence(
          'pending',
          pending.map((entry) => ({ tool: entry.toolName, arguments: entry.arguments }))
        );
        evidence(
          'toolCalls',
          calls.map((call) => call.name)
        );
        if (turn.status !== 'paused') {
          throw new Error(
            `The turn ended ${turn.status}: ${turn.error?.message ?? turn.output ?? ''}`
          );
        }
        const request = pending.find((entry) => entry.toolName === 'stamp_document');
        if (!request) throw new Error('stamp_document is not pending');
        if (calls.some((call) => call.id === request.toolCallId && call.result !== undefined)) {
          throw new Error('stamp_document has a result before it was approved');
        }
        const code = await refusalCode(
          first.client.turnStart({ threadId: thread.id, input: textInput('Hello?') })
        );
        evidence('newInputWhilePaused', code);
        if (code !== APP_SERVER_ERROR_CODES.threadPaused) {
          throw new Error(`New input on the paused thread was answered ${code}`);
        }
        return request;
      }
    );

    const resumed = await ctx.check(
      'turn/start with resume.decisions runs the call and finishes',
      async (evidence) => {
        const { turn } = await first.client.turnStart({
          threadId: thread.id,
          resume: { decisions: { [approval.toolCallId]: { approved: true } } },
        });
        const done = await turns.completed(turn.id);
        const result = turns.toolCalls(turn.id).find((call) => call.id === approval.toolCallId);
        evidence('status', done.status);
        evidence('toolResult', result?.result);
        evidence('output', excerpt(done.output ?? ''));
        if (done.status !== 'completed') {
          throw new Error(`The resumed turn ended ${done.status}: ${done.error?.message ?? ''}`);
        }
        if (!JSON.stringify(result?.result ?? null).includes(stamp)) {
          throw new Error('The approved call did not run with the resume');
        }
        if (!(done.output ?? '').includes(stamp)) {
          throw new Error('The answer lacks the stamp code the tool returned');
        }
        return done;
      }
    );

    await ctx.check('_cogitator/trace/get returns the LLM spans of the turn', async (evidence) => {
      const trace = await first.client.traceGet({ turnId: resumed.id });
      const llm = trace.spans.filter((span) => span.name.startsWith('llm.'));
      evidence('spans', trace.spans.length);
      evidence('names', [...new Set(trace.spans.map((span) => span.name))]);
      evidence('models', [...new Set(llm.map((span) => span.attributes['llm.model']))]);
      if (trace.threadId !== thread.id || trace.turnId !== resumed.id) {
        throw new Error('The trace belongs to another turn');
      }
      if (llm.length === 0) throw new Error('The trace has no LLM span');
      const missing = await refusalCode(first.client.traceGet({ turnId: 'turn_ghost' }));
      evidence('unknownTurn', missing);
      if (missing !== APP_SERVER_ERROR_CODES.notFound) {
        throw new Error(`An unknown turn was answered ${missing}`);
      }
    });

    await ctx.check('turn/interrupt stops a long turn', async (evidence) => {
      const { turn } = await first.client.turnStart({
        threadId: thread.id,
        input: textInput('Survey the east wing of the archive with survey_archive.'),
      });
      const call = await turns.event(
        turn.id,
        (event) => event.type === 'tool-call-start' && event.toolName === 'survey_archive',
        'the survey_archive call'
      );
      const asked = Date.now();
      await first.client.turnInterrupt({ threadId: thread.id, turnId: turn.id });
      const done = await turns.completed(turn.id, INTERRUPT_SETTLES_MS);
      const settledMs = Date.now() - asked;
      const survey = turns
        .toolCalls(turn.id)
        .find((entry) => call.type === 'tool-call-start' && entry.id === call.id);
      evidence('status', done.status);
      evidence('settledMs', settledMs);
      evidence('surveyResult', survey?.result ?? null);
      if (done.status !== 'interrupted') throw new Error(`The turn ended ${done.status}`);
      if (JSON.stringify(survey?.result ?? null).includes('112')) {
        throw new Error('The survey finished although the turn was interrupted');
      }
    });

    await ctx.check(
      'a restarted server resumes the thread from the same SQLite file',
      async (evidence) => {
        const exitCode = await first.stop();
        evidence('firstExit', exitCode);
        if (exitCode !== 0) {
          throw new Error(`The first server exited ${exitCode}: ${excerpt(first.stderr(), 400)}`);
        }
        const second = spawnAppServerFixture(ctx, FIXTURE, env);
        await initialize(second);
        const {
          thread: again,
          messages,
          pending,
        } = await second.client.threadResume({
          threadId: thread.id,
        });
        const roles = messages.map((message) => message.role);
        evidence('status', again.status);
        evidence('roles', roles);
        evidence('pending', pending?.approvals.length ?? 0);
        if (again.agent !== CLERK_AGENT) throw new Error(`The thread runs ${String(again.agent)}`);
        if (!messages.some((m) => m.role === 'user' && m.text.includes(DOCUMENT))) {
          throw new Error('The first request is not in the resumed history');
        }
        if (!messages.some((m) => m.role === 'assistant' && m.text.includes(stamp))) {
          throw new Error('The answer with the stamp code is not in the resumed history');
        }
        const listed = await second.client.threadList({ agent: CLERK_AGENT });
        evidence('listed', listed.threads.length);
        if (!listed.threads.some((entry) => entry.id === thread.id)) {
          throw new Error('thread/list of the second server does not list the thread');
        }
        const secondExit = await second.stop();
        evidence('secondExit', secondExit);
      }
    );
  },
};
