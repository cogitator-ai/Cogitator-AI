import { Cogitator } from '@cogitator-ai/core';
import type { CheckpointStore, Workflow } from '@cogitator-ai/types';
import { InMemoryCheckpointStore, WorkflowExecutor } from '@cogitator-ai/workflows';
import type {
  BridgeAdapter,
  BridgeCalls,
  CreatedSession,
  LetterDelivery,
  LiveSession,
  SessionRequest,
} from '../adapter.js';
import { isBridgeError } from '../errors.js';
import type { Finding } from '../findings.js';
import { isFinishedJobState } from '../job-record.js';
import { quoted } from '../letters.js';
import { RECIPE_HARNESS } from '../registry.js';
import { PERSON, type BridgeJob, type JobRecipe, type JobState, type Letter } from '../types.js';
import { BUILT_IN_RECIPES } from './built-in.js';
import type { Recipe, RecipeEngine, RecipeRun, RecipeState } from './recipe.js';

/** How letters reach the conductor: handed to it in the process of the dispatcher. */
export const RECIPE_DELIVERY = 'recipe';

export interface RecipeAdapterOptions {
  /** The recipes the conductor knows, the built-in ones (`BUILT_IN_RECIPES`) by default */
  recipes?: readonly Recipe[];
  /**
   * Where the checkpoints of the runs are kept. With a store that outlives the process, such as
   * `FileCheckpointStore`, a recipe goes on from its last finished step after the dispatcher was
   * restarted. In memory by default, which loses the place of a run with the process
   */
  checkpoints?: CheckpointStore;
  /**
   * The runtime the steps run in, for a recipe whose step runs an agent of its own. One without
   * models is made when absent: the built-in recipes call no model
   */
  runtime?: Cogitator;
  /** The harness word of the conductor, `recipe` by default */
  harness?: string;
  /**
   * How often the conductor looks at a job it waits for when no letter about it comes, 5 s by
   * default. A report wakes it at once: this catches a job that ended without a letter to it
   */
  pollMs?: number;
  /** Hears what went wrong outside a call of the bridge: a report that could not be sent */
  onError?: (error: Error) => void;
  /** How long a run that was told to stop is waited for when the host closes, 5 s by default */
  stopGraceMs?: number;
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_STOP_GRACE_MS = 5_000;

const ACTIVE: readonly JobState[] = ['submitted', 'working', 'input-required'];

/** A step of a run, as the id of the letter that hands its job over carries it. */
const STEP = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** The id of a question the conductor passed on: the job it came from, and its place there. */
const RELAYED = /^relay-(\d+)-(\d+)$/;

/** The most of a report the conductor sends: a letter holds no more than the bridge allows. */
const REPORT_LENGTH = 100_000;

/** Why a run stops before its recipe is done. */
type Stop = 'closing' | 'over';

interface Running {
  /** The job of the recipe */
  job: number;
  /** The name the bridge knows the conductor of this run by */
  agentName: string;
  /** Who started the recipe */
  from: string;
  stop: AbortController;
  why?: Stop;
  /** The workflows of the run, by name: where its checkpoints lie */
  workflows: Set<string>;
  done: Promise<void>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function sessionOf(job: number): string {
  return `recipe-${job}`;
}

function runIdOf(job: number): string {
  return `bridge-job-${job}`;
}

/**
 * A checkpoint store that keeps one checkpoint of each workflow of a run, the newest: a run
 * writes one after every step, and only the last one is ever gone on from.
 */
function newestOnly(store: CheckpointStore): CheckpointStore & { forget(runId: string): void } {
  const last = new Map<string, Map<string, string>>();
  return {
    async save(checkpoint) {
      await store.save(checkpoint);
      const ofRun = last.get(checkpoint.workflowId) ?? new Map<string, string>();
      last.set(checkpoint.workflowId, ofRun);
      const before = ofRun.get(checkpoint.workflowName);
      ofRun.set(checkpoint.workflowName, checkpoint.id);
      if (before && before !== checkpoint.id) await store.delete(before).catch(() => undefined);
    },
    load: (id) => store.load(id),
    list: (name) => store.list(name),
    delete: (id) => store.delete(id),
    forget(runId) {
      last.delete(runId);
    },
  };
}

/**
 * The conductor of the bridge: an agent without a model that carries a job out by the steps of
 * a recipe. A job that names a recipe goes to it (`createJob({ to: 'recipe', recipe })`), and it
 * hands jobs of its own to the other agents, waits for their reports and reports to whoever
 * started the recipe. Those jobs are part of the recipe's job, so its budget, its deadline, the
 * rules of whoever started it and its cancel hold for all of them.
 *
 * Every run is a workflow with a checkpoint after each step. A job is handed over under an id
 * made of the run and the step, so a step that runs again finds the job it handed over before:
 * with checkpoints that outlive the process a recipe goes on where it was after the dispatcher
 * was restarted, without doing anything twice.
 *
 * A question of an agent that works on a step is passed on to whoever started the recipe, and
 * the answer back. A call such an agent asks leave for is allowed when the rules of whoever
 * started the recipe allow it without asking, and is the person's to allow otherwise.
 *
 * @example
 * ```ts
 * import { hostBridge } from '@cogitator-ai/bridge';
 * import { recipeAdapter } from '@cogitator-ai/bridge/recipes';
 * import { FileCheckpointStore } from '@cogitator-ai/workflows';
 *
 * const host = await hostBridge({
 *   adapters: [claude, codex, recipeAdapter({ checkpoints: new FileCheckpointStore(dir) })],
 * });
 * ```
 */
export function recipeAdapter(options: RecipeAdapterOptions = {}): BridgeAdapter {
  const harness = options.harness ?? RECIPE_HARNESS;
  const recipes = new Map<string, Recipe>();
  for (const recipe of options.recipes ?? BUILT_IN_RECIPES) {
    if (recipes.has(recipe.name)) throw new Error(`Two recipes are named ${recipe.name}`);
    recipes.set(recipe.name, recipe);
  }
  const onError = options.onError ?? (() => undefined);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const checkpoints = newestOnly(options.checkpoints ?? new InMemoryCheckpointStore());
  const ownRuntime = options.runtime ? undefined : new Cogitator();
  const runtime = options.runtime ?? ownRuntime;
  if (!runtime) throw new Error('The conductor has no runtime to run its steps in');
  const executor = new WorkflowExecutor(runtime, checkpoints);

  const runs = new Map<string, Running>();
  const watchers = new Map<number, Set<() => void>>();
  let bridge: BridgeCalls | undefined;
  let recovered: Promise<void> = Promise.resolve();
  let closed = false;

  function calls(): BridgeCalls {
    if (!bridge) throw new Error('The conductor is not attached to a bridge');
    return bridge;
  }

  function wake(job: number): void {
    for (const look of [...(watchers.get(job) ?? [])]) look();
  }

  function halt(running: Running, why: Stop): void {
    if (running.stop.signal.aborted) return;
    running.why = why;
    running.stop.abort(
      new Error(
        why === 'closing' ? 'The host is closing' : `Job #${running.job} of the recipe is over`
      )
    );
  }

  /** Resolves when a letter about the job came, `pollMs` passed or the run stops. */
  function nextLook(running: Running, job: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiting = watchers.get(job) ?? new Set<() => void>();
      watchers.set(job, waiting);
      const look = (): void => {
        clearTimeout(timer);
        running.stop.signal.removeEventListener('abort', look);
        waiting.delete(look);
        if (waiting.size === 0 && watchers.get(job) === waiting) watchers.delete(job);
        resolve();
      };
      const timer = setTimeout(look, pollMs);
      running.stop.signal.addEventListener('abort', look, { once: true });
      waiting.add(look);
    });
  }

