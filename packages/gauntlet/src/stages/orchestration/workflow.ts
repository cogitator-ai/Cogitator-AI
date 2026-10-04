import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, tool } from '@cogitator-ai/core';
import type { ApprovalRequest, TimerEntry, WorkflowRun } from '@cogitator-ai/types';
import {
  PostgresApprovalStore,
  PostgresCheckpointStore,
  PostgresRunStore,
  PostgresTimerStore,
  WITHDRAWN,
  WorkflowBuilder,
  agentNode,
  approvalNode,
  createWorkflowManager,
  delayNode,
  humanWorkflowNode,
  timerWorkflowNode,
  type DefaultWorkflowManager,
} from '@cogitator-ai/workflows';
import type pg from 'pg';
import { z } from 'zod';
import type { StageContext, StageDefinition } from '../../runner/types.js';
import { CORE, WORKFLOWS, deferred, excerpt, postgresPool, uniqueName, within } from './shared.js';

type ArticleState = {
  topic: string;
  notes?: string;
  researchTools?: string[];
  headline?: string;
  body?: string;
  approved?: boolean;
  editorNote?: string;
  slug?: string;
  publishedPath?: string;
  spiked?: boolean;
};

const Draft = z.object({
  headline: z.string().min(5),
  body: z.string().min(80),
});

const Review = z.object({
  approve: z.boolean(),
  note: z.string(),
});

const EMBARGO_MS = 1_500;
const EDITOR = 'bot-editor';

/** A tool whose answer only the archive knows, so its use shows up in the research notes. */
const archive = tool({
  name: 'newsroom_archive',
  description: 'What the newsroom already published on a topic, and what readers asked about it.',
  parameters: z.object({ topic: z.string().describe('The article topic') }),
  execute: async ({ topic }) => ({
    topic,
    previousArticles: 2,
    lastPublished: '2026-03-14',
    readerQuestion: 'What changes for ordinary people this year?',
  }),
});

/** Every table one workflow stage creates, under one unique prefix. */
interface WorkflowTables {
  runs: string;
  checkpoints: string;
  approvals: string;
  timers: string;
}

function workflowTables(ctx: StageContext, pool: pg.Pool, label: string): WorkflowTables {
  const prefix = uniqueName(label);
  const tables = {
    runs: `${prefix}_runs`,
    checkpoints: `${prefix}_checkpoints`,
    approvals: `${prefix}_approvals`,
    timers: `${prefix}_timers`,
  };
  ctx.onCleanup(async () => {
    const names = [
      tables.runs,
      tables.checkpoints,
      `${tables.approvals}_requests`,
      `${tables.approvals}_responses`,
      tables.timers,
    ];
    await pool.query(`DROP TABLE IF EXISTS ${names.join(', ')}`);
  });
  return tables;
}

/** The workflow stores on one connection pool, as one process would hold them. */
function workflowStores(ctx: StageContext, pool: pg.Pool, tables: WorkflowTables) {
  const approvals = new PostgresApprovalStore({
    client: pool,
    tablePrefix: tables.approvals,
    pollInterval: 250,
  });
  ctx.onCleanup(() => approvals.dispose());
  return {
    runs: new PostgresRunStore({ client: pool, table: tables.runs }),
    checkpoints: new PostgresCheckpointStore({ client: pool, table: tables.checkpoints }),
    approvals,
    timers: new PostgresTimerStore({ client: pool, table: tables.timers }),
  };
}

/** Resolves with the run once the manager reports it finished. */
function finishedRun(
  manager: DefaultWorkflowManager,
  runId: () => string | undefined
): Promise<WorkflowRun> {
  const done = deferred<WorkflowRun>();
  manager.onRunStateChange((run) => {
    if (run.id !== runId()) return;
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      done.resolve(run);
    }
  });
  return done.promise;
}

