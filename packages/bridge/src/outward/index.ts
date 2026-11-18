import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Agent } from '@cogitator-ai/core';
import type { RunCheckpoint, RunResult } from '@cogitator-ai/types';
import { BridgeClient } from '../client.js';
import { BridgeError, isBridgeError } from '../errors.js';
import { aliasOfHarness, harnessOfAlias } from '../registry.js';
import { HarnessNameSchema, type CallerIdentity, type RenderedLetter } from '../types.js';
import { waitForMail } from '../waiter.js';

/** The harness word the outside world is known by in the address book of the bridge. */
export const OUTSIDE_HARNESS = 'outside';

/** The `reason` of the question a paused run asks: a question of the agent that has the job. */
export const AGENT_QUESTION_REASON = 'agent_question';

/** How long one look for mail lasts before the next one begins. */
const LOOK_MS = 60_000;

/** How long the door waits after a look for mail went wrong before it looks again. */
const RETRY_MS = 1_000;

/** How many threads may wait with a question nobody answered before the oldest is let go. */
const MAX_WAITING_THREADS = 1000;

const CLOSED = 'The door to the bridge was closed';

/** An agent of the bridge as the outside world is offered it. */
export interface OutwardAgentSpec {
  /** Who gets the jobs, as `delegate` takes it: `codex`, `claude:new`, `auto`, an agent's name */
  to: string;
  /** The name the outside world calls it by, made of the address when absent */
  name?: string;
  /** What it is good for, in a line: what an agent card and a tool description say */
  description?: string;
}

export interface BridgeAgentsOptions {
  /** Where the dispatcher of this machine listens, `bridgePaths().socket` */
  socketPath: string;
  /** The project the jobs are handed over in: an absolute path, where the agents work */
  project: string;
  /**
   * Who is offered: addresses as `delegate` takes them, or each with a name and a description.
   * Every harness the bridge can start a session of when absent
   */
  agents?: readonly (string | OutwardAgentSpec)[];
  /** What `status` and the journal call this door, `outward` by default */
  name?: string;
  /** Give every job a git worktree of its own, off the last commit of the project */
  worktree?: boolean;
  /** The type the jobs are handed over as, for the scoreboard */
  type?: string;
  /** How long a job may take before it is taken back, the budget of the bridge when absent */
  timeoutMs?: number;
}

export interface BridgeRunOptions {
  input: string;
  signal?: AbortSignal;
  /** The conversation the run belongs to: an A2A context, the thread of a tool call */
  threadId?: string;
  /** Ms the job may take before it is taken back, `timeoutMs` of the door when absent */
  timeout?: number;
  /** Who the run is for. Threads of different users never meet, whatever they are called */
  userId?: string;
}

export interface BridgeResumeOptions {
  /** The answer to the question the run paused on, by the id of its interrupt */
  responses?: Record<string, unknown>;
  signal?: AbortSignal;
  timeout?: number;
  userId?: string;
}

/**
 * The bridge as what runs agents, in the shape `A2AServer` takes as its `cogitator`. A run hands
 * a job to the agent of that name and resolves with its report. A question of the agent pauses
 * the run the way a question of a tool pauses a run of the runtime: `status: 'paused'` with the
 * question among its `interrupts`, and `resume` with the answer goes on.
 */
export interface BridgeRuntime {
  /**
   * Hands a job over and waits for its end, or for the first question of its agent. A run on a
   * thread whose job still waits for an answer means the caller moved on: that job is taken back.
   *
   * @throws BridgeError `unknown_agent` for a name the door does not offer, and what the
   * dispatcher refuses the job for. An `Error` when the agent reports that it failed, when the
   * bridge failed the job, and when the job was taken back
   */
  run(agent: unknown, options: BridgeRunOptions): Promise<RunResult>;
  /**
   * Answers the question a thread paused on, and waits again.
   *
   * @throws BridgeError `invalid_input` when no job waits on the thread or `responses` does not
   * answer its question
   */
  resume(
    agent: unknown,
    target: RunCheckpoint | string,
    options?: BridgeResumeOptions
  ): Promise<RunResult>;
  /** The run that waits for an answer on a thread, if any */
  pausedRun(threadId: string): Promise<{ runId: string } | undefined>;
  /** Takes back the job that waits for an answer on a thread. False when none does */
  cancelPause(threadId: string, options?: { userId?: string; reason?: string }): Promise<boolean>;
}

