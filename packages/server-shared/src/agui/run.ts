import type { AGUIEvent, ContentPart, ResumeEntry, RunAgentInput } from '@ag-ui/core';
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import type {
  ImageInput,
  ResumeOptions,
  RunInterrupt,
  RunOptions,
  RunResult,
} from '@cogitator-ai/types';
import { generateId } from '../helpers.js';
import type { HttpErrorDescription } from '../contract.js';
import { STREAM_CANCELLED } from '../resumable-stream.js';
import type { StreamEvent } from '../protocol.js';
import { AgentStreamSession, type AgentStreamCallbacks } from '../stream-session.js';
import type { ParseResult } from '../validation.js';
import { AGUITranslator, type DelegatedRunTag } from './translator.js';

/** What a run started from an AG-UI request runs with, before the adapter adds the agent and user */
export type AGUIRunOptions = Pick<
  RunOptions,
  'input' | 'images' | 'threadId' | 'brief' | 'state' | 'stream' | 'signal'
> &
  AgentStreamCallbacks;

/** What a resume started from an AG-UI request runs with */
export type AGUIResumeOptions = Pick<ResumeOptions, 'responses' | 'state' | 'stream' | 'signal'> &
  AgentStreamCallbacks;

/**
 * The Cogitator calls an AG-UI run makes, bound by the adapter to the agent, the thread of the
 * request and its caller (user id, deps)
 */
export interface AGUIRunHost {
  run(options: AGUIRunOptions): Promise<RunResult>;
  resume(options: AGUIResumeOptions): Promise<RunResult>;
  /** The questions and approvals the run paused in the thread waits on, see `cogitator.pausedRun()` */
  pausedRun(): Promise<{ interrupts: RunInterrupt[] } | undefined>;
  /** Ends the paused run without going on, see `cogitator.cancelPause()` */
  cancelPause(reason: string): Promise<boolean>;
}

