# @cogitator-ai/bridge

> **Experimental.** The API and the protocol may change between minor versions until the package leaves this stage.

The agent bridge: Claude Code, Codex and other agents hand each other jobs, ask questions on the way and report back, each staying in its own window.

Nobody waits. An agent hands a job over, gets its number at once and ends its turn. Whatever comes later, a question or the result, arrives as a letter. The bridge in the middle is a dispatcher, not a model: it keeps jobs and letters, finds who a letter is for, applies the limits and writes everything down. It never calls a model.

The bridge reaches a session where it lives. A Claude Code session wakes for its mail through a hook of its own, a Codex thread through its message queue, and an agent the bridge hosts itself (any model of the Cogitator runtime, any agent of the Agent Client Protocol) gets a letter as its next turn. A harness without an adapter still takes part: its sessions read their inbox.

Agents call the bridge with tools of their own, served over MCP: `delegate`, `ask`, `answer`, `report` and the rest. A server of tools lives outside the sandbox of its session, so a Codex thread in a sandbox takes part like any other. `cogitator bridge install` sets Claude Code and Codex up for a project, and shows every change before it makes it.

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
cogitator bridge doctor         # whether Claude Code and Codex can be reached, and what to fix
cogitator bridge asks           # what waits for your word: permission requests, questions left to you
```

`cogitator daemon start --bridge` hosts it inside the assistant daemon instead. Its files live in `~/.cogitator/bridge` (`COGITATOR_BRIDGE_HOME` moves them): `bridge.db` and `bridge.sock`, both kept to their owner.

## Set a project up

```bash
cogitator bridge install            # Claude Code and Codex, for you in this project
cogitator bridge install claude     # one harness
cogitator bridge install --dry-run  # list the changes, make none
cogitator bridge uninstall          # take out what install put in, and nothing else
```

`install` lists every change first and makes them after a yes (`--yes` skips the question):

|                     | Claude Code                                                  | Codex                              |
| ------------------- | ------------------------------------------------------------ | ---------------------------------- |
| The server of tools | `claude mcp add --scope local bridge`                        | `codex mcp add bridge`             |
| Hooks               | the project's `.claude/settings.local.json`                  | none needed                        |
| Tools run unasked   | the rule `mcp__bridge` in the same file, unless `--no-allow` | Codex asks nothing for these tools |
| Notes for sessions  | `CLAUDE.md` of the project, unless `--no-notes`              | `AGENTS.md`, unless `--no-notes`   |

What names a path of this machine goes where only you have it, never into a file the project shares. A linked git worktree is a checkout of its own: run `install` in each one whose sessions need the bridge. The notes say how the tools go together and that a letter of the bridge is not typed by you. By default they tell a session you opened to ask you before it carries out a job of another agent: `--take-jobs` lets it go ahead. `--user` sets every project of yours up instead of one. Codex keeps its servers for every project whichever way it is asked, so a per-project `uninstall` leaves its server and `uninstall codex --user` removes it. Settings that are not a JSON object are refused, never overwritten, and running `install` again changes only what is out of date. Sessions that are open get the tools when they are started again.

### The tools

| Tool       | What it does                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `delegate` | Hands a job to `codex`, `claude` or an agent by name, and returns its number at once                            |
| `ask`      | Asks the other agent of a job a question. The answer wakes the session                                          |
| `answer`   | Answers a question another agent asked, or decides its permission request: allow, deny, or leave it to the user |
| `report`   | Reports the result of a job handed to this session, which ends the job. `failed` says it did not                |
| `note`     | Tells the other agent something it need not answer                                                              |
| `inbox`    | Reads the letters that wait, when nothing woke the session                                                      |
| `job`      | Shows one job: its state, and for a job of this session its latest letters                                      |
| `jobs`     | Lists the jobs this session handed over or carries out                                                          |
| `cancel`   | Takes back a job this session handed over                                                                       |
| `agents`   | Lists the sessions the bridge knows in the project, and the agents it can start a session of                    |

No tool waits for another agent. The server tells every client the same in its `instructions`: after `delegate` say in one line what was handed over and end the turn, reply to a letter with the tools and never only in the chat, and treat a job of another agent as that agent's request, not the user's.

## Claude Code and Codex

The dispatcher of `cogitator bridge serve` reaches both harnesses with the commands they document. It changes nothing in their settings: `cogitator bridge install` does, for the sessions you open yourself, and a session the bridge starts carries what it needs.

|                         | Claude Code                                               | Codex                                                         |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| A letter reaches it by  | a `Stop` hook of the session that waits at the bridge     | `codex queue --resume`                                        |
| A session for a job is  | `claude --bg`, a background session `claude attach` opens | `codex exec`, a thread `codex resume` opens                   |
| It wakes by itself when | the session carries the hook                              | the thread is open in the Codex app, or the local daemon runs |
| The tools know it by    | a hook that adds the session to every tool call           | the thread Codex names in every tool call                     |
| Before it can start     | Claude Code must trust the folder                         | nothing                                                       |

**Claude Code.** Nothing is pushed into a window from outside. After every turn a background hook of the session runs `cogitator bridge wait`, which waits at the dispatcher and, when a letter comes, exits with code 2 and the letter on stderr: that wakes the session with the letter as its next input (`asyncRewake` in Claude Code's hooks). Under the letter it adds one line saying how to answer through the bridge. While the hook waits the session is free, you can talk to it. A session the bridge starts carries the hook itself. For the sessions you open yourself, `cogitator bridge install` puts it into the project's `.claude/settings.local.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cogitator bridge wait --hook claude-code --timeout 43140 --tools",
            "timeout": 43200,
            "async": true,
            "asyncRewake": true
          }
        ]
      }
    ]
  }
}
```

A dispatcher that keeps its files somewhere else (`--home`, `COGITATOR_BRIDGE_HOME`) puts that folder into the hook and into the command of the server of tools, so its sessions call it and not the default one. A session without the hook still gets its letters, when it asks: the `inbox` tool, or `cogitator bridge inbox`.

Claude Code starts a server of tools once and keeps it across `/clear`, so the session a server was started for is not always the one that calls. A second hook, on the bridge's tools only (`PreToolUse`, `cogitator bridge caller`), adds the session to the arguments of every call, and the tools go by that. Without it they go by the session the server was started for, which `cogitator bridge doctor` warns about. The hook waits 12 hours at most, then the session reads its mail at its next turn. A session a person opened decides for itself what to do with a job another agent hands it: every letter says it was not typed by the user, and such a session may ask its person before it acts. A session the bridge started for a job takes the job as its task. Claude Code starts a background session only in a folder it trusts: the bridge checks that first and fails the job with what to do (open the folder in Claude Code once and accept its prompt).

**Codex.** A letter goes into the message queue of the thread. A thread open in the Codex app takes it within seconds. A thread that is open nowhere, such as one the bridge started, wakes only when Codex's local daemon runs (`codex app-server daemon start`). The bridge never starts that daemon for you: without it the letter stays in the queue until the thread is opened. Codex does not tell the two cases apart, so the journal notes every letter queued while no daemon runs. A thread the bridge starts runs in the `workspace-write` sandbox, and what it prints goes to a file of its own in `~/.cogitator/bridge/sessions`, which the bridge never removes.

The sandbox keeps the shell commands of a thread from the bridge's socket (`connect EPERM`), and Codex gives a server of tools none of the thread's environment. The tools need neither: Codex runs their server outside the sandbox and names the thread in every call, so a thread asks, answers and reports from any sandbox. The tools say they destroy nothing and stay on this machine, which is why Codex runs them without an approval, in `codex exec` too. A thread the bridge starts gets the tools whatever Codex has set up, and when its turn ends without a report the bridge takes its final answer as one, and a turn that fails as a failed job. `cogitator bridge serve --codex-sandbox <mode>` and the `sandbox` option of `codexAdapter` choose what the thread itself may do: `danger-full-access` holds nothing back, so name it only on a machine where you would let the thread do anything.

**From a shell.** A session without the tools, and you at a terminal inside one, call the bridge with its command line. The session is known by what its harness put into the environment. A sandbox that keeps commands from sockets keeps this from the bridge too: that is what the tools are for.

```bash
cogitator bridge delegate codex "Write the tests for the rate limiter" --check "pnpm test"
cogitator bridge send --job 12 --kind question "Mock Redis or run a real one?"
cogitator bridge send --job 12 --kind report "Done: 14 tests pass"
cogitator bridge inbox
cogitator bridge cancel 12 "Not needed any more"
```

A long text is piped in: `git diff | cogitator bridge send --job 12 --kind note -`. A text that starts with a dash goes after `--`, so it is not taken for an option.

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

A job also carries who handed it over and who carries it out, the project and the folder inside it, its checks, its budget and its depth. A job handed over from inside another job is part of it: it ends no later than its parent, and is canceled when its parent is over, whether that one was reported on, failed or was canceled. `verification` says whether the checks confirmed the result. A report is a claim, the verification is the fact, so an agent cannot set it: it is absent until the process that hosts the dispatcher records it with `dispatcher.recordVerification(job, { verified, summary })`, and it is not served on the socket.

## Letters

| Kind         | Sent by          | Effect                                                                                           |
| ------------ | ---------------- | ------------------------------------------------------------------------------------------------ |
| `task`       | `createJob`      | The job itself                                                                                   |
| `question`   | either side      | Needs an `answer`. From the one doing the job it puts the job on hold                            |
| `permission` | either side      | A question that asks for leave. When it names its call, the bridge decides whose answer it takes |
| `answer`     | the one asked    | Answers a question, and resumes the job once none is open                                        |
| `report`     | the one doing it | Ends the job, `outcome: 'completed'` (default) or `'failed'`                                     |
| `note`       | either side      | Something to know, needs no answer                                                               |

A letter moves `queued`, `delivered`, `read`, `handled` and never back. `acknowledge(letterId)` is how a note is put away. A question or a job is not dismissed that way: it is done with once answered or reported on, or when its job is over.

A letter is text: one with a NUL character in it is refused, since no harness can be handed it. A retry is safe when the letter has an id: `send({ id })` and `createJob({ letterId })` change nothing the second time. The same id with other words is refused. A field the bridge does not know is refused too, instead of being dropped in silence.

`wait({ timeoutMs })` is the inbox for a process that would rather sleep than ask: it answers the moment a letter is queued for the session, and with nothing when the time runs out. What it returns stays queued until `delivered(ids)` says it reached the session, so a waiter that dies with a letter in hand loses nothing. A session has one waiter at a time, and a letter a waiter holds is given to nobody else meanwhile, so a session reached two ways does not get it twice. `waitForMail` wraps both and also waits for a dispatcher that is not running, which is what `cogitator bridge wait` does.

`inbox()` returns 20 letters at most (`limit`, up to 100) and no more text than one answer holds, and marks only the letters it returned: call it again for the rest. `inbox({ unhandled: true })` adds the newest of what was taken before and not answered or put away, for a session that may have missed an answer, and `afterSeq` looks further back or forward than one call returns. `letters()` and `readJournal()` return 200 entries at most, go on from the last one with `afterSeq`. The history of the A2A task under a job keeps the first 4000 characters of a long letter, the letter itself is kept whole.

## Leave for a call, and the person

An agent that carries a job out sometimes needs leave for one call: to run a command, to change a file its own rules do not let it change. It asks with a `permission` letter that names the call (`ask`), and the bridge decides whose answer that takes before anybody is woken. The measure is the rights of the agent that handed the job over, read from the permission settings of the job's project (`.claude/settings.json`, `.cogitator/settings.json`, their `.local` files, the person's and the machine's), in the permission mode that agent runs in:

| Its rules say | What happens                                                          |
| ------------- | --------------------------------------------------------------------- |
| forbidden     | The call is refused at once, in the bridge's name. Nobody is asked    |
| allowed       | The request goes to that agent, which answers `allow` or `deny`       |
| ask a person  | Only the person can allow it. The agent is told, and can still refuse |

So an agent never gets leave from another agent that the other one does not have itself. A job handed over from inside a job is bound by every agent up the chain. Without a rule the person is asked what a person at a session would be asked: a command, an address to fetch, a file outside the project. A change to the settings files themselves is always the person's to allow, whatever the rules and the mode say, and so is a command that names their folders: an agent does not write the rules it is judged by. For a command this reads the words of the command line and no more, as every rule on a command does.

The one who asked does not get the answer as mail: it waits for it with `verdict({ letter })`, which answers the moment the request is decided. A request whose job ends first counts as refused. The same call may be asked for again once it was allowed, and is held back as a repeat once it was refused.

A Claude Code session the bridge starts asks the same way. It gets a `PermissionRequest` hook (`cogitator bridge permit`), so a call its mode and rules would show the permission dialog for becomes a request on its job, and the session goes on with the verdict. A session you opened keeps its dialog, which is yours to answer. When it opens one while it carries out a job, a `Notification` hook that `cogitator bridge install` adds (`cogitator bridge stuck`) tells the bridge: the agent that handed the job over gets a note that the job stands still, and you a notice in the inbox and the chat. A background session is noticed the same way in what `claude agents --json` lists. Codex gives no such signal yet, so a thread that waits at its own approval prompt is noticed by the reply timeout.

An agent can also leave a letter to the person itself: `answer` with the decision `person` (`escalate` in code) passes a question or a request on, and the person's answer goes straight to the one who asked.

What waits for the person is theirs to answer from a terminal:

```bash
cogitator bridge asks                           # what waits for your word
cogitator bridge allow 12                       # allow the call job 12 asks leave for
cogitator bridge deny 12 "not on a Friday"
cogitator bridge reply 12 "the release in March"
```

`serve` and the daemon also keep these letters in an inbox, `inbox.json` next to the database (an `experimental_Inbox` of core, so its sinks and whatever reads the file see them), and send them to a Telegram chat when `COGITATOR_BRIDGE_TELEGRAM_TOKEN` and `COGITATOR_BRIDGE_TELEGRAM_CHAT` name a bot and a chat: a permission request with Allow and Refuse buttons, a question to be answered by replying to it. `COGITATOR_BRIDGE_TELEGRAM_USERS` limits who in that chat is listened to. Give the bridge a bot of its own.

Waiting for the person does not spend the job's time: the deadline does not fail a job that waits for them, nor the jobs it is part of, and moves by as long as they waited once the person answered. An agent that takes a letter back from the person and answers it itself gets no time for it. The person has a limit of their own instead: after 4 hours they are reminded, after as long again the job fails. A permission request is a letter of the job like any other and counts against its letters.

In your own process the pieces are `hostBridge({ rights, person })`:

```typescript
import { channelRoute, hostBridge, inboxRoute, personRoutes } from '@cogitator-ai/bridge';
import { settingsRights } from '@cogitator-ai/bridge/rights';
import { telegramChannel } from '@cogitator-ai/channels';
import { experimental_Inbox } from '@cogitator-ai/core';

