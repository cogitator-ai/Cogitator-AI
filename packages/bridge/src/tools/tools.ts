import { tool } from '@cogitator-ai/core';
import type { Tool, ToolAnnotations } from '@cogitator-ai/types';
import { z } from 'zod';
import { BridgeClient } from '../client.js';
import { BridgeError, isBridgeError } from '../errors.js';
import { oneLine } from '../letters.js';
import { NEW_SESSION, aliasOfHarness } from '../registry.js';
import type { JobDiff } from '../inputs.js';
import type { AgentRecord, BridgeJob, CallerIdentity, JobState, Letter } from '../types.js';
import { mailText } from '../waiter.js';
import { callerOfToolCall, type ToolCallOrigin } from './caller.js';

export interface BridgeToolsOptions {
  /** Where the dispatcher of this machine listens, `bridgePaths().socket` */
  socketPath: string;
  /** The environment of the process the tools run in, `process.env` by default */
  env?: NodeJS.ProcessEnv;
  /** The folder the session works in when the call does not say, the current one by default */
  cwd?: string;
  /** How long the dispatcher may take to answer a call, 30 s by default */
  timeoutMs?: number;
}

/** A tool that changes something in the bridge: it adds, never destroys, and stays on this machine. */
const WRITES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const READS: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

const OPEN_STATES: readonly JobState[] = ['submitted', 'working', 'input-required'];

/** How many letters of a job `job` shows, the newest. */
const TRAIL_LETTERS = 10;

/** How much of a patch `diff` shows. */
const DIFF_CHARS = 60_000;

/** How much of one letter `job` shows. The whole letter is in the inbox of who got it. */
const TRAIL_BODY = 4_000;

const JobNumber = z.number().int().positive().describe('The number of the job');

/** An ISO time to the minute, as an agent reads it: `2026-11-16 13:49 UTC`. */
function clock(at: string): string {
  return `${at.slice(0, 16).replace('T', ' ')} UTC`;
}

/** Where the result of a job stands, when the bridge checked it or keeps its work apart. */
function resultOf(job: BridgeJob): string {
  const marks: string[] = [];
  if (job.checking) marks.push('its checks run');
  else if (job.verification) marks.push(job.verification.verified ? 'verified' : 'not verified');
  if (job.worktree) {
    marks.push(job.worktree.end ? `work ${ENDED[job.worktree.end.how]}` : 'work in its worktree');
  }
  return marks.length > 0 ? `  (${marks.join(', ')})` : '';
}

const ENDED = {
  accepted: 'taken',
  branch: 'left as a branch',
  rejected: 'dropped',
  discarded: 'put away',
} as const;

function jobLine(job: BridgeJob): string {
  return `#${job.number} ${job.state}  ${job.from} -> ${job.to}  "${oneLine(job.title)}"${resultOf(job)}`;
}

/** What the bridge knows of the work of a job: its worktree, what was changed there, the checks. */
function workLines(job: BridgeJob): string[] {
  const lines: string[] = [];
  const { worktree, changes, verification } = job;
  if (worktree) {
    const end = worktree.end;
    lines.push(
      end
        ? `Its work was ${ENDED[end.how]}${end.into ? ` into ${end.into}` : ''}${end.ref ? ` (${end.ref})` : ''} ${clock(end.at)}, the worktree is gone`
        : `Done in a worktree of its own: ${worktree.path}, branch ${worktree.branch}`
    );
  } else if (job.isolation === 'worktree') {
    lines.push('It gets a worktree of its own when its session starts');
  }
  if (changes) {
    lines.push(
      `Changed when it reported: ${changes.files} ${changes.files === 1 ? 'file' : 'files'}, +${changes.insertions} -${changes.deletions}`
    );
  }
  if (job.checking) lines.push('Its checks run: the report comes with what they show');
  if (verification?.summary) lines.push(`Checks. ${verification.summary}`);
  return lines;
}

/** One changed file as a line: `M src/a.ts  +3 -1`. */
function fileLine(file: JobDiff['files'][number]): string {
  const mark = file.kind === 'added' ? 'A' : file.kind === 'deleted' ? 'D' : 'M';
  const size = file.insertions === undefined ? 'binary' : `+${file.insertions} -${file.deletions}`;
  return `${mark} ${file.path}  ${size}`;
}