  /**
   * Waits until a job the run handed over is over, with its checks run. Stops the run when the
   * job of the recipe itself ended meanwhile: nobody waits for the rest.
   */
  async function ended(running: Running, number: number): Promise<BridgeJob> {
    for (;;) {
      running.stop.signal.throwIfAborted();
      const [job, own] = await Promise.all([calls().job(number), calls().job(running.job)]);
      if (isFinishedJobState(own.state)) halt(running, 'over');
      running.stop.signal.throwIfAborted();
      if (isFinishedJobState(job.state) && !job.checking) return job;
      await nextLook(running, number);
    }
  }

  /**
   * Hands a job of a run over. A refusal that passes by itself is waited out: the bridge starts
   * only so many sessions at once, and a step is not lost to another job that happened to start
   * at the same moment. The wait ends with the job of the recipe.
   */
  async function handedTo(
    running: Running,
    job: Parameters<BridgeCalls['createJob']>[1]
  ): Promise<BridgeJob> {
    for (;;) {
      running.stop.signal.throwIfAborted();
      try {
        return (await calls().createJob(running.agentName, job)).job;
      } catch (error) {
        const busy =
          isBridgeError(error) &&
          error.code === 'no_session' &&
          typeof error.data?.starting === 'number';
        if (!busy) throw error;
      }
      await nextLook(running, running.job);
      if (isFinishedJobState((await calls().job(running.job)).state)) halt(running, 'over');
    }
  }