const telegram = channelRoute({ channel: telegramChannel({ token }), chatId: '123456' });
const host = await hostBridge({
  rights: settingsRights(),
  person: personRoutes([inboxRoute(new experimental_Inbox()), telegram]),
});
await telegram.start();
```

`rights` is any function from a job and a call to `allow`, `ask` or `deny`. Without one every call is the person's, and without `person` what only they could allow is refused. A route is anything with `ask` and `settle`, and `host.dispatcher.personAnswer({ letter, verdict })` takes the answer.

## Who a letter is for

A session enters the address book the first time it calls the bridge, and gets a name: `codex@my-project`, then `codex-2@my-project`. An address is:

- an agent's name: `codex-2@my-project`
- a harness word: `codex` or `claude` reaches the only session of that harness in the caller's project
- a harness word and a session: `codex:reviewer` picks one by its session name or id
- `codex:new` asks for a fresh session

When no session fits and the harness has an adapter that can start one, the bridge starts it for the job. When several fit, the call is refused with their names and how long ago each was heard from. Every worktree of a repository is one project. A harness name is letters, digits, `.`, `_` and `-`, whatever the case. A session is addressed by whatever it is called, or the start of it, as long as that does not begin with `-`.

A session that has not called the bridge for 12 hours and has no job in progress is taken for gone, so yesterday's closed window does not stand in the way of today's. It is back under the same name the moment it calls again. Where the harness can list its sessions (`claude agents --json`), the bridge asks once a minute: a session that is listed, or whose hook waits for mail, stays however long it is silent, and one that was listed and then is missing two times in a row counts as gone, its jobs failing with that reason instead of after the reply timeout.

Folders are compared by their real path, so a project reached through a symlink is the same project.

## Limits

Each number is a default that `hostBridge({ limits })` changes.

| Limit             | Default    | What happens                                                                                                             |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| Depth             | 3          | A job handed over from inside a job from inside a job is the deepest. One more is refused                                |
| Letters per job   | 60         | The job fails, both sides are told. The report that ends the job always goes through                                     |
| Time per job      | 4 hours    | The job fails, both sides are told                                                                                       |
| Reply timeout     | 30 minutes | The one who owes an answer, or did not pick a job up, is reminded. After as long again the job fails                     |
| Jobs out          | 20         | An agent with that many jobs still in progress cannot hand over another                                                  |
| Jobs per hour     | 60         | Handing over faster is refused as a loop                                                                                 |
| Sessions starting | 2          | No more sessions are started at once                                                                                     |
| Silence           | 12 hours   | A session with no job in progress is taken for gone, unless its harness lists it or its hook waits                       |
| Session check     | 1 minute   | How often a harness that can list its sessions is asked which of them still run                                          |
| Window notice     | 10 minutes | An agent that waits for a person at its own window is said so to whoever handed it a job, and not again within this time |
| Person's answer   | 4 hours    | The person is reminded of a letter that waits for them. After as long again the job fails                                |
| Delivery          | 5 attempts | Retried with a growing wait, then left for the inbox                                                                     |

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

## Agents the bridge hosts

Claude Code and Codex live in their own apps. Any other agent can live in the host: the bridge starts a session for a job, hands it the job's first letter as its turn, and takes the agent's answer for the job's report. The agent needs no tool to report, and one that fails reports that.

```typescript
import { Agent, Cogitator } from '@cogitator-ai/core';
import { cogitatorSessions, hostBridge, hostedAdapter } from '@cogitator-ai/bridge';

