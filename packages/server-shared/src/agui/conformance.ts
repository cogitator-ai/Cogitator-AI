import { EventSchema } from '@ag-ui/core/schemas';
import { EventType, type AGUIEvent, type RunAgentInput } from '@ag-ui/core';
import type { ResumeOptions, RunInterrupt, RunOptions, RunResult } from '@cogitator-ai/types';
import {
  CONFORMANCE_NAMES,
  ConformanceRuntime,
  conformancePausedResult,
  conformanceRunResult,
  type ConformanceResponse,
  type ConformanceSend,
} from '../conformance.js';

/** The thread every AG-UI conformance request runs in */
export const AGUI_CONFORMANCE_THREAD = 'agui-thread-1';

const QUESTION: RunInterrupt = {
  id: 'q1',
  kind: 'input',
  reason: 'pick_size',
  message: 'Which size?',
  toolCallId: 'call_ask',
  toolName: 'ask_size',
  responseSchema: { type: 'string' },
};

/**
 * Stands in for a `Cogitator` in the AG-UI conformance of an adapter: a streamed run writes text,
 * calls a tool that changes the state and pauses on a question, the resume answers it with a
 * tool result, a data part and text. It records every run, resume and cancelled pause
 */
export class AGUIConformanceRuntime extends ConformanceRuntime {
  readonly aguiRuns: RunOptions[] = [];
  readonly aguiResumes: Array<ResumeOptions & { threadId: string }> = [];
  readonly cancelled: string[] = [];
  private paused: RunInterrupt[] | undefined;

  override run(_agent: unknown, options: RunOptions): Promise<RunResult> {
    this.aguiRuns.push(options);
    const threadId = options.threadId ?? AGUI_CONFORMANCE_THREAD;
    options.onToken?.('Checking sizes. ');
    options.onToolCall?.({ id: 'call_ask', name: 'ask_size', arguments: {} });
    options.onState?.({ cart: ['shirt'] });
    this.paused = [QUESTION];
    return Promise.resolve({
      ...conformancePausedResult(threadId),
      reasoning: undefined,
      pendingApprovals: [],
      interrupts: [QUESTION],
    });
  }

  override resume(_agent: unknown, threadId: string, options: ResumeOptions): Promise<RunResult> {
    this.aguiResumes.push({ ...options, threadId });
    this.paused = undefined;
    const size = options.responses?.[QUESTION.id];
    options.onToolResult?.({ callId: 'call_ask', name: 'ask_size', result: size });
    options.onData?.({ id: 'order', name: 'order', data: { size } });
    options.onToken?.(`Ordered size ${String(size)}.`);
    return Promise.resolve({
      ...conformanceRunResult(threadId),
      reasoning: undefined,
      structured: undefined,
    });
  }

  pausedRun(_threadId: string): Promise<{ runId: string; interrupts: RunInterrupt[] } | undefined> {
    return Promise.resolve(this.paused && { runId: 'run_1', interrupts: this.paused });
  }

  cancelPause(_threadId: string, options: { reason?: string } = {}): Promise<boolean> {
    this.cancelled.push(options.reason ?? '');
    const had = this.paused !== undefined;
    this.paused = undefined;
    return Promise.resolve(had);
  }
}

/** The body of an AG-UI request of the conformance: a new turn, or the resume of the question */
export function aguiConformanceInput(resume?: string): RunAgentInput {
  return {
    threadId: AGUI_CONFORMANCE_THREAD,
    runId: resume === undefined ? 'agui-run-1' : 'agui-run-2',
    state: { cart: [] },
    messages: [{ id: 'u1', role: 'user', content: 'Order a shirt' }],
    tools: [],
    context: [{ description: 'Locale', value: 'en-GB' }],
    ...(resume !== undefined && {
      resume: [{ interruptId: QUESTION.id, status: 'resolved', payload: resume }],
    }),
  };
}

/** The AG-UI events of an SSE answer, each checked against the AG-UI schema */
export function parseAGUIEvents(body: string): AGUIEvent[] {
  const events: AGUIEvent[] = [];
  for (const block of body.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data) events.push(EventSchema.parse(JSON.parse(data)));
  }
  return events;
}

const path = (agent: string) => `/agents/${agent}/agui`;