  async function taskOf(job: BridgeJob): Promise<string> {
    const [first] = await calls().letters({ job: job.number, kinds: ['task'], limit: 1 });
    if (!first) return '';
    return job.taskLength === undefined ? first.body : first.body.slice(0, job.taskLength);
  }

  async function runOf(running: Running, job: BridgeJob): Promise<RecipeRun> {
    return {
      job,
      task: await taskOf(job),
      conductor: running.agentName,
      signal: running.stop.signal,
      async handOver(step, spec) {
        if (!STEP.test(step)) {
          throw new Error(
            `A step is named in lower-case letters, digits, "." and "-", and "${step}" is not`
          );
        }
        const created = await handedTo(running, {
          ...spec,
          parent: running.job,
          letterId: `recipe-${running.job}-${step}`,
        });
        const over = await ended(running, created.number);
        const [report] = await calls().letters({
          job: over.number,
          kinds: ['report'],
          newestFirst: true,
          limit: 1,
        });
        return { job: over, ...(report && { report: report.body }) };
      },
      async handedOver(step) {
        const id = `recipe-${running.job}-${step}`;
        for (const part of await calls().jobs({ parent: running.job })) {
          const [first] = await calls().letters({ job: part.number, kinds: ['task'], limit: 1 });
          if (first?.id === id) return part;
        }
        return undefined;
      },
      lookAt: (number) => calls().job(number),
      agent: async (name) => (await calls().agents()).find((agent) => agent.name === name),
      taskOf,
      startable: async () => (await calls().startable()).filter((word) => word !== harness),
      wakes: (name) => calls().wakes(name),
    };
  }

  function engineOf(running: Running): RecipeEngine {
    return {
      async run<TState extends RecipeState>(workflow: Workflow<TState>): Promise<TState> {
        const runId = runIdOf(running.job);
        running.workflows.add(workflow.name);
        const how = {
          workflowId: runId,
          checkpoint: true,
          checkpointStrategy: 'per-node' as const,
          signal: running.stop.signal,
        };
        const [last] = (await checkpoints.list(workflow.name))
          .filter((checkpoint) => checkpoint.workflowId === runId)
          .sort((a, b) => b.timestamp - a.timestamp);
        const result = last
          ? await executor.resume(workflow, last.id, how)
          : await executor.execute(workflow, undefined, how);
        running.stop.signal.throwIfAborted();
        if (result.error) throw result.error;
        return result.state;
      },
    };
  }