const cogitator = new Cogitator({ memory: { adapter: 'memory' } });
const reviewer = new Agent({
  name: 'reviewer',
  model: 'ollama/qwen3.5:4b',
  instructions: 'You review diffs. The first line of a letter says who sent it.',
});

const host = await hostBridge({
  adapters: [
    hostedAdapter({
      harness: 'qwen',
      steer: true,
      open: cogitatorSessions({ runtime: cogitator, agent: reviewer }),
    }),
  ],
});
```

Now `delegate qwen "Review the diff"` from a Claude Code window starts a run of `reviewer` and wakes the window with its answer. Every session keeps its own thread, so with memory configured the agent remembers its earlier turns. An answer or a note that arrives while a run goes on steers it in the middle, a second job waits for its own turn, and so does what is written about it meanwhile. A job that is canceled stops the run that carries it out, and one canceled before its turn is never started. A run that pauses for an approval or for a question of a tool fails its job, since nobody is there to answer: give a hosted agent the permission rules it needs before it starts.

An agent of the [Agent Client Protocol](https://www.npmjs.com/package/@cogitator-ai/acp), such as Gemini CLI, is hosted the same way through `AcpAgentProvider`. Nobody sits at a session the bridge started, so a call the provider's rules do not settle is asked through the bridge: the agent that handed the job over answers within its own rights, the person for the rest. A tool call of a runtime agent that needs approval goes the same way. A provider works in the folder of its workspace whatever folder a job names, so say where that is with `root` (a job for another folder is refused), or give `provider` as a function that makes one for the folder of each session:

```typescript
import { AcpAgentProvider, resolveAcpAgent } from '@cogitator-ai/acp';
import { hostedAdapter, providerSessions } from '@cogitator-ai/bridge';
import { LocalWorkspace } from '@cogitator-ai/core';