/**
 * The bridge as what `serveAgents` and `agentTools` take as their host. A tool call cannot wait
 * for an answer, so a question of the agent is the answer of the call, in words, with the thread
 * to answer it on: a call of the tool with that `threadId` is the answer.
 */
export interface BridgeToolHost {
  run(agent: unknown, options: BridgeRunOptions): Promise<RunResult>;
  /** Refuses: nothing of a job of the bridge waits for an approval at the client */
  resume(): Promise<RunResult>;
}

/** The agents of a bridge, ready to be served to the outside world. */
export interface BridgeAgents {
  /** The agents by the name the outside world calls them by */
  agents: Record<string, Agent>;
  /** What runs them, for `A2AServer` */
  runtime: BridgeRuntime;
  /** What runs them, for `serveAgents` and `agentTools` */
  toolHost: BridgeToolHost;
  /**
   * Closes the door: the jobs it still waits for are taken back, their runs rejected, and a run
   * after it is refused
   */
  close(): Promise<void>;
}

/** How a job that was handed over for a run ended, or what it stopped for. */
type Ended =
  | { kind: 'report'; body: string; failed: boolean }
  | { kind: 'question'; body: string; letter: string };

/** A run that waits for its job. */
interface Pending {
  /** The thread of the run, by user: what a question of the agent leaves waiting */
  key: string;
  thread: string;
  /** The agent the job was handed to, by the name it is offered under */
  agent: string;
  settle(ended: Ended): void;
  fail(error: Error): void;
  /** Stops watching the clock and the caller, without an end */
  drop(): void;
}

/** A thread whose job waits for the answer to a question of its agent. */
interface Waiting {
  thread: string;
  agent: string;
  job: number;
  /** The letter that asked, which the answer replies to */
  letter: string;
}

/** A run as its thread knows it: who it is for, and what limits it. */
interface Turn {
  key: string;
  thread: string;
  agent: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** What a run is rejected with when the bridge failed its job or the job was taken back. */
function badEnd(
  job: { number: number; state: string; reason?: string } | undefined
): Error | undefined {
  if (job?.state !== 'failed' && job?.state !== 'canceled') return undefined;
  return new Error(`Job #${job.number} ${job.state}${job.reason ? `: ${job.reason}` : ''}`);
}

function nameOf(address: string): string {
  const word = aliasOfHarness(harnessOfAlias(address.split(':')[0]));
  return (
    (address.includes('@') ? address : word)
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64) || 'agent'
  );
}

const keyOf = (userId: string | undefined, thread: string): string =>
  `${userId ?? ''}\u0000${thread}`;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((done) => {
    const end = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', end);
      done();
    };
    const timer = setTimeout(end, ms);
    signal.addEventListener('abort', end, { once: true });
  });
}

/**
 * Offers the agents of a bridge to the outside world. The result fits what serves agents
 * elsewhere in Cogitator, so one call makes them an A2A service or tools of an MCP server.
 *
 * A run hands a job to its agent and waits for the report, which is its answer. A question of
 * the agent pauses the run, and its answer goes on with the same job. A call the agent asks leave
 * for is allowed when the rules of the project allow it without asking, and left to the person at
 * this machine otherwise, as for any job: nobody outside can allow it. A report of failure
 * rejects the run.
 *
 * Every door is a session of its own in the book of the bridge, `outside@<project>`, so two of
 * them never read each other's mail.
 *
 * Whoever can reach the server you put in front of this can have the agents of this machine
 * work in `project` under your subscriptions. Keep that server on this machine or behind
 * authentication: `A2AServer` and `serveAgents` both take an `auth`.
 *
 * @example
 * ```ts
 * import { A2AServer } from '@cogitator-ai/a2a';
 * import { serveAgents } from '@cogitator-ai/mcp';
 * import { bridgePaths } from '@cogitator-ai/bridge';
 * import { bridgeAgents } from '@cogitator-ai/bridge/outward';
 *
 * const outward = await bridgeAgents({
 *   socketPath: bridgePaths().socket,
 *   project: process.cwd(),
 *   agents: ['codex', { to: 'claude:new', name: 'reviewer', description: 'Reviews a diff' }],
 * });
 * const a2a = new A2AServer({ agents: outward.agents, cogitator: outward.runtime });
 * await serveAgents(outward.toolHost, Object.values(outward.agents));
 * ```
 *
 * @throws BridgeError `not_running` without a dispatcher, `invalid_input` for a name two agents
 * share or a list that offers nobody
 */