  /** Drops the checkpoints of a run that is over: nothing goes on from them. */
  async function forget(running: Running): Promise<void> {
    const runId = runIdOf(running.job);
    checkpoints.forget(runId);
    for (const name of running.workflows) {
      try {
        for (const checkpoint of await checkpoints.list(name)) {
          if (checkpoint.workflowId === runId) await checkpoints.delete(checkpoint.id);
        }
      } catch (error) {
        onError(asError(error));
      }
    }
  }

  /**
   * Reports on the job of a run, which ends it. A report the bridge does not take as it is, such
   * as one with findings it cannot keep, is sent again without them, and after that as a plain
   * failure: a recipe that is over never leaves its job open.
   */
  async function report(
    running: Running,
    body: string,
    failed: boolean,
    findings?: Finding[]
  ): Promise<void> {
    const clean = body.replaceAll('\0', '');
    const text = clean.length > REPORT_LENGTH ? `${clean.slice(0, REPORT_LENGTH)}\n...` : clean;
    const outcome = failed ? { outcome: 'failed' as const } : {};
    const tries: Parameters<BridgeCalls['send']>[1][] = [
      { job: running.job, kind: 'report', body: text, ...outcome, ...(findings && { findings }) },
      { job: running.job, kind: 'report', body: text, ...outcome },
      {
        job: running.job,
        kind: 'report',
        body: 'The recipe ended, and the bridge did not take its report',
        outcome: 'failed',
      },
    ];
    for (const letter of tries) {
      try {
        await calls().send(running.agentName, letter);
        return;
      } catch (error) {
        if (isBridgeError(error) && ['job_finished', 'not_running'].includes(error.code)) return;
        onError(asError(error));
      }
    }
  }

  /** The jobs a run handed over, in a line, for a report that has nothing else to point at. */
  async function stepsOf(running: Running): Promise<string> {
    try {
      const steps = await calls().jobs({ parent: running.job });
      if (steps.length === 0) return '';
      const named = steps
        .sort((a, b) => a.number - b.number)
        .map((step) => `#${step.number} (${step.state})`);
      return `\nThe jobs it handed over: ${named.join(', ')}.`;
    } catch {
      return '';
    }
  }

  async function carryOut(running: Running): Promise<void> {
    const job = await calls().job(running.job);
    if (isFinishedJobState(job.state)) return;
    const recipe = job.recipe ? recipes.get(job.recipe.name) : undefined;
    if (!job.recipe || !recipe) {
      await report(
        running,
        job.recipe
          ? `This bridge has no recipe "${job.recipe.name}". Its recipes: ${[...recipes.keys()].join(', ')}`
          : `The conductor carries out recipes, and job #${job.number} names none`,
        true
      );
      return;
    }
    let state: RecipeState;
    try {
      state = await recipe.carryOut(job.recipe.input, await runOf(running, job), engineOf(running));
    } catch (error) {
      if (running.why === 'closing' || closed) return;
      if (isBridgeError(error) && error.code === 'not_running') return;
      await forget(running);
      if (running.why === 'over') return;
      await report(
        running,
        `The recipe ${recipe.name} failed: ${asError(error).message}${await stepsOf(running)}`,
        true
      );
      return;
    }
    await report(
      running,
      state.report?.trim() || `The recipe ${recipe.name} ended without a report`,
      state.failed === true,
      state.findings
    );
    await forget(running);
  }

  function start(sessionId: string, agentName: string, job: number, from: string): void {
    const running: Running = {
      job,
      agentName,
      from,
      stop: new AbortController(),
      workflows: new Set(),
      done: Promise.resolve(),
    };
    runs.set(sessionId, running);
    running.done = carryOut(running)
      .catch((error: unknown) => onError(asError(error)))
      .finally(() => {
        if (runs.get(sessionId) === running) runs.delete(sessionId);
      });
  }

  /** Sends a letter as the conductor of a run. A letter the bridge no longer takes is let go. */
  async function say(
    running: Running,
    letter: Parameters<BridgeCalls['send']>[1]
  ): Promise<Error | undefined> {
    try {
      await calls().send(running.agentName, letter);
      return undefined;
    } catch (error) {
      if (isBridgeError(error) && error.code === 'job_finished') return undefined;
      return asError(error);
    }
  }

