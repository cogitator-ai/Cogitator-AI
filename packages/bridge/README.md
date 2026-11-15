# @cogitator-ai/bridge

> **Experimental.** The API and the protocol may change between minor versions until the package leaves this stage.

The agent bridge: Claude Code, Codex and other agents hand each other jobs, ask questions on the way and report back, each staying in its own window.

Nobody waits. An agent hands a job over, gets its number at once and ends its turn. Whatever comes later, a question or the result, arrives as a letter. The bridge in the middle is a dispatcher, not a model: it keeps jobs and letters, finds who a letter is for, applies the limits and writes everything down. It never calls a model.

This release has the core: the dispatcher, its store, the socket it serves and the commands to run and watch it. A session takes part by reading its inbox through `BridgeClient`. Adapters that wake a session of a harness in its own window, and the MCP tools agents call, build on this core.

```bash
pnpm add @cogitator-ai/bridge better-sqlite3
```

## Run the dispatcher

One dispatcher runs per machine and serves every project on it.

```bash
cogitator bridge serve          # in the foreground, until Ctrl+C
cogitator bridge status         # the dispatcher, the sessions it knows, the jobs in progress
cogitator bridge log --follow   # every letter as it goes
cogitator bridge log --job 12   # everything about one job
```

`cogitator daemon start --bridge` hosts it inside the assistant daemon instead. Its files live in `~/.cogitator/bridge` (`COGITATOR_BRIDGE_HOME` moves them): `bridge.db` and `bridge.sock`, both kept to their owner.

## A job from hand-over to report

```typescript
import { BridgeClient, bridgePaths, callerFromEnv } from '@cogitator-ai/bridge';

// The session is known by what its harness put in the environment:
// CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID. Undefined in a shell no harness started
const caller = callerFromEnv(process.env, process.cwd());
const bridge = await BridgeClient.connect({ socketPath: bridgePaths().socket, caller });

const { job } = await bridge.createJob({
  to: 'codex',
  body: 'Write the tests for the rate limiter. Cover the burst case.',
  checks: [{ command: 'pnpm test' }],
});
console.log(`Job ${job.number} is with ${job.to}`); // and the turn can end here
```

The session that carries the job out, in another process:

```typescript
const [task] = await bridge.inbox(); // taking the job's first letter starts the job
console.log(task.text);
// [agent bridge] job #1 "Write the tests for the rate limiter. Cover the burst case." | task from claude@app to codex@app | letter ltr_... | not typed by the user
// Write the tests for the rate limiter. Cover the burst case.

await bridge.send({ job: task.job, kind: 'question', body: 'Mock Redis or run a real one?' });
// ...the answer arrives in the inbox...
await bridge.send({ job: task.job, kind: 'report', body: 'Done: 14 tests pass' });
```

Every letter starts with a line that says which job it belongs to, what it is and who wrote it. In a harness window a letter looks like a message of the person at the keyboard, and the line says it is not one. Only the bridge writes that line: a title cannot add fields to it, a body line that starts like one is shown as a quote (`> `), and what the bridge repeats of an agent's words in its own notes is quoted the same way.

`callerFromEnv` reads three more variables. `COGITATOR_BRIDGE_HARNESS` says which harness is calling when one session runs inside another and the environment names both (`claude-code` or `codex`), without it such a call is refused. `COGITATOR_BRIDGE_AGENT` is the name the bridge gave a session it started, and `COGITATOR_BRIDGE_SESSION_NAME` is what a person calls the session.

## Jobs