/** Cancels the run when the stage is cancelled, until the returned function is called. */
function cancelOnAbort(
  ctx: StageContext,
  manager: DefaultWorkflowManager,
  runId: () => string | undefined
) {
  const cancel = () => {
    const id = runId();
    if (id) void manager.cancel(id).catch(() => {});
  };
  ctx.signal.addEventListener('abort', cancel, { once: true });
  return () => ctx.signal.removeEventListener('abort', cancel);
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'article'
  );
}

/**
 * Research, draft, embargo timer, editor approval and publish, run by the workflow manager on
 * Postgres stores. The run is paused while it waits for the editor, then resumed from its
 * checkpoint, and the bot editor answers through the approval store of another connection.
 */
const workflowNewsroom: StageDefinition = {
  id: 'workflow-newsroom',
  title: 'Workflow: draft, approve, publish',
  description:
    'A durable article workflow on Postgres stores pauses at the editor approval, resumes from its checkpoint without redoing the agents, and publishes once a bot editor approves.',
  packages: [WORKFLOWS, CORE],
  needs: ['swarm-topic'],
  requires: [{ kind: 'service', name: 'postgres' }],
  timeoutMs: 240_000,
  async run(ctx) {
    const topic = ctx.artifacts.get('orchestrationTopic');
    const pool = postgresPool(ctx);
    const tables = workflowTables(ctx, pool, 'newsroom');
    const stores = workflowStores(ctx, pool, tables);
    const desk = workflowStores(ctx, postgresPool(ctx), tables);
    const articles = join(ctx.tmpDir, 'articles');

    const researcher = new Agent({
      name: 'research',
      model: ctx.models[2] ?? ctx.model,
      instructions:
        'You research stories for a newsroom. Always call newsroom_archive first, then list three short factual angles as bullet points.',
      tools: [archive],
      maxIterations: 4,
    });
    const writer = new Agent({
      name: 'draft',
      model: ctx.model,
      instructions:
        'You write short news articles (about 120 words) from research notes, with a plain headline.',
      responseFormat: { type: 'json_schema', schema: Draft },
      maxIterations: 2,
    });
    const editor = new Agent({
      name: 'bot-editor',
      model: ctx.models[1] ?? ctx.model,
      instructions:
        'You are the duty editor of a fast news desk. Facts were already checked by the research desk. Approve a draft that is on topic and readable, reject one that is off topic or garbled. Keep the note to one sentence.',
      responseFormat: { type: 'json_schema', schema: Review },
      maxIterations: 2,
    });

    const workflow = new WorkflowBuilder<ArticleState>('newsroom-article')
      .initialState({ topic: '' })
      .addNode(
        'research',
        agentNode<ArticleState>(researcher, {
          inputMapper: (state) => `Research the topic "${state.topic}" for a short news article.`,
          stateMapper: (result) => ({
            notes: result.output,
            researchTools: result.toolCalls.map((call) => call.name),
          }),
        })
      )
      .addNode(
        'draft',
        agentNode<ArticleState>(writer, {
          inputMapper: (state) => `Topic: ${state.topic}\n\nResearch notes:\n${state.notes ?? ''}`,
          stateMapper: (result) => Draft.parse(result.structured),
        }),
        { after: ['research'] }
      )
      .addNode(
        'embargo',
        timerWorkflowNode<ArticleState>(delayNode('embargo', EMBARGO_MS, { persist: true }), {
          timerStore: stores.timers,
        }),
        { after: ['draft'] }
      )
      .addNode(
        'editor-review',
        humanWorkflowNode<ArticleState>(
          approvalNode<ArticleState>('editor-review', {
            title: 'Approve the article for publication',
            description: (state) => `${state.headline ?? ''}\n\n${state.body ?? ''}`,
            assignee: EDITOR,
            priority: 'high',
          }),
          {
            approvalStore: stores.approvals,
            stateMapper: (result) => ({
              approved: result.approved,
              editorNote: result.response.comment,
            }),
          }
        ),
        { after: ['embargo'] }
      )
      .addConditional('route', (state) => (state.approved ? 'publish' : 'spike'), {
        after: ['editor-review'],
      })
      .addNode(
        'publish',
        async ({ state }) => {
          const slug = slugify(state.headline ?? state.topic);
          const path = join(articles, `${slug}.md`);
          await mkdir(articles, { recursive: true });
          await writeFile(path, `# ${state.headline ?? ''}\n\n${state.body ?? ''}\n`);
          return { state: { slug, publishedPath: path }, output: { slug } };
        },
        { after: ['route'] }
      )
      .addNode('spike', async () => ({ state: { spiked: true } }), { after: ['route'] })
      .build();

    const manager = createWorkflowManager({
      cogitator: ctx.cogitator,
      runStore: stores.runs,
      checkpointStore: stores.checkpoints,
    });
    ctx.onCleanup(() => manager.dispose());

    let runId: string | undefined;
    const detach = cancelOnAbort(ctx, manager, () => runId);
    ctx.onCleanup(detach);

    const firstStarts: string[] = [];
    const requests: ApprovalRequest[] = [];
    let pausing: Promise<void> | undefined;
    let pauseError: unknown;

    const first = await ctx.check(
      'the run researches, drafts and pauses at the editor desk',
      async (evidence) => {
        const result = await manager.execute(
          workflow,
          { topic },
          {
            tags: ['gauntlet'],
            onNodeStart: (node) => firstStarts.push(node),
            onApprovalRequired: (request) => {
              requests.push(request);
              runId = request.workflowId;
              pausing ??= manager.pause(request.workflowId).catch((error: unknown) => {
                pauseError = error;
              });
            },
          }
        );
        await pausing;
        runId = result.workflowId;
        evidence('runId', runId);
        evidence('nodesStarted', firstStarts);
        evidence('error', result.error?.message);
        evidence('headline', result.state.headline);
        evidence('researchTools', result.state.researchTools);
        if (!pausing) throw new Error('The run never asked for an approval');
        if (pauseError) throw pauseError;
        if (!result.error?.message.includes('paused')) {
          throw new Error(
            `Expected the run to stop as paused, got: ${result.error?.message ?? 'no error'}`
          );
        }
        if (!result.state.researchTools?.includes('newsroom_archive')) {
          throw new Error('The research agent did not call newsroom_archive');
        }
        if (!result.state.headline || !result.state.body) throw new Error('The draft is missing');
        return result;
      }
    );
    const pausedRunId = first.workflowId;

    await ctx.check('the paused run and its checkpoints are in Postgres', async (evidence) => {
      const run = await desk.runs.get(pausedRunId);
      const rows = await pool.query(
        `SELECT count(*)::int AS n FROM ${tables.checkpoints} WHERE workflow_name = $1`,
        [workflow.name]
      );
      const checkpoint = run?.checkpointId ? await desk.checkpoints.load(run.checkpointId) : null;
      evidence('status', run?.status);
      evidence('checkpointRows', rows.rows[0]?.n);
      evidence('checkpointNodes', checkpoint?.completedNodes);
      if (run?.status !== 'paused') throw new Error(`Run status is ${run?.status ?? 'missing'}`);
      if (!checkpoint) throw new Error('The run has no stored checkpoint');
      const expected = ['research', 'draft', 'embargo'];
      const missing = expected.filter((node) => !checkpoint.completedNodes.includes(node));
      if (missing.length) throw new Error(`Checkpoint lacks ${missing.join(', ')}`);
      if (checkpoint.completedNodes.includes('editor-review')) {
        throw new Error('The unanswered approval is recorded as completed');
      }
    });

    await ctx.check('pausing withdraws the open approval request', async (evidence) => {
      const request = requests[0];
      if (!request) throw new Error('No approval request was raised');
      const response = await desk.approvals.getResponse(request.id);
      const pending = await desk.approvals.getPendingRequests(pausedRunId);
      evidence('requestId', request.id);
      evidence('respondedBy', response?.respondedBy);
      evidence('pending', pending.length);
      if (response?.respondedBy !== WITHDRAWN) {
        throw new Error(
          `The request was not withdrawn (answer: ${response?.respondedBy ?? 'none'})`
        );
      }
      if (pending.some((open) => open.id === request.id)) {
        throw new Error('The withdrawn request is still pending');
      }
    });

    await ctx.check('the embargo timer is persisted and fired', async (evidence) => {
      const entries: TimerEntry[] = await desk.timers.getByRun(pausedRunId);
      evidence(
        'timers',
        entries.map((entry) => ({
          node: entry.nodeId,
          fired: entry.fired,
          delayMs: entry.firesAt - entry.createdAt,
        }))
      );
      const embargo = entries.find((entry) => entry.nodeId === 'embargo');
      if (!embargo) throw new Error('No persisted timer for the embargo node');
      if (!embargo.fired || embargo.cancelled) throw new Error('The embargo timer did not fire');
    });

    const resumedStarts: string[] = [];
    const finished = finishedRun(manager, () => pausedRunId);
    const editorFailed = deferred<never>();
    let verdict: z.infer<typeof Review> | undefined;

    const review = async (request: ApprovalRequest) => {
      requests.push(request);
      const run = await ctx.cogitator.run(editor, {
        input: `Review this article about "${topic}":\n\n${request.description ?? ''}`,
        signal: ctx.signal,
      });
      verdict = Review.parse(run.structured);
      await desk.approvals.submitResponse({
        requestId: request.id,
        decision: verdict.approve,
        respondedBy: EDITOR,
        respondedAt: Date.now(),
        comment: verdict.note,
      });
    };

    const run = await ctx.check(
      'the resumed run gets the bot editor answer and finishes',
      async (evidence) => {
        await manager.resume(pausedRunId, {
          onNodeStart: (node) => resumedStarts.push(node),
          onApprovalRequired: (request) => {
            review(request).catch((error: unknown) => editorFailed.reject(error));
          },
        });
        const done = await within(
          Promise.race([finished, editorFailed.promise]),
          150_000,
          'the resumed run to finish'
        );
        evidence('status', done.status);
        evidence('nodesStarted', resumedStarts);
        evidence('verdict', verdict);
        if (done.status !== 'completed') {
          throw new Error(`Run ended ${done.status}: ${done.error?.message ?? ''}`);
        }
        return done;
      }
    );

    await ctx.check('resuming skips the nodes that already finished', (evidence) => {
      const redone = ['research', 'draft', 'embargo'].filter((node) =>
        resumedStarts.includes(node)
      );
      evidence('firstRun', firstStarts);
      evidence('resumed', resumedStarts);
      if (redone.length) throw new Error(`Resume ran ${redone.join(', ')} again`);
      if (!resumedStarts.includes('editor-review'))
        throw new Error('Resume did not reach the editor');
    });

    await ctx.check('the editor decision travels through the approval store', async (evidence) => {
      const request = requests[1];
      if (!request) throw new Error('The resumed run raised no approval request');
      const response = await stores.approvals.getResponse(request.id);
      const state = run.state as ArticleState;
      evidence('respondedBy', response?.respondedBy);
      evidence('decision', response?.decision);
      evidence('note', response?.comment);
      if (response?.respondedBy !== EDITOR)
        throw new Error('The answer is not from the bot editor');
      if (state.approved !== response.decision) {
        throw new Error(
          `State says approved=${String(state.approved)}, the editor said ${String(response.decision)}`
        );
      }
    });

    await ctx.check('the article goes the way the editor decided', async (evidence) => {
      const state = run.state as ArticleState;
      evidence('approved', state.approved);
      evidence('completedNodes', run.completedNodes);
      if (state.approved) {
        if (!state.publishedPath) throw new Error('Approved, but nothing was published');
        const article = await readFile(state.publishedPath, 'utf8');
        evidence('slug', state.slug);
        evidence('article', excerpt(article));
        if (!article.includes(state.headline ?? '\u0000'))
          throw new Error('The published file lacks the headline');
      } else {
        evidence('editorNote', state.editorNote);
        if (!state.spiked || state.publishedPath)
          throw new Error('A rejected article was not spiked');
      }
    });
  },
};

