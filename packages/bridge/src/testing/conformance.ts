import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { BridgeAdapter, IdentifyContext } from '../adapter.js';
import { hostBridge, type BridgeHost } from '../host.js';
import { aliasOfHarness } from '../registry.js';
import { HarnessNameSchema, type AgentRecord } from '../types.js';

/** What a case of the adapter contract works in. */
export interface AdapterConformanceContext {
  /** The folder of the bridge the case hosts: an adapter whose sessions call back needs it */
  home: string;
}

/** An adapter under test, with the harness it reaches (a real one or a stand-in). */
export interface AdapterConformanceTarget {
  /** A fresh adapter. Every case gets its own */
  create(context: AdapterConformanceContext): Promise<BridgeAdapter> | BridgeAdapter;
  /** Called with each adapter `create` made once its case is done, to stop what it started */
  release?(adapter: BridgeAdapter): Promise<void>;
  /** An empty folder a case may keep the bridge's files in, a new one for every call */
  home(): string;
  /** A folder the harness may start sessions in */
  cwd: string;
  /**
   * What the adapter is expected to have besides delivery. `declares-itself` fails when the
   * adapter has more or less, so a method that goes missing is noticed instead of its cases
   * being skipped
   */
  supports: readonly AdapterFeature[];
  /**
   * Resolves once the session got a text that includes `needle`: how a case sees what reached
   * the harness. Rejects when it does not come in reasonable time
   */
  received(sessionId: string, needle: string): Promise<void>;
  /**
   * What `identify` is given for a process of the session. Needed when the adapter is said to
   * support `identify`
   */
  processOf?(sessionId: string): IdentifyContext;
  /**
   * For an adapter that starts no sessions: opens a session of the harness outside the bridge
   * and returns its id, so the delivery of a letter to it can be checked
   */
  openSession?(): Promise<string>;
  /** Cases to leave out, with the reason */
  skip?: Partial<Record<AdapterScenario, string>>;
}

export type AdapterFeature = 'createSession' | 'liveSessions' | 'identify' | 'health';

const FEATURES: readonly AdapterFeature[] = ['createSession', 'liveSessions', 'identify', 'health'];

export type AdapterScenario =
  | 'declares-itself'
  | 'starts-a-session'
  | 'delivers-a-letter'
  | 'lists-its-sessions'
  | 'identifies-its-sessions'
  | 'reports-health';

/** One case of the adapter contract. */
export interface AdapterConformanceCase {
  name: AdapterScenario;
  /** Why the case does not apply, when it does not */
  skip?: string;
  /** Runs the case, throws an `AssertionError` when the adapter breaks the contract */
  run(): Promise<void>;
}

const POLL_MS = 20;
const SETTLE_MS = 15_000;

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

interface Stage {
  adapter: BridgeAdapter;
  host: BridgeHost;
  /** The agent that hands jobs over */
  orchestrator: AgentRecord;
  /**
   * Hands a job to the harness and returns the session that got it: one the adapter started, or
   * for an adapter that starts none, one the target opened
   */
  start(): Promise<{ agent: AgentRecord; job: number; firstLetter: string }>;
}

async function staged(
  target: AdapterConformanceTarget,
  work: (stage: Stage) => Promise<void>
): Promise<void> {
  const home = target.home();
  const adapter = await target.create({ home });
  const errors: Error[] = [];
  let host: BridgeHost | undefined;
  try {
    host = await hostBridge({
      home,
      adapters: [adapter],
      tickMs: 50,
      onError: (error) => errors.push(error),
    });
    const bridge = host.dispatcher;
    const orchestrator = await bridge.register({
      harness: 'conformance',
      sessionId: randomUUID(),
      cwd: target.cwd,
      project: target.cwd,
    });
    await work({
      adapter,
      host,
      orchestrator,
      start: async () => {
        let to = `${aliasOfHarness(adapter.harness)}:new`;
        if (!adapter.createSession) {
          assert.ok(target.openSession, 'an adapter that starts no session needs openSession');
          const opened = await bridge.register({
            harness: adapter.harness,
            sessionId: await target.openSession(),
            cwd: target.cwd,
            project: target.cwd,
          });
          to = opened.name;
        }
        const { job, letter } = await bridge.createJob(orchestrator.name, {
          to,
          body: 'Conformance: say you got this',
        });
        const agent = await until(async () => {
          const current = await bridge.job(job.number);
          assert.notEqual(current.state, 'failed', `the job failed: ${current.reason ?? ''}`);
          const [worker] = await bridge.agents({ harness: adapter.harness, statuses: ['active'] });
          return worker?.sessionId ? worker : undefined;
        }, `the ${adapter.harness} session to start`);
        return { agent, job: job.number, firstLetter: letter.id };
      },
    });
    assert.deepEqual(
      errors.map((error) => error.message),
      [],
      'the bridge reported errors'
    );
  } finally {
    await host?.close();
    await target.release?.(adapter);
  }
}

