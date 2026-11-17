import type { PermissionHookCall } from './adapter.js';
import { BridgeClient } from './client.js';
import { isBridgeError } from './errors.js';
import { pause } from './adapters/exec.js';
import type { VerdictResult } from './inputs.js';
import type { JobState, PermissionAsk, Verdict } from './types.js';

const ACTIVE: readonly JobState[] = ['submitted', 'working', 'input-required'];

/** How long one look for the verdict waits before the next one, in ms. */
const LOOK_MS = 30_000;

/** The pause after a look that came back at once without a verdict, as from a closing dispatcher. */
const RETRY_MS = 250;

/** The environment a command sets for itself, in words for a letter: ` with A=1, B=2`. */
function envWords(env: Record<string, string> | undefined): string {
  const set = Object.entries(env ?? {}).map(([name, value]) => `${name}=${value}`);
  return set.length > 0 ? ` with ${set.join(', ')}` : '';
}

/**
 * The words of a letter that asks leave for a call: what the agent said of the call, when it
 * said anything, and then the call itself.
 */
export function describeAsk(ask: PermissionAsk, said?: string): string {
  const call =
    ask.access === 'command' && ask.command
      ? `Run in ${ask.cwd ?? 'its folder'}${envWords(ask.env)}:\n${ask.command}`
      : ask.access === 'fetch' && ask.url
        ? `Fetch ${ask.url}`
        : ask.paths && ask.paths.length > 0
          ? `${ask.access === 'edit' ? 'Change' : 'Read'}: ${ask.paths.join(', ')}`
          : `Call ${ask.tool}`;
  const words = said?.trim();
  return words && words !== call ? `${words}\n${call}` : call;
}

export interface AskLeaveOptions {
  /** The socket of the bridge's dispatcher */
  socketPath: string;
  /** The call a session needs leave for, as its harness told a hook */
  call: PermissionHookCall;
  /** How long to wait for the verdict, in ms */
  timeoutMs: number;
  signal?: AbortSignal;
}

/** How asking leave through the bridge ended. */
export type LeaveOutcome =
  | { state: 'decided'; verdict: Verdict; reason: string }
  /** Nothing is decided: the harness goes on as if nobody had been asked */
  | { state: 'open'; why: string };

/**
 * Asks leave for a call of a session through the bridge, the way a hook of its harness does:
 * as a permission request on the job the session carries out, and waits for the verdict. A
 * session that carries out no job, or several, is not asked for: the call is nobody's to
 * decide but the person at its window. A request the bridge refuses to take is a refusal of the
 * call, with what the bridge said. When nobody decides in time the request is taken back, so
 * no answer that comes later looks as if it let the call through.
 */
export async function askLeave(options: AskLeaveOptions): Promise<LeaveOutcome> {
  const { call, signal } = options;
  const deadline = Date.now() + options.timeoutMs;
  let client: BridgeClient;
  try {
    client = await BridgeClient.connect({ socketPath: options.socketPath, caller: call.caller });
  } catch (error) {
    if (isBridgeError(error) && error.code === 'not_running') {
      return { state: 'open', why: 'no bridge dispatcher runs' };
    }
    throw error;
  }
  try {
    const self = client.agent?.name;
    if (!self) return { state: 'open', why: 'the bridge does not know the session' };
    const jobs = await client.jobs({ to: self, states: ACTIVE });
    if (jobs.length !== 1) {
      return {
        state: 'open',
        why:
          jobs.length === 0
            ? 'the session carries out no job'
            : 'the session carries out several jobs',
      };
    }
    let letter: string;
    try {
      const sent = await client.send({
        job: jobs[0].number,
        kind: 'permission',
        body: call.body,
        ask: call.ask,
      });
      letter = sent.letter.id;
    } catch (error) {
      if (!isBridgeError(error)) throw error;
      return { state: 'decided', verdict: 'deny', reason: error.message };
    }
    while (!signal?.aborted) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const asked = Date.now();
      const decision = await client.verdict({ letter, timeoutMs: Math.min(LOOK_MS, left) });
      if (decision.state === 'decided') return outcomeOf(decision);
      if (Date.now() - asked < RETRY_MS) await pause(RETRY_MS);
    }
    const late = await client.withdraw({ letter }).catch(() => undefined);
    if (late?.state === 'decided') return outcomeOf(late);
    return { state: 'open', why: 'nobody decided in time' };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function outcomeOf(decision: Extract<VerdictResult, { state: 'decided' }>): LeaveOutcome {
  return {
    state: 'decided',
    verdict: decision.verdict,
    reason:
      decision.verdict === 'allow'
        ? decision.reason
        : `Refused by ${decision.by}: ${decision.reason}`,
  };
}

/**
 * What a hook that asks leave through the bridge writes for its harness: the decision in the
 * words of the harness, or nothing when the call stays open and the harness decides as it would
 * without the hook.
 */
export async function answerPermissionHook(options: AskLeaveOptions): Promise<string | undefined> {
  const outcome = await askLeave(options);
  return outcome.state === 'decided'
    ? options.call.answer(outcome.verdict, outcome.reason)
    : undefined;
}