  /**
   * Passes a question of an agent that works on a step on to whoever started the recipe. The
   * letter that carries it is named after the job and the place of the question in it, which is
   * how its answer finds the way back.
   */
  async function passOn(running: Running, letter: Letter, job: BridgeJob): Promise<void> {
    const asks = letter.kind === 'permission' ? 'asks leave' : 'asks';
    const failed = await say(running, {
      job: running.job,
      kind: letter.kind === 'permission' ? 'permission' : 'question',
      id: `relay-${job.number}-${letter.seq}`,
      body: `${letter.from}, who works on job #${job.number} of this recipe, ${asks}:\n${quoted(letter.body)}`,
    });
    if (!failed) return;
    const told = await say(running, {
      job: job.number,
      kind: 'answer',
      inReplyTo: letter.id,
      body: `The bridge could not pass this on to ${running.from}: ${failed.message}. Decide it yourself, and say in your report what you decided.`,
    });
    if (told) onError(told);
  }

  /** Takes the answer to a question that was passed on back to the agent that asked. */
  async function passBack(
    running: Running,
    relayed: RegExpExecArray,
    answer: Letter
  ): Promise<void> {
    const job = Number(relayed[1]);
    const seq = Number(relayed[2]);
    const [asked] = await calls().letters({ job, afterSeq: seq - 1, limit: 1 });
    if (asked?.seq !== seq) return;
    const who = answer.from === PERSON ? 'The person' : answer.from;
    const failed = await say(running, {
      job,
      kind: 'answer',
      inReplyTo: asked.id,
      id: `relay-back-${job}-${answer.seq}`,
      body: `${who} answers:\n${quoted(answer.body)}`,
    });
    if (failed && !(isBridgeError(failed) && failed.code === 'invalid_letter')) onError(failed);
  }

  /**
   * Answers what whoever started the recipe asked the conductor: it carries steps out and
   * decides nothing, so it says who works on the recipe right now, and the question is done
   * with instead of failing the job when nobody answers it.
   */
  async function answerStarter(running: Running, letter: Letter): Promise<void> {
    const steps = await calls().jobs({ parent: running.job, states: ACTIVE });
    const who =
      steps.length > 0
        ? `In progress: ${steps.map((step) => `job #${step.number} with ${step.to}`).join(', ')}. A note on this job reaches them`
        : 'No step is in progress right now';
    const failed = await say(running, {
      job: running.job,
      kind: 'answer',
      inReplyTo: letter.id,
      ...(letter.ask && { verdict: 'deny' as const }),
      body: `The conductor of a recipe carries its steps out and answers no questions. ${who}.`,
    });
    if (failed) onError(failed);
  }

  /** Passes a note of whoever started the recipe on to the agents that work on it right now. */
  async function passDown(running: Running, letter: Letter): Promise<void> {
    for (const step of await calls().jobs({ parent: running.job, states: ACTIVE })) {
      const failed = await say(running, {
        job: step.number,
        kind: 'note',
        id: `relay-note-${step.number}-${letter.seq}`,
        body: `${letter.from}, who started the recipe this job is a step of, notes:\n${quoted(letter.body)}`,
      });
      if (failed && !(isBridgeError(failed) && failed.code === 'loop_detected')) onError(failed);
    }
  }