export async function bridgeAgents(options: BridgeAgentsOptions): Promise<BridgeAgents> {
  const project = resolve(options.project);
  const label = options.name ?? 'outward';
  const caller: CallerIdentity = {
    harness: HarnessNameSchema.parse(OUTSIDE_HARNESS),
    sessionId: `${label}-${randomUUID()}`,
    cwd: project,
    project,
    sessionName: label,
  };
  /** One call to the dispatcher, on a connection of its own. */
  const call = async <T>(work: (client: BridgeClient) => Promise<T>): Promise<T> => {
    const client = await BridgeClient.connect({ socketPath: options.socketPath, caller });
    try {
      return await work(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  };

  const named = options.agents ?? (await call((client) => client.status())).startable;
  const offered = named.map((agent) => (typeof agent === 'string' ? { to: agent } : agent));
  if (offered.length === 0) {
    throw new BridgeError(
      'invalid_input',
      'There is no agent to offer: the bridge can start no session, and none was named'
    );
  }

  const addresses = new Map<string, string>();
  const agents: Record<string, Agent> = {};
  for (const spec of offered) {
    const name = spec.name ?? nameOf(spec.to);
    if (addresses.has(name)) {
      throw new BridgeError('invalid_input', `Two agents are offered under the name "${name}"`);
    }
    addresses.set(name, spec.to);
    const said =
      spec.description ??
      `Hands a job to ${spec.to} through the agent bridge of this machine, which does it in ${project} and answers with its report.`;
    agents[name] = new Agent({ name, description: said, instructions: said });
  }

  /** The runs that wait for a job, by its number */
  const pending = new Map<number, Pending>();
  /** The threads whose job waits for an answer, by user and thread */
  const waiting = new Map<string, Waiting>();
  /** How a job ended while its thread waited for an answer to a question of its agent */
  const early = new Map<number, Ended | Error>();
  const stop = new AbortController();
  let pump: Promise<void> | undefined;

  const waitsFor = (job: number): Waiting | undefined =>
    [...waiting.values()].find((asked) => asked.job === job);

  /** Takes a job back, when the dispatcher can still be told. */
  const takeBack = (job: number, why: string): Promise<void> =>
    call((client) => client.cancel(job, why)).then(
      () => undefined,
      () => undefined
    );

  /** Ends the wait of a thread for an answer, and takes its job back. */
  async function letGo(key: string, why: string): Promise<boolean> {
    const asked = waiting.get(key);
    if (!asked) return false;
    waiting.delete(key);
    const over = early.delete(asked.job);
    if (!over) await takeBack(asked.job, why);
    return true;
  }

  /**
   * Leaves a thread waiting for the answer to a question. A thread waits for one job at a time:
   * an earlier job of it that still waits is taken back, as the runtime ends a paused run when a
   * newer one pauses on its thread.
   */
  function waitOn(key: string, asked: Waiting): void {
    const earlier = waiting.get(key);
    waiting.delete(key);
    waiting.set(key, asked);
    if (earlier && earlier.job !== asked.job && !early.delete(earlier.job)) {
      void takeBack(earlier.job, 'the caller moved on to another job on this thread');
    }
    for (const [oldest, old] of waiting) {
      if (waiting.size <= MAX_WAITING_THREADS) break;
      waiting.delete(oldest);
      if (!early.delete(old.job)) void takeBack(old.job, 'nobody answered its question');
    }
  }

  /** Ends the run or the wait of a job the bridge failed or that was taken back. */
  async function noteEnd(number: number, client: BridgeClient): Promise<void> {
    const run = pending.get(number);
    if (!run && !waitsFor(number)) return;
    const failure = badEnd(await client.job(number).catch(() => undefined));
    if (!failure) return;
    if (run && pending.delete(number)) run.fail(failure);
    else if (waitsFor(number)) early.set(number, failure);
  }

  async function permit(letter: RenderedLetter, client: BridgeClient): Promise<void> {
    if (letter.ask && !letter.needsPerson) {
      await client.send({
        job: letter.job,
        kind: 'answer',
        body: 'The rules of the project allow this',
        verdict: 'allow',
        inReplyTo: letter.id,
      });
      return;
    }
    try {
      await client.escalate({ letter: letter.id });
    } catch (error) {
      if (!isBridgeError(error) || error.code !== 'no_person') throw error;
      await client.send({
        job: letter.job,
        kind: 'answer',
        body: 'Nobody is there to allow this: the job came from outside this machine',
        inReplyTo: letter.id,
        ...(letter.ask && { verdict: 'deny' as const }),
      });
    }
  }

  async function take(letter: RenderedLetter, client: BridgeClient): Promise<void> {
    if (letter.kind === 'permission') return permit(letter, client);

    const run = pending.get(letter.job);
    const asked = waitsFor(letter.job);
    if (letter.kind === 'question') {
      if (asked?.letter === letter.id) return;
      if (run) {
        pending.delete(letter.job);
        waitOn(run.key, {
          thread: run.thread,
          agent: run.agent,
          job: letter.job,
          letter: letter.id,
        });
        run.settle({ kind: 'question', body: letter.body, letter: letter.id });
        return;
      }
      if (asked) {
        await client.send({
          job: letter.job,
          kind: 'answer',
          body: 'A question on this job already waits for its answer from outside this machine. One question at a time: go on with what you have, or wait for that answer',
          inReplyTo: letter.id,
        });
        return;
      }
    } else if (letter.kind === 'report') {
      const end: Ended = { kind: 'report', body: letter.body, failed: letter.outcome === 'failed' };
      if (run) {
        pending.delete(letter.job);
        run.settle(end);
      } else if (asked) {
        early.set(letter.job, end);
      }
    } else if (letter.kind === 'note' && letter.from === 'bridge') {
      await noteEnd(letter.job, client);
    }
    await client.acknowledge(letter.id).catch(() => undefined);
  }

  /**
   * One look for mail. A letter the dispatcher refuses to have handled, because its job ended in
   * the meantime or it was answered already, is set aside, and never costs another run its
   * letter.
   */
  async function look(): Promise<void> {
    const mail = await waitForMail({
      socketPath: options.socketPath,
      caller,
      timeoutMs: LOOK_MS,
      signal: stop.signal,
    });
    if (mail.reason === 'replaced') await pause(RETRY_MS, stop.signal);
    if (mail.letters.length === 0) return;
    try {
      await call(async (client) => {
        for (const letter of mail.letters) {
          try {
            await take(letter, client);
          } catch (error) {
            if (!isBridgeError(error) || error.code === 'not_running') throw error;
            await client.acknowledge(letter.id).catch(() => undefined);
            await noteEnd(letter.job, client);
          }
        }
      });
    } catch (error) {
      await mail.release().catch(() => undefined);
      throw error;
    }
    await mail.confirm();
  }

  /**
   * Takes the mail of this door while a run waits for a job or a thread for an answer, and hands
   * each letter to its run. A look that goes wrong, as when the dispatcher restarts, is tried
   * again: the letters it did not handle come back.
   */
  async function lookForMail(): Promise<void> {
    while ((pending.size > 0 || waiting.size > 0) && !stop.signal.aborted) {
      try {
        await look();
      } catch {
        await pause(RETRY_MS, stop.signal);
      }
    }
  }

  /** Waits for the end of a job, or for its question. The run is known from this call on. */
  function ended(job: number, turn: Turn): Promise<Ended> {
    const { signal, timeoutMs } = turn;
    const result = new Promise<Ended>((settle, fail) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => giveUp(`it took longer than ${timeoutMs} ms`), timeoutMs);
      const giveUp = (why: string): void => {
        if (!pending.delete(job)) return;
        void takeBack(job, why);
        done();
        fail(new Error(`Job #${job} was taken back: ${why}`));
      };
      const onAbort = (): void => giveUp('the caller gave up on it');
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      pending.set(job, {
        key: turn.key,
        thread: turn.thread,
        agent: turn.agent,
        settle: (end) => {
          done();
          settle(end);
        },
        fail: (error) => {
          done();
          fail(error);
        },
        drop: done,
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      pump ??= lookForMail().finally(() => {
        pump = undefined;
      });
    });
    result.catch(() => undefined);
    return result;
  }

  /** Forgets the run that waits for a job, without an end. */
  function unwatch(job: number): void {
    const run = pending.get(job);
    if (run && pending.delete(job)) run.drop();
  }

  async function handOver(
    address: string,
    input: string,
    turn: Turn
  ): Promise<{ job: number; end: Ended }> {
    const handed = await call(async (client) => {
      const created = await client.createJob({
        to: address,
        body: input,
        ...(options.worktree && { worktree: true }),
        ...(options.type && { type: options.type }),
      });
      return { job: created.job.number, end: ended(created.job.number, turn) };
    });
    return { job: handed.job, end: await handed.end };
  }

  /**
   * Answers the question a thread waits on. When the job ended in the meantime the answer has
   * nobody to go to, and the run ends with what the job ended with. When the bridge handed the
   * job on to another agent, the question went with the one that asked it: the answer reaches
   * the new agent as a note, and the run waits for the job as before.
   */
  async function answer(asked: Waiting, text: string, turn: Turn): Promise<Ended> {
    waiting.delete(turn.key);
    const before = early.get(asked.job);
    if (before) {
      early.delete(asked.job);
      if (before instanceof Error) throw before;
      return before;
    }

    const end = ended(asked.job, turn);
    try {
      await call((client) =>
        client.send({ job: asked.job, kind: 'answer', body: text, inReplyTo: asked.letter })
      );
    } catch (error) {
      const job = await call((client) => client.job(asked.job)).catch(() => undefined);
      if (job?.state === 'completed') return end;
      const failure = badEnd(job);
      if (failure) {
        unwatch(asked.job);
        throw failure;
      }
      const handedOn = job !== undefined && isBridgeError(error) && error.code === 'invalid_letter';
      const noted =
        handedOn &&
        (await call((client) =>
          client.send({
            job: asked.job,
            kind: 'note',
            body: `The answer to what the agent before you asked on this job: ${text}`,
          })
        ).then(
          () => true,
          () => false
        ));
      if (!noted) {
        unwatch(asked.job);
        waiting.set(turn.key, asked);
        throw error;
      }
    }
    return end;
  }

  function offeredAs(agent: unknown): { name: string; address: string } {
    const name = (agent as { name?: unknown } | null)?.name;
    const address = typeof name === 'string' ? addresses.get(name) : undefined;
    if (typeof name !== 'string' || address === undefined) {
      throw new BridgeError('unknown_agent', `The bridge offers no agent "${String(name)}"`);
    }
    return { name, address };
  }

  /**
   * The result of a run whose job reported, or stopped on a question (`output` is empty then).
   *
   * @throws Error when the report says the agent failed
   */
  function resultOf(
    agent: unknown,
    turn: Turn,
    job: number,
    end: Ended,
    startedAt: number
  ): RunResult {
    if (end.kind === 'report' && end.failed) {
      throw new Error(`${turn.agent} could not do the job: ${end.body}`);
    }
    const runId = `bridge-job-${job}`;
    return {
      output: end.kind === 'report' ? end.body : '',
      runId,
      agentId: (agent as Agent).id,
      threadId: turn.thread,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cost: 0,
        duration: Date.now() - startedAt,
      },
      toolCalls: [],
      messages: [],
      trace: { traceId: runId, spans: [] },
    };
  }

  function turnOf(
    name: string,
    thread: string,
    run: { signal?: AbortSignal; timeout?: number; userId?: string }
  ): Turn {
    if (stop.signal.aborted) throw new Error(CLOSED);
    const timeoutMs = run.timeout ?? options.timeoutMs;
    return {
      key: keyOf(run.userId, thread),
      thread,
      agent: name,
      ...(run.signal && { signal: run.signal }),
      ...(timeoutMs !== undefined && { timeoutMs }),
    };
  }

  /** A run of the runtime: paused on the question of the agent, when the job stopped on one. */
  function paused(result: RunResult, end: Ended): RunResult {
    if (end.kind !== 'question') return result;
    return {
      ...result,
      status: 'paused',
      interrupts: [
        { id: end.letter, kind: 'input', reason: AGENT_QUESTION_REASON, message: end.body },
      ],
    };
  }

  const runtime: BridgeRuntime = {
    async run(agent, run) {
      const { name, address } = offeredAs(agent);
      const turn = turnOf(name, run.threadId ?? randomUUID(), run);
      const startedAt = Date.now();
      await letGo(turn.key, 'the caller moved on to another job on this thread');
      const { job, end } = await handOver(address, run.input, turn);
      return paused(resultOf(agent, turn, job, end, startedAt), end);
    },

    async resume(agent, target, resume = {}) {
      const { name } = offeredAs(agent);
      const turn = turnOf(name, typeof target === 'string' ? target : target.threadId, resume);
      const asked = waiting.get(turn.key);
      if (!asked) {
        throw new BridgeError('invalid_input', 'No job waits for an answer on this thread');
      }
      const given = resume.responses?.[asked.letter];
      if (given === undefined || given === null || given === '') {
        throw new BridgeError(
          'invalid_input',
          `Job #${asked.job} waits for the answer to its question ${asked.letter}, and got none`
        );
      }
      const startedAt = Date.now();
      const text = typeof given === 'string' ? given : JSON.stringify(given);
      const end = await answer(asked, text, turn);
      return paused(resultOf(agent, turn, asked.job, end, startedAt), end);
    },

    async pausedRun(threadId) {
      const asked = [...waiting.values()].reverse().find((entry) => entry.thread === threadId);
      return asked && { runId: `bridge-job-${asked.job}` };
    },

    async cancelPause(threadId, cancel = {}) {
      return letGo(
        keyOf(cancel.userId, threadId),
        cancel.reason ?? 'the caller withdrew before its question was answered'
      );
    },
  };

  const toolHost: BridgeToolHost = {
    async run(agent, run) {
      const { name, address } = offeredAs(agent);
      const turn = turnOf(name, run.threadId ?? randomUUID(), run);
      const startedAt = Date.now();
      const asked = waiting.get(turn.key);
      const { job, end } =
        asked?.agent === name
          ? { job: asked.job, end: await answer(asked, run.input, turn) }
          : await handOver(address, run.input, turn);
      const result = resultOf(agent, turn, job, end, startedAt);
      if (end.kind !== 'question') return result;
      return {
        ...result,
        output: `${name} asks before it goes on:\n\n${end.body}\n\nAnswer by calling this tool again with the threadId "${turn.thread}" and your answer as the task.`,
      };
    },
    async resume() {
      throw new BridgeError(
        'invalid_input',
        'Nothing of a job of the bridge waits for an approval here: leave for a call is asked through the bridge, and a question is answered by calling the tool of the agent with its threadId'
      );
    },
  };

  return {
    agents,
    runtime,
    toolHost,
    async close() {
      if (stop.signal.aborted) return;
      stop.abort();
      const jobs = [
        ...pending.keys(),
        ...[...waiting.values()].map((asked) => asked.job).filter((job) => !early.has(job)),
      ];
      for (const run of [...pending.values()]) run.fail(new Error(CLOSED));
      pending.clear();
      waiting.clear();
      early.clear();
      await Promise.all(jobs.map((job) => takeBack(job, 'the door it came through was closed')));
      await pump?.catch(() => undefined);
    },
  };
}