function post(send: ConformanceSend, agent: string, body: unknown): Promise<ConformanceResponse> {
  return send({
    method: 'POST',
    path: path(agent),
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
}

/**
 * Sends an adapter the requests of the AG-UI route (`POST /agents/:name/agui`) and checks its
 * answers: a run that streams AG-UI events and ends paused on the question, the resume that
 * answers it, a body that is not a `RunAgentInput` (400) and an unknown agent (404). The
 * problems found, none for an adapter that conforms
 */
export async function runAGUIConformance(
  runtime: AGUIConformanceRuntime,
  send: ConformanceSend,
  options: {
    /** The statuses the adapter answers instead, by the status of the contract, such as `{ 400: 422 }` */
    statuses?: Readonly<Record<number, number>>;
  } = {}
): Promise<string[]> {
  const problems: string[] = [];
  const status = (expected: number) => options.statuses?.[expected] ?? expected;
  const check = (ok: boolean, problem: string) => {
    if (!ok) problems.push(problem);
  };

  const first = await post(send, CONFORMANCE_NAMES.agent, aguiConformanceInput());
  check(first.status === 200, `run: status ${first.status}, expected 200`);
  check(
    first.headers?.['content-type']?.startsWith('text/event-stream') !== false,
    'run: not an event stream'
  );
  let events: AGUIEvent[] = [];
  try {
    events = parseAGUIEvents(first.body);
  } catch (error) {
    problems.push(`run: ${error instanceof Error ? error.message : String(error)}`);
  }
  check(events[0]?.type === EventType.RUN_STARTED, 'run: does not open with RUN_STARTED');
  check(
    events.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT),
    'run: no TEXT_MESSAGE_CONTENT'
  );
  check(
    events.some(
      (event) =>
        event.type === EventType.STATE_DELTA &&
        JSON.stringify(event.delta) === '[{"op":"add","path":"/cart/0","value":"shirt"}]'
    ),
    'run: no STATE_DELTA on the state of the request'
  );
  const finished = events.at(-1);
  check(
    finished?.type === EventType.RUN_FINISHED &&
      finished.outcome?.type === 'interrupt' &&
      finished.outcome.interrupts[0]?.id === QUESTION.id,
    'run: does not end in RUN_FINISHED with the question as its interrupt'
  );
  const run = runtime.aguiRuns[0];
  check(
    run?.input === 'Order a shirt' &&
      run.threadId === AGUI_CONFORMANCE_THREAD &&
      run.brief === 'Locale: en-GB' &&
      run.stream === true,
    'run: the agent did not run the last user message in the AG-UI thread'
  );

  const second = await post(send, CONFORMANCE_NAMES.agent, aguiConformanceInput('M'));
  check(second.status === 200, `resume: status ${second.status}, expected 200`);
  let resumed: AGUIEvent[] = [];
  try {
    resumed = parseAGUIEvents(second.body);
  } catch (error) {
    problems.push(`resume: ${error instanceof Error ? error.message : String(error)}`);
  }
  check(
    runtime.aguiResumes[0]?.responses?.[QUESTION.id] === 'M' &&
      runtime.aguiResumes[0]?.threadId === AGUI_CONFORMANCE_THREAD,
    'resume: the answer did not reach the paused run'
  );
  check(
    resumed.some((event) => event.type === EventType.TOOL_CALL_RESULT),
    'resume: no TOOL_CALL_RESULT'
  );
  check(
    resumed.some((event) => event.type === EventType.ACTIVITY_SNAPSHOT),
    'resume: no ACTIVITY_SNAPSHOT for the data part'
  );
  const done = resumed.at(-1);
  check(
    done?.type === EventType.RUN_FINISHED && done.outcome?.type === 'success',
    'resume: does not end in RUN_FINISHED with outcome success'
  );

  const invalid = await post(send, CONFORMANCE_NAMES.agent, { threadId: 't' });
  check(
    invalid.status === status(400),
    `invalid body: status ${invalid.status}, expected ${status(400)}`
  );
  const missing = await post(send, 'missing-agent', aguiConformanceInput());
  check(
    missing.status === status(404),
    `unknown agent: status ${missing.status}, expected ${status(404)}`
  );
  return problems;
}