export interface StreamAGUIRunOptions {
  /** The request, as `parseAGUIRunInput()` read it */
  request: AGUIRunRequest;
  host: AGUIRunHost;
  /** Sends one AG-UI event to the client */
  send: (event: AGUIEvent) => void;
  /** Aborted when the client leaves */
  signal: AbortSignal;
  /** The error a failed run reports, as the JSON routes describe it */
  describeError: (error: unknown) => Pick<HttpErrorDescription, 'message' | 'code'>;
  /**
   * Streams the runs the run delegates in the background too, which may outlive it: their events
   * after the run finished are left out. Default false, only the delegated runs the run waits for
   */
  backgroundSubagents?: boolean;
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

type ImageMimeType = (typeof IMAGE_TYPES)[number];

/** What an AG-UI request asks: a new turn with the last user message, or a resume */
export type AGUIRunPlan =
  | { kind: 'run'; input: string; images: ImageInput[]; brief?: string }
  | { kind: 'resume'; resume: ResumeEntry[] };

/** An AG-UI request and what it asks */
export interface AGUIRunRequest {
  input: RunAgentInput;
  plan: AGUIRunPlan;
}

/**
 * Validates the body of an AG-UI request (`RunAgentInput`) and reads what it asks: a resume
 * when it carries `resume` entries, else a new turn with its last message, which must be the
 * user's. The server keeps the conversation in the thread's memory, so the messages before it
 * are not read again
 */
export function parseAGUIRunInput(body: unknown): ParseResult<AGUIRunRequest> {
  const parsed = RunAgentInputSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at "${issue.path.join('.')}"` : '';
    return { ok: false, message: `Invalid AG-UI RunAgentInput${where}: ${issue?.message ?? ''}` };
  }
  const input: RunAgentInput = {
    ...parsed.data,
    tools: parsed.data.tools ?? [],
    context: parsed.data.context ?? [],
  };
  if (input.resume && input.resume.length > 0) {
    return { ok: true, value: { input, plan: { kind: 'resume', resume: input.resume } } };
  }
  const last = input.messages.at(-1);
  if (last?.role !== 'user') {
    return {
      ok: false,
      message: 'An AG-UI run needs a user message last in "messages", or "resume" entries',
    };
  }
  const content = readUserContent(last.content);
  if (!content.ok) return content;
  if (content.value.input.trim() === '' && content.value.images.length === 0) {
    return { ok: false, message: 'The last user message is empty' };
  }
  const brief = input.context
    .map((entry) => `${entry.description}: ${entry.value}`)
    .join('\n')
    .trim();
  return {
    ok: true,
    value: {
      input,
      plan: { kind: 'run', ...content.value, ...(brief !== '' && { brief }) },
    },
  };
}

function readUserContent(
  content: string | ContentPart[]
): ParseResult<{ input: string; images: ImageInput[] }> {
  if (typeof content === 'string') return { ok: true, value: { input: content, images: [] } };
  const texts: string[] = [];
  const images: ImageInput[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      texts.push(part.text);
    } else if (part.type === 'image' && part.source.type === 'url') {
      images.push(part.source.value);
    } else if (
      part.type === 'image' &&
      part.source.type === 'data' &&
      isImageType(part.source.mimeType)
    ) {
      images.push({ data: part.source.value, mimeType: part.source.mimeType });
    } else {
      return {
        ok: false,
        message: `Unsupported content part "${part.type}": a user message takes text and images (URL or JPEG, PNG, GIF, WebP data)`,
      };
    }
  }
  return { ok: true, value: { input: texts.join('\n'), images } };
}

function isImageType(type: string): type is ImageMimeType {
  return IMAGE_TYPES.some((known) => known === type);
}

/**
 * The answers of AG-UI resume entries as `ResumeOptions.responses`, for the interrupts the
 * paused run waits on: an approval resolved with `{ approved, reason? }` or a boolean (no payload
 * approves it), cancelled as declined, a question resolved with its payload. `cancel` when an
 * entry cancels a question, which no answer can stand for: the whole pause ends then
 */
export function resumeResponses(
  entries: readonly ResumeEntry[],
  interrupts: readonly RunInterrupt[]
): ParseResult<{ responses: Record<string, unknown>; cancel: boolean }> {
  const byId = new Map(interrupts.map((entry) => [entry.id, entry]));
  const responses: Record<string, unknown> = {};
  let cancel = false;
  for (const entry of entries) {
    const interrupt = byId.get(entry.interruptId);
    if (!interrupt) {
      return { ok: false, message: `The paused run waits on no interrupt "${entry.interruptId}"` };
    }
    if (interrupt.kind === 'approval') {
      responses[entry.interruptId] =
        entry.status === 'cancelled'
          ? { approved: false, reason: 'cancelled' }
          : decision(entry.payload);
    } else if (entry.status === 'cancelled') {
      cancel = true;
    } else {
      responses[entry.interruptId] = entry.payload;
    }
  }
  return { ok: true, value: { responses, cancel } };
}

function decision(payload: unknown): unknown {
  if (payload === undefined || payload === null) return { approved: true };
  if (typeof payload === 'boolean') return { approved: payload };
  return payload;
}

/**
 * Runs or resumes an agent for an AG-UI request and streams the run as AG-UI events, through an
 * `AgentStreamSession` and an `AGUITranslator`: the run's thread is the AG-UI thread, its state
 * the request's `state`, the runs it delegates its subagents. It never throws: a run that fails
 * ends in `RUN_ERROR`. The server adapters' `POST /agents/:name/agui` routes use it
 */
export async function streamAGUIRun(options: StreamAGUIRunOptions): Promise<void> {
  const { request, host, signal } = options;
  const { input, plan } = request;
  const translator = new AGUITranslator({
    threadId: input.threadId,
    runId: input.runId,
    ...(input.parentRunId !== undefined && { parentRunId: input.parentRunId }),
  });
  const push = (event: StreamEvent | { event: StreamEvent; run: DelegatedRunTag }) => {
    if (signal.aborted) return;
    for (const out of translator.push(event)) options.send(out);
  };
  const session = new AgentStreamSession(push, {
    threadId: input.threadId,
    resetSteps: false,
    ...(input.state !== undefined && input.state !== null && { state: input.state }),
    delegated: (start) => {
      if (start.background && !options.backgroundSubagents) return undefined;
      const run: DelegatedRunTag = {
        id: generateId('sub'),
        agent: start.agent,
        parentToolCallId: start.parentToolCallId,
        background: start.background,
        depth: start.depth,
        ...(start.taskId !== undefined && { taskId: start.taskId }),
      };
      return (event) => push({ event, run });
    },
  });
  const state = input.state ?? undefined;

  try {
    session.start();
    if (plan.kind === 'run') {
      const { input: text, images, brief } = plan;
      session.complete(
        await host.run({
          input: text,
          ...(images.length > 0 && { images }),
          threadId: session.threadId,
          ...(brief !== undefined && { brief }),
          ...(state !== undefined && { state }),
          stream: true,
          signal,
          ...session.callbacks,
        })
      );
      return;
    }
    const paused = await host.pausedRun();
    if (!paused) {
      session.fail(`No run waits in thread ${input.threadId}`, 'NOT_FOUND');
      return;
    }
    const answers = resumeResponses(plan.resume, paused.interrupts);
    if (!answers.ok) {
      session.fail(answers.message, 'INVALID_INPUT');
      return;
    }
    if (answers.value.cancel) {
      await host.cancelPause('cancelled from the client');
      session.fail('The paused run was cancelled', STREAM_CANCELLED);
      return;
    }
    session.complete(
      await host.resume({
        responses: answers.value.responses,
        ...(state !== undefined && { state }),
        stream: true,
        signal,
        ...session.callbacks,
      })
    );
  } catch (error) {
    if (signal.aborted) return;
    const described = options.describeError(error);
    session.fail(described.message, described.code);
  }
}