type EmbargoState = {
  releasedAt?: number;
};

/**
 * A persisted timer interrupted by a pause must keep waiting after resume. LLM-free, so it
 * isolates the timer and checkpoint mechanics.
 */
const workflowTimerPause: StageDefinition = {
  id: 'workflow-timer-pause',
  title: 'Workflow: embargo survives a pause',
  description:
    'A run paused during a persisted timer and resumed from its Postgres checkpoint still honours the original embargo time.',
  packages: [WORKFLOWS],
  requires: [{ kind: 'service', name: 'postgres' }],
  timeoutMs: 60_000,
  async run(ctx) {
    const embargoMs = 3_000;
    const pool = postgresPool(ctx);
    const tables = workflowTables(ctx, pool, 'embargo');
    const stores = workflowStores(ctx, pool, tables);

    const workflow = new WorkflowBuilder<EmbargoState>('embargo-release')
      .initialState({})
      .addNode('prepare', async () => ({ output: 'ready' }))
      .addNode(
        'embargo',
        timerWorkflowNode<EmbargoState>(delayNode('embargo', embargoMs, { persist: true }), {
          timerStore: stores.timers,
        }),
        { after: ['prepare'] }
      )
      .addNode('release', async () => ({ state: { releasedAt: Date.now() } }), {
        after: ['embargo'],
      })
      .build();

    const manager = createWorkflowManager({
      cogitator: ctx.cogitator,
      runStore: stores.runs,
      checkpointStore: stores.checkpoints,
    });
    ctx.onCleanup(() => manager.dispose());

    const scheduled = deferred<TimerEntry>();
    let runId: string | undefined;
    ctx.onCleanup(cancelOnAbort(ctx, manager, () => runId));

    const timer = await ctx.check(
      'pausing mid-embargo cancels the persisted timer',
      async (evidence) => {
        const execution = manager.execute(
          workflow,
          {},
          {
            onTimerScheduled: (entry) => scheduled.resolve(entry),
          }
        );
        const entry = await within(scheduled.promise, 10_000, 'the embargo timer to be scheduled');
        runId = entry.runId;
        await new Promise((resolve) => setTimeout(resolve, 500));
        await manager.pause(entry.runId);
        const result = await execution;
        const stored = await stores.timers.get(entry.id);
        const run = await stores.runs.get(entry.runId);
        evidence('runStatus', run?.status);
        evidence('timer', { cancelled: stored?.cancelled, fired: stored?.fired });
        evidence('error', result.error?.message);
        if (run?.status !== 'paused') throw new Error(`Run status is ${run?.status ?? 'missing'}`);
        if (!stored?.cancelled)
          throw new Error('The persisted timer was not cancelled by the pause');
        return entry;
      }
    );

    await ctx.check('the embargo still holds after resume', async (evidence) => {
      const finished = finishedRun(manager, () => timer.runId);
      const resumedAt = Date.now();
      await manager.resume(timer.runId);
      const run = await within(finished, embargoMs + 20_000, 'the resumed run to finish');
      const checkpoint = run.checkpointId ? await stores.checkpoints.load(run.checkpointId) : null;
      const releasedAt = (run.state as EmbargoState).releasedAt;
      evidence('status', run.status);
      evidence('embargoEndsInMsAtResume', timer.firesAt - resumedAt);
      evidence(
        'releasedEarlyByMs',
        releasedAt === undefined ? undefined : timer.firesAt - releasedAt
      );
      evidence('checkpointNodes', checkpoint?.completedNodes);
      evidence('embargoOutput', checkpoint?.nodeResults.embargo);
      if (run.status !== 'completed' || releasedAt === undefined) {
        throw new Error(`Run ended ${run.status}`);
      }
      if (releasedAt < timer.firesAt) {
        throw new Error(
          `Released ${timer.firesAt - releasedAt} ms before the embargo ended: the interrupted timer was checkpointed as completed and resume skipped the rest of the wait`
        );
      }
    });
  },
};

export const workflowStages: StageDefinition[] = [workflowNewsroom, workflowTimerPause];