function letterBlock(letter: Letter): string {
  const body =
    letter.body.length > TRAIL_BODY
      ? `${letter.body.slice(0, TRAIL_BODY)}\n[cut here, ${letter.body.length} characters in all]`
      : letter.body;
  const outcome = letter.outcome ? ` (${letter.outcome})` : '';
  return `${clock(letter.createdAt)} ${letter.kind}${outcome} from ${letter.from} to ${letter.to}, letter ${letter.id}:\n${body}`;
}

function agentLine(agent: AgentRecord, self: string | undefined, waiting: boolean): string {
  const notes = [
    agent.name === self ? 'this session' : undefined,
    agent.sessionName ? `"${oneLine(agent.sessionName)}"` : undefined,
    agent.status === 'starting' ? 'starting' : undefined,
    waiting ? 'wakes for mail' : undefined,
  ].filter((note) => note !== undefined);
  return `${agent.name}  ${agent.harness}${notes.length > 0 ? `, ${notes.join(', ')}` : ''}`;
}

const NO_DISPATCHER =
  'No bridge dispatcher runs on this machine, so nothing was sent. Tell the user to start it: cogitator bridge serve';

const NO_SESSION =
  'The bridge cannot tell which session is calling: the call names none, and neither does the environment of the tools. ' +
  'They work inside a session of Claude Code or Codex. Tell the user to check the setup: cogitator bridge doctor';

/**
 * The bridge as tools of an agent: hand a job over, ask and answer on the way, report, and see
 * what goes on. They are what `cogitator bridge mcp` serves to Claude Code and Codex. No tool
 * waits for another agent: each returns at once, and the reply comes later as a letter.
 *
 * Every call says which session makes it (`callerOfToolCall`) and reaches the dispatcher on a
 * connection of its own, so the tools go on working across a restart of the dispatcher and
 * across a change of the session they serve.
 *
 * @example
 * ```ts
 * import { MCPServer } from '@cogitator-ai/mcp';
 * import { bridgePaths } from '@cogitator-ai/bridge';
 * import { BRIDGE_INSTRUCTIONS, bridgeTools } from '@cogitator-ai/bridge/tools';
 *
 * const server = new MCPServer({
 *   name: 'cogitator-bridge',
 *   version: '1.0.0',
 *   transport: 'stdio',
 *   instructions: BRIDGE_INSTRUCTIONS,
 * });
 * server.registerTools(bridgeTools({ socketPath: bridgePaths().socket }));
 * await server.start();
 * ```
 */