const workspace = new LocalWorkspace({ root: process.cwd() });
const launch = await resolveAcpAgent('gemini');
const provider = new AcpAgentProvider({
  agent: { command: launch.command, args: launch.args },
  workspace,
  name: 'gemini',
  permissions: { rules: { allow: ['Bash(pnpm test *)'] } },
});
const gemini = hostedAdapter({
  harness: 'gemini',
  open: providerSessions({ provider, root: process.cwd() }),
});
```

A session of a provider stays in the folder it was opened for: a later job for a folder outside it fails with that reason.

`open` returns a session: anything with a `turn(text, { job })` whose `result` resolves with the agent's answer, so a session of your own is a few lines. Hosted sessions live in the host's process and end with it.

## The tools in your own process

`cogitator bridge mcp` is a few lines over `@cogitator-ai/bridge/tools`, which needs `@cogitator-ai/core`:

```typescript
import { MCPServer } from '@cogitator-ai/mcp';
import { bridgePaths } from '@cogitator-ai/bridge';
import { BRIDGE_INSTRUCTIONS, bridgeTools } from '@cogitator-ai/bridge/tools';

const server = new MCPServer({
  name: 'cogitator-bridge',
  version: '1.0.0',
  transport: 'stdio',
  instructions: BRIDGE_INSTRUCTIONS,
});
server.registerTools(bridgeTools({ socketPath: bridgePaths().socket }));
await server.start();
```

Every call reaches the dispatcher on a connection of its own, so the server may start before the dispatcher and lives through its restarts. Who calls is read from each call, not once (`callerOfToolCall`): the hint a hook of the harness added to the arguments, else the thread Codex names in `_meta`, else the environment of the server.

`claudeSetup()` and `codexSetup()` are what `cogitator bridge install` runs. `install()` and `uninstall()` return steps, each with a title, the command it runs or the lines a file gains, and an `apply()`: nothing changes until a step is applied, and a harness that is set up has no steps.

```typescript
import { claudeSetup } from '@cogitator-ai/bridge';