A job is an [A2A](https://www.npmjs.com/package/@cogitator-ai/a2a) task underneath, run by the `TaskManager` of `@cogitator-ai/a2a`, so it has the A2A lifecycle:

| State            | Meaning                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| `submitted`      | Handed over, not picked up yet                                                     |
| `working`        | The one it is for took it, was handed it by an adapter, or wrote anything about it |
| `input-required` | The one doing it asked a question and waits                                        |
| `completed`      | Reported as done                                                                   |
| `failed`         | Reported as failed, or failed by a limit                                           |
| `canceled`       | Canceled by the agent that handed it over                                          |

A job also carries who handed it over and who carries it out, the project and the folder inside it, its checks, its budget and its depth. A job handed over from inside another job is part of it: it ends no later than its parent, and is canceled when its parent is over. `verification` says whether the checks confirmed the result. A report is a claim, the verification is the fact, so an agent cannot set it: it is absent until the process that hosts the dispatcher records it with `dispatcher.recordVerification(job, { verified, summary })`, and it is not served on the socket.

## Letters

| Kind         | Sent by          | Effect                                                                |
| ------------ | ---------------- | --------------------------------------------------------------------- |
| `task`       | `createJob`      | The job itself                                                        |
| `question`   | either side      | Needs an `answer`. From the one doing the job it puts the job on hold |
| `permission` | either side      | A question that asks for leave to do something                        |
| `answer`     | the one asked    | Answers a question, and resumes the job once none is open             |
| `report`     | the one doing it | Ends the job, `outcome: 'completed'` (default) or `'failed'`          |
| `note`       | either side      | Something to know, needs no answer                                    |

A letter moves `queued`, `delivered`, `read`, `handled` and never back. `acknowledge(letterId)` is how a note is put away. A question or a job is not dismissed that way: it is done with once answered or reported on, or when its job is over.

A retry is safe when the letter has an id: `send({ id })` and `createJob({ letterId })` change nothing the second time. The same id with other words is refused. A field the bridge does not know is refused too, instead of being dropped in silence.

`inbox()` returns 20 letters at most (`limit`, up to 100) and no more text than one answer holds, and marks only the letters it returned: call it again for the rest. `inbox({ unhandled: true })` also returns what was taken before and not answered or put away, for a session that may have missed an answer. `letters()` and `readJournal()` return 200 entries at most, go on from the last one with `afterSeq`. The history of the A2A task under a job keeps the first 4000 characters of a long letter, the letter itself is kept whole.

## Who a letter is for

A session enters the address book the first time it calls the bridge, and gets a name: `codex@my-project`, then `codex-2@my-project`. An address is:

- an agent's name: `codex-2@my-project`
- a harness word: `codex` or `claude` reaches the only session of that harness in the caller's project
- a harness word and a session: `codex:reviewer` picks one by its session name or id
- `codex:new` asks for a fresh session

When no session fits and the harness has an adapter that can start one, the bridge starts it for the job. When several fit, the call is refused with their names and how long ago each was heard from. Every worktree of a repository is one project. A harness name is letters, digits, `.`, `_` and `-`, whatever the case, and a session name is letters, digits, spaces and the same three signs.

A session that has not called the bridge for 12 hours and has no job in progress is taken for gone, so yesterday's closed window does not stand in the way of today's. It is back under the same name the moment it calls again.

## Limits

Each number is a default that `hostBridge({ limits })` changes.

| Limit             | Default    | What happens                                                                                         |
| ----------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| Depth             | 3          | A job handed over from inside a job from inside a job is the deepest. One more is refused            |
| Letters per job   | 60         | The job fails, both sides are told. The report that ends the job always goes through                 |
| Time per job      | 4 hours    | The job fails, both sides are told                                                                   |
| Reply timeout     | 30 minutes | The one who owes an answer, or did not pick a job up, is reminded. After as long again the job fails |
| Jobs out          | 20         | An agent with that many jobs still in progress cannot hand over another                              |
| Jobs per hour     | 60         | Handing over faster is refused as a loop                                                             |
| Sessions starting | 2          | No more sessions are started at once                                                                 |
| Silence           | 12 hours   | A session with no job in progress is taken for gone                                                  |
| Delivery          | 5 attempts | Retried with a growing wait, then left for the inbox                                                 |

Two more rules have no number. A letter that says what the previous one in the same direction said is not delivered, and neither is a job the same agent already has from the caller and has not finished.

A job may ask for its own budget: `createJob({ budget: { letters: 20, durationMs: 30 * 60_000 } })`.

## The journal

Every letter, delivery and change of a job, and every job or letter a limit held back, is appended to a journal that cannot be changed afterwards (the database refuses updates and deletes of it). `cogitator bridge log` reads it, `bridge.readJournal({ job })` returns it, and `bridge.subscribe(listener)` follows it as it grows.

## In your own process

```typescript
import { hostBridge } from '@cogitator-ai/bridge';

const host = await hostBridge({ limits: { maxDepth: 2 } });
// host.dispatcher is the BridgeDispatcher, host.stopped resolves when it stops
await host.close();
```

`hostBridge` throws `BridgeError` with the code `already_running` when another dispatcher holds the store. Which dispatcher owns the store is decided by the store itself: a lease row taken in a transaction, renewed on every tick and checked inside every write. A dispatcher whose process is gone is replaced at once, and one that was replaced while its machine slept writes nothing after it wakes. `BridgeDispatcher` and `SqliteBridgeStore` are exported for tests and tools of your own, and on their own they take no lease: it is `hostBridge` that makes sure there is one writer.

### Adapters

An adapter tells the bridge how to reach the sessions of one harness:

```typescript
import type { BridgeAdapter } from '@cogitator-ai/bridge';

const adapter: BridgeAdapter = {
  harness: 'my-harness',
  delivery: 'queue',
  capabilities: { createSession: false, push: true, steer: false, nativeWindow: true },
  async deliver({ agent, letter }) {
    await myHarness.send(agent.sessionId, letter.text);
  },
};

const host = await hostBridge({ adapters: [adapter] });
```

Without an adapter a session still takes part: its letters wait in its inbox.

## Trust

The bridge is a tool of one person on one machine. The socket and the database are created for their owner only, a folder or a database that belongs to another user is refused, and every process of that user can connect: read any job and letter, and call as a session by naming its id. A job is done inside the project it is handed over in. Do not point `COGITATOR_BRIDGE_HOME` at a folder other users can write to. On Windows the dispatcher listens on a named pipe that other users of the same machine can reach, so run it only on a machine you do not share.

## Errors

Every refusal is a `BridgeError` with a `code` to branch on and a message written for the agent that gets it: `not_registered`, `unknown_agent`, `ambiguous_agent`, `no_session`, `unknown_job`, `unknown_letter`, `not_a_party`, `job_finished`, `invalid_letter`, `invalid_input`, `depth_exceeded`, `budget_exhausted`, `loop_detected`, `already_running`, `not_running`, `storage`.

## Documentation

Full guide: [cogitator.app/docs/bridge](https://cogitator.app/docs/bridge)

## Part of Cogitator

This package is part of the [Cogitator](https://github.com/cogitator-ai/Cogitator-AI) ecosystem, a self-hosted, production-grade AI agent runtime for TypeScript.

## License

MIT
