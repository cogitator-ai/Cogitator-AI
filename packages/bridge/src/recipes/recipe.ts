import type { Workflow, WorkflowState } from '@cogitator-ai/types';
import type { z } from 'zod';
import type { Finding } from '../findings.js';
import type { CreateJobInput } from '../inputs.js';
import type { AgentRecord, BridgeJob } from '../types.js';

/** What a run of a recipe ends with, in its state: the words for whoever started it. */
export interface RecipeState extends WorkflowState {
  /** The report of the recipe, once its last step wrote it */
  report?: string;
  /** Set when the recipe could not do what it was started for */
  failed?: boolean;
  /** What the last review of the run found, handed on with the report */
  findings?: Finding[];
}

/** A job a step of a recipe hands over. The bridge adds whose job it is part of. */
export type RecipeJob = Omit<CreateJobInput, 'parent' | 'letterId' | 'recipe'>;

/** How a job a recipe handed over ended. */
export interface RecipeOutcome {
  /** The job as it is now that it is over: its state, its checks, its findings */
  job: BridgeJob;
  /** What its report said, undefined when it ended without one */
  report?: string;
}

/**
 * What the steps of a recipe do through: the bridge, as the conductor of this run. Everything
 * here may be called again after the dispatcher was restarted in the middle of a step, and then
 * goes on where it was instead of doing the same thing twice.
 */
export interface RecipeRun {
  /** The job of the recipe itself: who started it, where, with what */
  readonly job: BridgeJob;
  /** The text the recipe was started with, as its caller wrote it */
  readonly task: string;
  /** The name of the conductor that carries this run out */
  readonly conductor: string;
  /** Aborts when the job of the recipe is over before the recipe is, or the host closes */
  readonly signal: AbortSignal;
  /**
   * Hands a job over as part of the recipe and resolves when that job is over, however it
   * ended, with its checks run. `step` names the hand-over within the run (`work`, `review-2`):
   * the same step asked for again finds the job it handed over the first time, so it must hand
   * over the same text.
   */
  handOver(step: string, job: RecipeJob): Promise<RecipeOutcome>;
  /** The job a step of this run handed over before, undefined when it handed none over yet */
  handedOver(step: string): Promise<BridgeJob | undefined>;
  /** A job by its number */
  lookAt(job: number): Promise<BridgeJob>;
  /** An agent by its name, undefined when the bridge knows none */
  agent(name: string): Promise<AgentRecord | undefined>;
  /** The text a job was handed over with, without what the bridge put under it */
  taskOf(job: BridgeJob): Promise<string>;
  /** The harnesses the bridge can start a session of, the conductor's own aside */
  startable(): Promise<string[]>;
  /**
   * Whether an agent takes a letter by itself right now. A session that would only find it when
   * a person opens it is no one to wait for in a recipe: start a fresh one instead
   */
  wakes(agent: string): Promise<boolean>;
}

/** Runs the steps of a recipe, and goes on from the last finished one after a restart. */
export interface RecipeEngine {
  run<TState extends RecipeState>(workflow: Workflow<TState>): Promise<TState>;
}

/**
 * A recipe as the conductor of the bridge holds it: a name to start it by, a check of what it is
 * started with, and its run. Made with `defineRecipe`.
 */
export interface Recipe {
  readonly name: string;
  /** What it does, in a line, for whoever chooses among recipes */
  readonly summary: string;
  /** What is wrong with what a run would be started with, undefined when it can start */
  problem(input: unknown): string | undefined;
  /** Carries one run out, and resolves with the state its last step left */
  carryOut(input: unknown, run: RecipeRun, engine: RecipeEngine): Promise<RecipeState>;
}

/**
 * What a recipe is written as: steps the conductor of the bridge carries a job out by, with no
 * model deciding what comes next. The steps are the nodes of a workflow of
 * `@cogitator-ai/workflows`, which runs with a checkpoint after every node, so a run goes on from
 * its last finished step when the dispatcher was restarted.
 *
 * A step runs again when the dispatcher stopped in the middle of it. Steps that hand jobs over
 * with `run.handOver` and keep what they learned in the state are safe to run again. Lay the
 * rounds of a recipe out as nodes of their own, one after another (`review-1`, `fix-1`,
 * `review-2`), each of which looks at the state and does nothing when it is not needed, rather
 * than as a loop over one node.
 */
export interface RecipeDefinition<TInput, TState extends RecipeState> {
  /** What the recipe is started by: lower-case letters, digits and `-` */
  name: string;
  summary: string;
  /** Reads what the recipe was started with, and refuses what it cannot work with */
  input: z.ZodType<TInput>;
  /** The steps of one run, laid out for what it was started with */
  workflow(input: TInput, run: RecipeRun): Workflow<TState> | Promise<Workflow<TState>>;
}

const RECIPE_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Makes a recipe of its definition.
 *
 * @example
 * ```ts
 * const twice = defineRecipe({
 *   name: 'twice',
 *   summary: 'The same job to two agents, both answers side by side',
 *   input: z.object({ to: z.array(z.string()).length(2) }),
 *   workflow: (input, run) =>
 *     new WorkflowBuilder<RecipeState & { answers: string[] }>('twice')
 *       .initialState({ answers: [] })
 *       .addNode('first', async ({ state }) => {
 *         const { report } = await run.handOver('first', { to: input.to[0], body: run.task });
 *         return { state: { answers: [...state.answers, report ?? ''] } };
 *       })
 *       .addNode(
 *         'second',
 *         async ({ state }) => {
 *           const { report } = await run.handOver('second', { to: input.to[1], body: run.task });
 *           return { state: { report: [...state.answers, report ?? ''].join('\n\n') } };
 *         },
 *         { after: ['first'] }
 *       )
 *       .build(),
 * });
 * ```
 */
export function defineRecipe<TInput, TState extends RecipeState = RecipeState>(
  definition: RecipeDefinition<TInput, TState>
): Recipe {
  if (!RECIPE_NAME.test(definition.name)) {
    throw new Error(
      `A recipe name is lower-case letters, digits and "-", and "${definition.name}" is not`
    );
  }
  return {
    name: definition.name,
    summary: definition.summary,
    problem(input) {
      const read = definition.input.safeParse(input ?? {});
      if (read.success) return undefined;
      return read.error.issues
        .map((issue) => {
          const at = issue.path.join('.');
          return at ? `${at}: ${issue.message}` : issue.message;
        })
        .join(', ');
    },
    async carryOut(input, run, engine) {
      const workflow = await definition.workflow(definition.input.parse(input ?? {}), run);
      return engine.run(workflow);
    },
  };
}