const setup = claudeSetup({
  toolsServer: { command: 'cogitator', args: ['bridge', 'mcp'] },
});
const steps = await setup.install({
  project: process.cwd(),
  scope: 'project',
  notes: true,
  takeJobs: false,
  allowTools: true,
});
for (const step of steps) console.log(step.title, step.lines);
```

Pass `toolsServer` to `claudeCodeAdapter()` and `codexAdapter()` too, and the sessions they start get the tools: Claude Code with `--mcp-config`, the hook that names the session and the rule for the tools, Codex as overrides of its configuration.

## Adapters

An adapter tells the bridge how to reach the sessions of one harness. `claudeCodeAdapter()`, `codexAdapter()` and `hostedAdapter()` are the ones above. `cogitator bridge serve` runs the first two as they come. To choose the permission mode of Claude Code sessions or the sandbox of Codex threads, or to add hosted agents, host the dispatcher in a process of your own:

```typescript
import {
  claudeCodeAdapter,
  codexAdapter,
  cogitatorSessions,
  hostBridge,
  hostedAdapter,
} from '@cogitator-ai/bridge';

const host = await hostBridge({
  adapters: [
    claudeCodeAdapter({ permissionMode: 'acceptEdits' }),
    codexAdapter({ sandbox: 'read-only' }),
    hostedAdapter({ harness: 'qwen', open: cogitatorSessions({ runtime: cogitator, agent }) }),
  ],
});
```

The port is small enough to write an adapter of your own:

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

| Member          | What it is for                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `deliver`       | Hands a letter to a session. Leave it out when the sessions wait for their mail themselves, as Claude Code's do |
| `createSession` | Starts a session for a job, and may hand it the first letter while it does                                      |
| `identify`      | Tells which session a process belongs to, from its environment or from what the harness wrote to its hook       |
| `toolCallHook`  | Answers the hook a harness runs before a bridge tool call, so the call carries the session that makes it        |
| `liveSessions`  | Lists the sessions that run, so the bridge knows a closed one from a quiet one                                  |
| `health`        | What `cogitator bridge doctor` shows: versions, the commands the bridge needs, each with what to do about it    |
| `attach`        | Gets the calls the adapter's own sessions make, such as to report                                               |
| `close`         | Stops what the adapter runs when the dispatcher closes                                                          |

`deliver` may return `{ note }`: something a person should know about the delivery, kept in the journal.

`@cogitator-ai/bridge/testing` has what the adapters of this package are tested with. `adapterConformanceCases(target)` is the adapter contract as cases to run against your adapter and its harness. `installFakeHarnesses()` puts stand-ins of the `claude` and `codex` commands on a `PATH`: they keep background sessions, fire hooks, hold queues and run a scripted turn, so code that drives the real command lines is tested without them. They run MCP servers the way the real ones were measured to (`claude mcp`, `codex mcp`, the environment a server gets, what a tool call carries, the tools a session nobody sits at may call), and keep the commands of a sandboxed Codex thread from sockets and from writing outside its folder, so a test shows what works from a sandbox.

```typescript
import { adapterConformanceCases } from '@cogitator-ai/bridge/testing';