  async function handle(running: Running, letter: Letter): Promise<void> {
    const settle = (): Promise<unknown> =>
      calls()
        .acknowledge(running.agentName, letter.id)
        .catch(() => undefined);
    if (letter.job === running.job) {
      const relayed =
        letter.kind === 'answer' && letter.inReplyTo && RELAYED.exec(letter.inReplyTo);
      if (relayed) await passBack(running, relayed, letter);
      else if (letter.kind === 'question' || letter.kind === 'permission') {
        await answerStarter(running, letter);
      } else if (letter.kind === 'note' && letter.from === running.from) {
        await passDown(running, letter);
      }
      await settle();
      if (isFinishedJobState((await calls().job(running.job)).state)) halt(running, 'over');
      return;
    }
    const job = await calls().job(letter.job);
    if (isFinishedJobState(job.state)) {
      await settle();
    } else if (letter.kind === 'question' || (letter.kind === 'permission' && !letter.ask)) {
      await passOn(running, letter, job);
    } else if (letter.kind === 'permission' && letter.ask) {
      if (!letter.needsPerson) {
        const failed = await say(running, {
          job: letter.job,
          kind: 'answer',
          inReplyTo: letter.id,
          verdict: 'allow',
          body: `The rules of ${running.from}, who started the recipe, allow this`,
        });
        if (failed) onError(failed);
      }
    } else {
      await settle();
    }
    wake(letter.job);
  }

  /**
   * Picks up the runs a dispatcher before this one left in the middle: every recipe job that is
   * still open goes on from its last checkpoint, and what was written to its conductor and not
   * dealt with yet is dealt with now.
   */
  async function recover(): Promise<void> {
    const [jobs, agents] = await Promise.all([
      calls().jobs({ states: ACTIVE }),
      calls().agents({ harness }),
    ]);
    for (const job of jobs) {
      if (closed) return;
      const agent = agents.find((candidate) => candidate.name === job.to);
      if (!job.recipe || agent?.sessionId !== sessionOf(job.number)) continue;
      if (runs.has(agent.sessionId)) continue;
      start(agent.sessionId, agent.name, job.number, job.from);
      const running = runs.get(agent.sessionId);
      if (!running) continue;
      const waiting = await calls().letters({
        to: agent.name,
        states: ['delivered', 'read'],
        kinds: ['question', 'permission', 'answer'],
      });
      for (const letter of waiting) {
        await handle(running, letter).catch((error: unknown) => onError(asError(error)));
      }
    }
  }

  function problemOf(recipe: JobRecipe): string | undefined {
    const known = recipes.get(recipe.name);
    if (!known) {
      return `There is no recipe "${recipe.name}". The recipes of this bridge: ${[...recipes.keys()].join(', ')}`;
    }
    const problem = known.problem(recipe.input);
    return problem && `The recipe ${recipe.name} cannot start with this input: ${problem}`;
  }

  return {
    harness,
    delivery: RECIPE_DELIVERY,
    ownsSessions: true,
    capabilities: { createSession: true, push: true, steer: false, nativeWindow: false },
    recipeProblem: problemOf,
    attach(to: BridgeCalls): void {
      bridge = to;
      recovered = recover().catch((error: unknown) => onError(asError(error)));
    },
    async createSession(request: SessionRequest): Promise<CreatedSession> {
      if (closed) throw new Error('The host is closing');
      if (!request.job.recipe) {
        throw new Error(
          `the conductor carries out recipes, and job #${request.job.number} names none`
        );
      }
      const sessionId = sessionOf(request.job.number);
      await calls().register({
        harness,
        sessionId,
        cwd: request.cwd,
        project: request.project,
        agentName: request.agentName,
      });
      if (!runs.has(sessionId)) {
        start(sessionId, request.agentName, request.job.number, request.job.from);
      }
      return { sessionId, deliveredFirstLetter: true };
    },
    async deliver({ agent, letter }: LetterDelivery): Promise<void> {
      await recovered;
      const running = runs.get(agent.sessionId);
      if (!running) return;
      running.agentName = agent.name;
      void handle(running, letter).catch((error: unknown) => onError(asError(error)));
    },
    async liveSessions(): Promise<LiveSession[]> {
      await recovered;
      return [...runs.keys()].map((sessionId) => ({ sessionId, busy: true }));
    },
    async close(): Promise<void> {
      closed = true;
      const open = [...runs.values()];
      for (const running of open) halt(running, 'closing');
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(open.map((running) => running.done)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
        }),
      ]);
      clearTimeout(timer);
      runs.clear();
      await ownRuntime?.close();
    },
  };
}