/**
 * The contract every adapter keeps, as cases a test runs one by one against the adapter and its
 * harness: it says what it is, starts a session that gets the job's first letter, hands later
 * letters to it, and tells the truth about the sessions it lists, the processes it recognizes
 * and the health it reports. Cases for what an adapter does not claim are skipped.
 *
 * @example
 * ```ts
 * for (const conformance of adapterConformanceCases(target)) {
 *   it.skipIf(conformance.skip)(conformance.name, () => conformance.run());
 * }
 * ```
 */
export function adapterConformanceCases(
  target: AdapterConformanceTarget
): AdapterConformanceCase[] {
  const probe = (): Promise<BridgeAdapter> | BridgeAdapter =>
    target.create({ home: target.home() });
  const cases: { name: AdapterScenario; needs?: AdapterFeature; run(): Promise<void> }[] = [
    {
      name: 'declares-itself',
      async run() {
        const adapter = await probe();
        try {
          assert.equal(
            HarnessNameSchema.safeParse(adapter.harness).data,
            adapter.harness,
            'the harness name is lower case letters, digits, ".", "_" and "-"'
          );
          assert.ok(adapter.delivery.trim(), 'the adapter names how letters travel');
          assert.equal(
            adapter.createSession !== undefined,
            adapter.capabilities.createSession,
            'createSession is there exactly when capabilities.createSession says so'
          );
          if (adapter.deliver) {
            assert.ok(adapter.capabilities.push, 'an adapter that delivers says it pushes');
          }
          assert.deepEqual(
            FEATURES.filter((feature) => adapter[feature] !== undefined),
            FEATURES.filter((feature) => target.supports.includes(feature)),
            'the adapter has what the target says it supports, no more and no less'
          );
        } finally {
          await target.release?.(adapter);
        }
      },
    },
    {
      name: 'starts-a-session',
      needs: 'createSession',
      run: () =>
        staged(target, async ({ host, start }) => {
          const { agent, job, firstLetter } = await start();
          await target.received(agent.sessionId, firstLetter);
          await target.received(agent.sessionId, 'not typed by the user');
          await until(async () => {
            const [first] = await host.dispatcher.letters({ job });
            return first?.state === 'queued' ? undefined : first;
          }, 'the first letter to count as handed over');
          assert.notEqual((await host.dispatcher.job(job)).state, 'submitted', 'the job is taken');
        }),
    },
    {
      name: 'delivers-a-letter',
      run: () =>
        staged(target, async ({ host, orchestrator, start }) => {
          const { agent, job, firstLetter } = await start();
          await target.received(agent.sessionId, firstLetter);
          const { letter } = await host.dispatcher.send(orchestrator.name, {
            job,
            kind: 'note',
            body: 'Conformance: one more thing',
          });
          await target.received(agent.sessionId, letter.id);
          await until(async () => {
            const [note] = await host.dispatcher.letters({ job, kinds: ['note'] });
            return note?.state === 'queued' ? undefined : note;
          }, 'the note to count as handed over');
        }),
    },
    {
      name: 'lists-its-sessions',
      needs: 'liveSessions',
      run: () =>
        staged(target, async ({ adapter, start }) => {
          const { agent } = await start();
          await until(async () => {
            const sessions = (await adapter.liveSessions?.()) ?? [];
            return sessions.find((session) => session.sessionId === agent.sessionId);
          }, 'the started session to be listed');
        }),
    },
    {
      name: 'identifies-its-sessions',
      needs: 'identify',
      async run() {
        const adapter = await probe();
        try {
          assert.equal(
            adapter.identify?.({ env: {}, cwd: target.cwd }),
            undefined,
            'a process of no session is nobody'
          );
          assert.ok(target.processOf, 'a target whose adapter identifies sessions gives processOf');
          const sessionId = randomUUID();
          const caller = adapter.identify?.(target.processOf(sessionId));
          assert.equal(caller?.harness, adapter.harness);
          assert.equal(caller?.sessionId, sessionId);
        } finally {
          await target.release?.(adapter);
        }
      },
    },
    {
      name: 'reports-health',
      needs: 'health',
      async run() {
        const adapter = await probe();
        try {
          const checks = (await adapter.health?.({ cwd: target.cwd })) ?? [];
          assert.ok(checks.length > 0, 'health says something');
          assert.equal(new Set(checks.map((check) => check.id)).size, checks.length, 'ids repeat');
          for (const check of checks) {
            assert.ok(['ok', 'warn', 'fail'].includes(check.status), `status of ${check.id}`);
            assert.ok(check.title.trim(), `title of ${check.id}`);
            if (check.status !== 'ok') {
              assert.ok(check.fix?.trim(), `${check.id} is ${check.status} and says what to do`);
            }
          }
        } finally {
          await target.release?.(adapter);
        }
      },
    },
  ];

  return cases.map(({ name, needs, run }) => {
    const skip =
      target.skip?.[name] ??
      (needs && !target.supports.includes(needs) ? `the adapter has no ${needs}` : undefined) ??
      (name === 'delivers-a-letter' &&
      !target.supports.includes('createSession') &&
      !target.openSession
        ? 'the adapter starts no session and the target opens none'
        : undefined);
    return { name, run, ...(skip !== undefined && { skip }) };
  });
}