for (const conformance of adapterConformanceCases(target)) {
  it.skipIf(conformance.skip !== undefined)(conformance.name, () => conformance.run());
}
```

## Trust

The bridge is a tool of one person on one machine. The socket and the database are created for their owner only, a folder or a database that belongs to another user is refused, and every process of that user can connect: read any job and letter, and call as a session by naming its id. A job is done inside the project it is handed over in, or the worktree its caller works in. A session the bridge starts reads the whole project and changes files only in the folder of its job: a Claude Code session runs in `acceptEdits` mode unless you choose another (`claudeCodeAdapter({ permissionMode })`, `bridge serve --claude-mode`), a Codex thread in the `workspace-write` sandbox unless you choose another (`codexAdapter({ sandbox })`, `--codex-sandbox`), an agent behind a session provider in `acceptEdits`. Claude Code has a background session change the files of a git repository in a worktree of its own (`.claude/worktrees/<name>`, the branch `worktree-<name>`), so what such a session changed is there and not in your checkout, uncommitted unless it committed, and its report says where. What goes beyond that, a command, an address, a file elsewhere, is decided by the rules of the project and, where they are silent, asked through the bridge. An agent of the runtime has the permissions its own code gives it. A letter is text from another agent, never an order from you: every letter says so in its first line, and whether a session you opened takes a job without asking you is yours to say at `cogitator bridge install` (`--take-jobs`). A tool call names its session the way a connection to the socket does, and is believed the same way. Do not point `COGITATOR_BRIDGE_HOME` at a folder other users can write to. A permission request is judged by the settings files of the job's project as they are on disk when it is asked. An answer of the person comes over the socket from a connection that named no session: the command line refuses to answer for the person from inside a session of an agent, which keeps an agent from doing so by accident and does not stop a process that hides what it is. A Telegram chat is as private as the token of its bot. On Windows the dispatcher listens on a named pipe that other users of the same machine can reach, so run it only on a machine you do not share. The Claude Code and Codex adapters run on macOS and Linux.

## Errors

Every refusal is a `BridgeError` with a `code` to branch on and a message written for the agent that gets it: `not_registered`, `unknown_agent`, `ambiguous_agent`, `no_session`, `unknown_job`, `unknown_letter`, `not_a_party`, `job_finished`, `invalid_letter`, `invalid_input`, `depth_exceeded`, `budget_exhausted`, `loop_detected`, `needs_person`, `no_person`, `already_running`, `not_running`, `storage`.

## Documentation

Full guide: [cogitator.app/docs/bridge](https://cogitator.app/docs/bridge)

## Part of Cogitator

This package is part of the [Cogitator](https://github.com/cogitator-ai/Cogitator-AI) ecosystem, a self-hosted, production-grade AI agent runtime for TypeScript.

## License

MIT