export function bridgeTools(options: BridgeToolsOptions): Tool[] {
  const env = options.env ?? process.env;

  function originOf(args: unknown, context: unknown): ToolCallOrigin {
    const request =
      typeof context === 'object' && context !== null && 'request' in context
        ? (context as { request?: unknown }).request
        : undefined;
    const { meta, client } = (typeof request === 'object' && request !== null ? request : {}) as {
      meta?: unknown;
      client?: unknown;
    };
    const name =
      typeof client === 'object' && client !== null && 'name' in client
        ? (client as { name?: unknown }).name
        : undefined;
    return {
      args,
      ...(typeof meta === 'object' && meta !== null && { meta: meta as Record<string, unknown> }),
      ...(typeof name === 'string' && { client: name }),
    };
  }

  /** Runs `work` as the session that made the call, on a connection that lasts for the call. */
  async function asCaller<T>(
    args: unknown,
    context: unknown,
    work: (bridge: BridgeClient, self: AgentRecord) => Promise<T>
  ): Promise<T> {
    let caller: CallerIdentity | undefined;
    let bridge: BridgeClient | undefined;
    try {
      caller = callerOfToolCall(originOf(args, context), env, options.cwd ?? process.cwd());
      if (!caller) throw new Error(NO_SESSION);
      bridge = await BridgeClient.connect({
        socketPath: options.socketPath,
        caller,
        ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
      });
      if (!bridge.agent) {
        throw new BridgeError(
          'not_registered',
          'The bridge did not say which agent this session is'
        );
      }
      return await work(bridge, bridge.agent);
    } catch (error) {
      if (isBridgeError(error) && error.code === 'not_running' && !bridge) {
        throw new Error(NO_DISPATCHER, { cause: error });
      }
      throw error;
    } finally {
      await bridge?.close().catch(() => undefined);
    }
  }

  const delegate = tool({
    name: 'delegate',
    title: 'Hand a job to another agent',
    description:
      'Hand a job to another coding agent on this machine and get its number at once. The agent works in its own session: its questions and its report come back later as letters that wake this session, so end your turn after the call instead of waiting.',
    parameters: z.looseObject({
      to: z
        .string()
        .min(1)
        .describe(
          `Who gets the job: "codex" or "claude" for the session of that agent in this project (one is started when none is open), "codex:${NEW_SESSION}" for a fresh one, or an agent name from the agents tool such as "codex-2@app"`
        ),
      task: z
        .string()
        .min(1)
        .describe(
          'The job: what to do, and what done looks like. The other agent sees nothing of this conversation, so name the files, the constraints and the decisions already made'
        ),
      title: z.string().optional().describe('A short name of the job, its first line by default'),
      cwd: z
        .string()
        .optional()
        .describe("The folder the job is done in, inside this project. This session's by default"),
      parent: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'The job this one is part of, when this session carries out several. Found by itself otherwise'
        ),
      worktree: z
        .boolean()
        .optional()
        .describe(
          'Give the job a git worktree of its own, made from the last commit of your checkout, and a fresh session to work there. Ask for it when the job changes files while you or other agents change files too. What you have not committed is not there. The work comes back with the accept tool'
        ),
      checks: z
        .array(z.string().min(1))
        .max(50)
        .optional()
        .describe(
          'Shell commands that show the job is done, such as the tests of what it touches. When the job is reported on, the bridge runs those your own rules allow without asking, where the job was done, and the report comes with what they showed'
        ),
    }),
    annotations: WRITES,
    sideEffects: ['process'],
    execute: async (args, context) =>
      asCaller(args, context, async (bridge) => {
        const { job, duplicate } = await bridge.createJob({
          to: args.to,
          body: args.task,
          ...(args.title !== undefined && { title: args.title }),
          ...(args.cwd !== undefined && { cwd: args.cwd }),
          ...(args.parent !== undefined && { parent: args.parent }),
          ...(args.worktree !== undefined && { worktree: args.worktree }),
          ...(args.checks !== undefined && {
            checks: args.checks.map((command) => ({ command })),
          }),
        });
        return (
          `Job #${job.number} is with ${job.to} (${job.state})${duplicate ? ', handed over before: nothing was sent twice' : ''}. ` +
          (job.isolation === 'worktree'
            ? 'It is done in a git worktree of its own, off your last commit: its changes come to you with accept. '
            : '') +
          'Its questions and its report arrive as letters. Say in one line what you handed over, then end your turn: do not wait or poll.'
        );
      }),
  });

  const ask = tool({
    name: 'ask',
    title: 'Ask about a job',
    description:
      'Ask the other agent of a job a question: whoever handed you the job, or the agent you handed one to. The answer comes back as a letter that wakes this session, so end your turn after asking.',
    parameters: z.looseObject({
      job: JobNumber,
      question: z
        .string()
        .min(1)
        .describe('The question, with what the other agent needs to answer it'),
    }),
    annotations: WRITES,
    sideEffects: ['external'],
    execute: async (args, context) =>
      asCaller(args, context, async (bridge) => {
        const sent = await bridge.send({ job: args.job, kind: 'question', body: args.question });
        return `Asked ${sent.letter.to}. Job #${sent.job.number} is ${sent.job.state}. End your turn: the answer wakes this session.`;
      }),
  });

  const answer = tool({
    name: 'answer',
    title: 'Answer a question',
    description:
      'Answer a question another agent asked about a job, or decide its permission request. The answer goes to that agent, who does not see this conversation. A permission request takes a decision.',
    parameters: z.looseObject({
      job: JobNumber,
      answer: z
        .string()
        .min(1)
        .optional()
        .describe('The answer to a question, or the reason of a decision'),
      decision: z
        .enum(['allow', 'deny', 'person'])
        .optional()
        .describe(
          'For a permission request: allow or deny the call. person leaves a request or a question to the user, when it is not for you to say'
        ),
      letter: z
        .string()
        .optional()
        .describe(
          'The id of the letter this answers, from its first line. The open question of the job by default'
        ),
    }),
    annotations: WRITES,
    sideEffects: ['external'],
    execute: async (args, context) =>
      asCaller(args, context, async (bridge) => {
        if (args.decision === 'person') {
          const passed = await bridge.escalate(
            args.letter !== undefined ? { letter: args.letter } : { job: args.job }
          );
          return `Left to the user: their answer goes to ${passed.from}. Tell the user in one line that ${passed.from} waits for their word on job #${passed.job}, which they give with "cogitator bridge asks".`;
        }
        const body =
          args.answer ??
          (args.decision === 'allow'
            ? 'Allowed'
            : args.decision === 'deny'
              ? 'Refused'
              : undefined);
        if (body === undefined) {
          throw new BridgeError('invalid_input', 'Say the answer, or the decision');
        }
        const sent = await bridge.send({
          job: args.job,
          kind: 'answer',
          body,
          ...(args.decision !== undefined && { verdict: args.decision }),
          ...(args.letter !== undefined && { inReplyTo: args.letter }),
        });
        const said =
          args.decision === 'allow' ? 'Allowed' : args.decision === 'deny' ? 'Refused' : 'Answered';
        return `${said} ${sent.letter.to}. Job #${sent.job.number} is ${sent.job.state}.`;
      }),
  });

  const report = tool({
    name: 'report',
    title: 'Report on a job',
    description:
      'Report the result of a job that was handed to this session, which ends the job. Whoever handed it over reads only this report, so say what was done, where, and what is left.',
    parameters: z.looseObject({
      job: JobNumber,
      result: z
        .string()
        .min(1)
        .describe(
          'What was done: the outcome, the files touched, how it was checked, what is left open'
        ),
      failed: z
        .boolean()
        .optional()
        .describe('True when the job could not be done. The result then says why'),
    }),
    annotations: WRITES,
    sideEffects: ['external'],
    execute: async (args, context) =>
      asCaller(args, context, async (bridge) => {
        const sent = await bridge.send({
          job: args.job,
          kind: 'report',
          body: args.result,
          ...(args.failed && { outcome: 'failed' as const }),
        });
        return `Reported to ${sent.letter.to}. Job #${sent.job.number} is ${sent.job.state}.`;
      }),
  });

  const note = tool({
    name: 'note',
    title: 'Send a note on a job',
    description:
      'Tell the other agent of a job something it should know and need not answer: progress, a finding, a change of plan. The job goes on.',
    parameters: z.looseObject({
      job: JobNumber,
      text: z.string().min(1).describe('What the other agent should know'),
    }),
    annotations: WRITES,
    sideEffects: ['external'],
    execute: async (args, context) =>
      asCaller(args, context, async (bridge) => {
        const sent = await bridge.send({ job: args.job, kind: 'note', body: args.text });
        return `Sent the note to ${sent.letter.to}. Job #${sent.job.number} is ${sent.job.state}.`;
      }),
  });

  const inbox = tool({
    name: 'inbox',
    title: 'Read the letters that wait',
    description:
      'Read the letters that wait for this session, each under the line that says which job it is about and who wrote it. Letters usually arrive by themselves: use this when nothing woke the session, or for a letter too long to be handed over whole.',
    parameters: z.looseObject({
      job: z.number().int().positive().optional().describe('Only the letters of one job'),
      peek: z.boolean().optional().describe('Look without taking: the letters stay as they are'),
      unhandled: z
        .boolean()
        .optional()
        .describe('Also the letters read before and not answered since'),
    }),
    annotations: WRITES,
    sideEffects: [],
    execute: async (args, context) =>
      asCaller(args, context, async (bridge) => {
        const letters = await bridge.inbox({
          ...(args.job !== undefined && { job: args.job }),
          ...(args.peek && { peek: true }),
          ...(args.unhandled && { unhandled: true }),
        });
        return letters.length === 0 ? 'No letters wait for this session.' : mailText(letters);
      }),
  });

  const job = tool({
    name: 'job',
    title: 'Look at a job',
    description:
      'See one job: its state, who handed it to whom, and for a job of this session its latest letters. Reads only, takes nothing from the inbox.',
    parameters: z.looseObject({ job: JobNumber }),
    annotations: READS,
    sideEffects: [],
    execute: async (args, context) =>
      asCaller(args, context, async (bridge, self) => {
        const found = await bridge.job(args.job);
        const lines = [
          jobLine(found),
          `Handed over ${clock(found.createdAt)}, last change ${clock(found.updatedAt)}, folder ${found.cwd}`,
        ];
        if (found.reason) lines.push(`Reason: ${found.reason}`);
        if (found.parent !== undefined) lines.push(`Part of job #${found.parent}`);
        lines.push(...workLines(found));
        if (found.from !== self.name && found.to !== self.name) {
          lines.push('Its letters are between its two agents: this session is neither.');
          return lines.join('\n');
        }
        const trail = await bridge.letters({
          job: found.number,
          newestFirst: true,
          limit: TRAIL_LETTERS,
        });
        if (trail.length > 0) {
          lines.push('', ...trail.reverse().map((letter) => letterBlock(letter)));
        }
        return lines.join('\n');
      }),
  });

  const jobs = tool({
    name: 'jobs',
    title: 'List the jobs of this session',
    description:
      'List the jobs this session handed over or carries out: those in progress, or all of them.',
    parameters: z.looseObject({
      all: z.boolean().optional().describe('Also the jobs that are over, the newest first'),
    }),
    annotations: READS,
    sideEffects: [],
    execute: async (args, context) =>
      asCaller(args, context, async (bridge, self) => {
        const found = await bridge.jobs({
          party: self.name,
          ...(!args.all && { states: OPEN_STATES }),
          limit: 50,
        });
        if (found.length === 0) {
          return args.all ? 'This session has no jobs.' : 'This session has no jobs in progress.';
        }
        return found.map((entry) => jobLine(entry)).join('\n');
      }),
  });

  const cancel = tool({
    name: 'cancel',
    title: 'Take a job back',
    description:
      'Take back a job this session handed over. The agent that worked on it is told to stop, and what it did so far stays where it is.',
    parameters: z.looseObject({
      job: JobNumber,
      reason: z.string().optional().describe('Why, for the agent that worked on it'),
    }),
    annotations: WRITES,
    sideEffects: ['process'],
    execute: async (args, context) =>
      asCaller(args, context, async (bridge) => {
        const canceled = await bridge.cancel(args.job, args.reason?.trim() || undefined);
        return `Job #${canceled.number} is ${canceled.state}, ${canceled.to} is told.`;
      }),
  });

  const diff = tool({
    name: 'diff',
    title: 'See what a job changed',
    description:
      'See what a job changed in the git worktree it was given: the files, how much, and the patch. Works while the job runs and after, until its work is taken or dropped. Reads only.',
    parameters: z.looseObject({
      job: JobNumber,
      paths: z
        .array(z.string().min(1))
        .max(200)
        .optional()
        .describe('Only these files, paths from the top of the repository'),
      filesOnly: z.boolean().optional().describe('The list of files without the patch'),
    }),
    annotations: READS,
    sideEffects: [],
    execute: async (args, context) =>
      asCaller(args, context, async (bridge) => {
        const found = await bridge.diff({
          job: args.job,
          ...(args.paths !== undefined && { paths: args.paths }),
          maxChars: args.filesOnly ? 0 : DIFF_CHARS,
        });
        if (found.files.length === 0) {
          return `Job #${found.job} changed nothing in its worktree, ${found.worktree}.`;
        }
        const lines = [
          `Job #${found.job} changed ${found.files.length} ${found.files.length === 1 ? 'file' : 'files'}, +${found.insertions} -${found.deletions}, in ${found.worktree} (branch ${found.branch}, since commit ${found.base.slice(0, 10)}):`,
          ...found.files.map(fileLine),
        ];
        if (!args.filesOnly) {
          lines.push('', found.patch.trimEnd());
          if (found.truncated) {
            lines.push(
              `[cut here: the patch is longer. Ask for some files with paths, or read them in ${found.worktree}]`
            );
          }
        }
        return lines.join('\n');
      }),
  });

  const accept = tool({
    name: 'accept',
    title: 'Take the work of a job',
    description:
      'Take what a finished job changed in its git worktree into the checkout this session works in. The changes arrive as one change that is staged and not committed: look at it and commit it yourself. When files would conflict nothing is touched and the answer names them. The worktree is removed. Only for a job this session handed over.',
    parameters: z.looseObject({
      job: JobNumber,
      asBranch: z
        .union([z.boolean(), z.string().min(1)])
        .optional()
        .describe(
          'Leave the work as a branch instead of bringing it into your checkout, for a change that goes on as a pull request: true for the branch of the worktree, or the name the branch is to have'
        ),
    }),
    annotations: WRITES,
    sideEffects: ['filesystem', 'process'],
    execute: async (args, context) =>
      asCaller(args, context, async (bridge) => {
        const taken = await bridge.accept({
          job: args.job,
          ...(args.asBranch !== undefined && { asBranch: args.asBranch }),
        });
        switch (taken.state) {
          case 'accepted':
            return `The work of job #${args.job} is in ${taken.into}: ${taken.files} ${taken.files === 1 ? 'file' : 'files'}, +${taken.insertions} -${taken.deletions}, staged and not committed. Look at it with git diff --cached and commit it yourself. The worktree is gone.`;
          case 'branch':
            return `The work of job #${args.job} is the branch ${taken.branch}, at commit ${taken.commit.slice(0, 10)}. Your checkout is as it was, and the worktree is gone.`;
          case 'nothing':
            return `Job #${args.job} changed nothing: there was nothing to take, and its worktree is gone.`;
          case 'conflict':
            return `Nothing was taken: the work of job #${args.job} would leave ${taken.files.length === 1 ? 'this file' : 'these files'} of ${taken.into} in conflict: ${taken.files.join(', ')}. Its worktree is still there. Take it as a branch and merge it by hand, hand over a job that brings it up to date, or drop it with reject.`;
        }
      }),
  });

  const reject = tool({
    name: 'reject',
    title: 'Drop the work of a job',
    description:
      'Drop what a finished job changed in its git worktree: the worktree and its branch are removed with everything in them, and nothing reaches your checkout. Only for a job this session handed over. It cannot be undone.',
    parameters: z.looseObject({
      job: JobNumber,
      reason: z.string().optional().describe('Why, for the journal'),
    }),
    annotations: { ...WRITES, destructiveHint: true },
    sideEffects: ['filesystem', 'process'],
    execute: async (args, context) =>
      asCaller(args, context, async (bridge) => {
        const dropped = await bridge.reject({
          job: args.job,
          ...(args.reason?.trim() && { reason: args.reason.trim() }),
        });
        return `The work of job #${dropped.number} is dropped, and its worktree is gone.`;
      }),
  });

  const agents = tool({
    name: 'agents',
    title: 'See who can take a job',
    description:
      'List the sessions of coding agents the bridge knows in this project, and the agents it can start a session of. Their names are what delegate takes.',
    parameters: z.looseObject({}),
    annotations: READS,
    sideEffects: [],
    execute: async (args, context) =>
      asCaller(args, context, async (bridge, self) => {
        const [known, status] = await Promise.all([
          bridge.agents({ project: self.project, statuses: ['active', 'starting'] }),
          bridge.status(),
        ]);
        const lines = known.map((agent) =>
          agentLine(agent, self.name, status.waiting.includes(agent.name))
        );
        const startable = status.startable.map((harness) => aliasOfHarness(harness));
        lines.push(
          '',
          startable.length > 0
            ? `The bridge starts a session for a job handed to: ${startable.join(', ')} (when none is open in this project, or with ":${NEW_SESSION}" after the word)`
            : 'The bridge cannot start sessions here: a job goes to a session that is listed above'
        );
        return lines.join('\n');
      }),
  });

  return [
    delegate,
    ask,
    answer,
    report,
    note,
    inbox,
    job,
    jobs,
    cancel,
    diff,
    accept,
    reject,
    agents,
  ] as Tool[];
}
