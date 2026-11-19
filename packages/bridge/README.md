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

| Tool       | What it does                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `delegate` | Hands a job to `codex`, `claude`, an agent by name or `auto`, with its type, context, checks and, when asked, a worktree |
| `build`    | Has a job done in a worktree, checked, reviewed by another agent and fixed by its author, in one go                      |
| `review`   | Has the work of a finished job reviewed by another agent, and its author fix what was found                              |
| `race`     | Hands the same job to several agents at once, each in a worktree of its own, and lays the results side by side           |
| `debate`   | Puts a question to several agents, who answer each other round by round until they agree                                 |
| `plan`     | Has several agents plan the same work apart, read the plans of each other, and settle on one plan they sign or object to |
| `ask`      | Asks the other agent of a job a question. The answer wakes the session                                                   |
| `answer`   | Answers a question another agent asked, or decides its permission request: allow, deny, or leave it to the user          |
| `report`   | Reports the result of a job handed to this session, which ends the job, with its lessons and, of a review, its findings  |
| `note`     | Tells the other agent something it need not answer                                                                       |
| `inbox`    | Reads the letters that wait, when nothing woke the session                                                               |
| `job`      | Shows one job: its state, and for a job of this session its latest letters                                               |
| `jobs`     | Lists the jobs this session handed over or carries out                                                                   |
| `cancel`   | Takes back a job this session handed over                                                                                |
| `diff`     | Shows what a job changed in the git worktree it was given: the files and the patch                                       |
| `accept`   | Takes the work of a finished job into the checkout of this session, staged and not committed, or as a branch             |
| `reject`   | Drops the work of a finished job with its worktree                                                                       |
| `remember` | Puts a note on the board of the project: a fact that cost time to find out, or what a job taught                         |
| `recall`   | Looks at the board: the notes that fit some words, or the newest, each with who said it                                  |
| `forget`   | Takes a note this session put on the board off it                                                                        |
| `agents`   | Lists the sessions the bridge knows in the project, and the agents it can start a session of                             |
| `suggest`  | Shows how the jobs of each agent went, and who the bridge would give a job of a type to now                              |

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

**Claude Code.** Nothing is pushed into a window from outside. After every turn a background hook of the session runs `cogitator bridge wait`, which waits at the dispatcher and, when a letter comes, exits with code 2 and the letter on stderr: that wakes the session with the letter as its next input (`asyncRewake` in Claude Code's hooks). Under the letter it adds one line saying how to answer through the bridge. While the hook waits the session is free, you can talk to it. A session sometimes ends its turn with its answer said only in its own window, where the agent that waits for the job does not read. So a session that has waited for mail for a minute with a job it has not reported on gets a reminder to report, as a letter that wakes it. When it does not react within the reply timeout of the job, the job fails with that reason, rather than staying open until its deadline. A session the bridge starts carries the hook itself. For the sessions you open yourself, `cogitator bridge install` puts it into the project's `.claude/settings.local.json`:

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

A job also carries who handed it over and who carries it out, the project and the folder inside it, its checks, its budget and its depth. A job handed over from inside another job is part of it: it ends no later than its parent, and is canceled when its parent is over, whether that one was reported on, failed or was canceled. `verification` says whether the checks confirmed the result. A report is a claim, the verification is the fact, so an agent cannot set it: the bridge sets it when it has run the checks of the job, see below, and the process that hosts the dispatcher can record one of its own with `dispatcher.recordVerification(job, { verified, summary })`, which is not served on the socket. A job that is done in a worktree of its own also carries `worktree` (the folder, the branch, the commit it started from, and how its work ended) and `changes` (what it had changed when it reported).

## A worktree of its own, checks, and taking the work

A job that changes files next to others that do gets a git worktree of its own. Checks say whether its result holds. And the work comes back when the agent that handed the job over takes it.

```typescript
const { job } = await bridge.createJob({
  to: 'codex',
  body: 'Raise the burst limit to 3 and cover it with a test.',
  worktree: true,
  checks: [{ command: 'pnpm --filter @app/limiter test' }],
});
// ...the report arrives, with what was changed and what the checks showed...

const seen = await bridge.diff({ job: job.number });
console.log(seen.files, seen.patch);

const taken = await bridge.accept({ job: job.number });
if (taken.state === 'conflict') console.log('Would conflict in', taken.files);
// or: await bridge.accept({ job: job.number, asBranch: 'feat/burst' })
// or: await bridge.reject({ job: job.number, reason: 'Superseded' })
```

**The worktree.** With `worktree: true` the bridge starts a session for the job and puts it in `.cogitator/worktrees/job-<number>-<title>` under the main checkout of the project, on a branch `cogitator/job-<number>-<title>`, made from the commit the caller's checkout is at. It is a git worktree, not a copy: history is shared and only the working files are new. So what the caller has not committed is not there, and neither is anything git ignores, such as installed dependencies and build output. The letter that hands the job over says all of this to the agent. A job without `worktree` is done in the folder it was handed over for, which is right for a job that only reads and for a single job that writes. A session that is open already cannot be moved, so a job with a worktree always gets a session of its own, also when the address is a harness word and a session of it is open. That session is its job's alone: a harness word never reaches it, and it is taken for gone when the worktree is removed. No more than two jobs of one project are in progress in worktrees at once: each builds and tests next to the others, and memory runs out before disk does.

**What was changed.** When the job is reported on, the bridge reads the worktree itself: the commits made there, what was left uncommitted and the files that are new, without what git ignores. It reads them through an index of its own, so it touches nothing, and an agent that cannot commit is read like one that did (a Codex thread in its sandbox cannot: the git folder of a worktree lies outside it). The report then ends with a line of the bridge: how many files, how many lines, which files. `diff({ job })` shows the files and the patch at any time, while the job runs too, to the two agents of the job.

**Checks.** A job's `checks` are shell commands. When the job is reported on as done, the bridge runs them where the job was done, one job after another, and holds the report back until they end: the agent that handed the job over gets the report with the verdict under it, `Verified` only when every check ran and passed, and with the end of what a failed check printed. The bridge runs these commands itself, outside any sandbox, so it runs only those the rules of the agent that handed the job over allow without asking, judged like a permission request. A command they forbid, one they would ask the person about, and any command on a bridge that was given no rules is left out, and a result with a check left out is not verified. A check runs for ten minutes at most unless it names its own `timeoutMs`. A dispatcher that stops in the middle leaves the report held, and the next one runs the checks again. `job.verification` keeps the verdict and every check's result.

**Taking the work.** `accept({ job })` is for the agent that handed the job over, once the job is finished, however it ended. The bridge puts everything the worktree holds into one commit that is on no branch, works out whether it merges into the checkout the caller is in, and when it does, brings it in as one change that is staged and not committed (`git merge --squash`). The commit, with its message and the hooks of the project, is the caller's to make. When files would conflict, nothing is touched: the answer is `{ state: 'conflict', files }` and the worktree stays. The checkout has to be free for that: while changes are staged there, or git is in the middle of a merge or a rebase, the work is not brought in and the error says why, since what was staged before could not be told from the work afterwards. When git refuses because files the work changes have changes of their own there, the error says what git said, and the checkout is as it was. `accept({ job, asBranch })` leaves the work as a branch instead, the one of the worktree or one that is named, for a change that goes on as a pull request. `reject({ job })` drops the work. Either way the worktree is removed. The bridge never merges into a branch nobody is working on, and never pushes.

**What nobody came for.** The worktree of a finished job is kept for seven days. Then the bridge puts its work away as a commit under `refs/cogitator/discarded/job-<number>`, removes the worktree and its branch, and tells the agent that handed the job over where the work is (`git show refs/cogitator/discarded/job-<number>`). Nothing is removed before its work is kept: a worktree git cannot read stays where it is.

## What a job is handed over with, and the board

Agents do not see each other's conversations. So a job comes with what its caller knows, and the agents of a project share a board of notes.

```typescript
import { hostBridge } from '@cogitator-ai/bridge';
import { memoryBoard } from '@cogitator-ai/bridge/memory';

const board = await memoryBoard({ store: './bridge-memory.db' });
const host = await hostBridge({ board });

await bridge.createJob({
  to: 'codex',
  body: 'Raise the burst limit of the limiter to 3.',
  context: {
    done: ['The burst test passes'],
    constraints: ['Do not touch the public API'],
    decisions: ['The limit stays per user'],
    files: [{ path: 'src/limiter.ts', lines: '120-180', why: 'the window' }],
  },
});

await bridge.remember({ text: 'The limiter tests need Redis on port 6380' });
await bridge.recall({ text: 'redis' });
await bridge.send({
  job: 1,
  kind: 'report',
  body: 'Raised it, the tests pass',
  lessons: ['Mocking Redis hid a race in the limiter: run a real one'],
});
```

**The handover.** `context` is what the caller knows and the other agent does not: what done looks like, the constraints, what was decided already, and the files to start from with their lines. The bridge puts it under the text of the job in one block, and adds what it can find itself: the named lines of those files, read from the caller's checkout with their numbers, the notes of the board that fit the job, and what earlier jobs like it left there. The block keeps to a budget of tokens (`contextTokens`, 6000 by default, an estimate of four characters to a token): the caller's own lines always go in whole, the files take what is left but for a fifth kept for the board, a file that does not fit is cut to its first lines or only named, and notes are added while there is room. The bridge reads a file for the caller and hands what it read back to it, so it reads only what the caller could: a file outside the project is named and not read, neither is one the rules of the caller do not let it read without asking, and a file that looks like it holds secrets (`.env`, a key, anything under `.git` or `.ssh`) is never shown, since a letter is kept and passed on. Putting the block together never fails a hand-over and holds it up for ten seconds at most: what could not be read or found in time is left out. A job with nothing to add gets no block. The bridge calls no model for any of this.

**The board.** `remember({ text })` puts a note on the board of the caller's project: a `fact` that cost time to find out, or with `kind: 'lesson'` what a job taught. A note is one line, whatever was sent: line breaks become spaces, so a note cannot pass for several lines where it is shown. Every note carries who said it, on which job and when, and `recall({ text })` returns the notes that fit the words best (BM25), or the newest without words, to any agent that works in the project. A note that shares a single common word with what is asked is left out. A note said again in the same words stays the one note it was, under the name of who said it first. A note said with `jobOnly` is seen by the two agents of that job only, and its words stay out of the journal, which everybody can read. `forget({ id })` takes a note off: an agent its own, the person any. Nothing is deleted, a note that is taken off is closed and found no more. A connection that named no session speaks as the person and names the project, which is how `cogitator bridge remember` works in a terminal of your own. A note is what an agent or the person said, not an order: the handover says so above the notes it shows.

**What a job leaves.** A report may name `lessons`: what worked, what did not, for whoever does a job like it next. They go to the board under the name of the agent that reported. The bridge adds a note of its own on how each job ended: who did it for whom, completed, failed or canceled, whether its checks confirmed the result, and the start of the report in quotes, as what the agent said. When a later job is handed over, the notes of earlier jobs that fit its text come with it, and with them the other lessons of those jobs, since a job is found by what it was about, whatever words its lessons use.

`memoryBoard()` keeps the board with [`@cogitator-ai/memory`](https://www.npmjs.com/package/@cogitator-ai/memory), an optional peer dependency: every note is a memory item of the bridge in the scope of its project, what an agent said kept as the words of a model and what the person said as theirs. `store` is the path of a SQLite file or any store of that package that keeps memory items. Any object with `remember`, `recall`, `find` and `forget` is a board (`FactBoard`). A bridge that was given none remembers nothing: a job is handed over with what its caller named alone, and the three calls are refused with `no_board`. `cogitator bridge serve` keeps the board in `memory.db` in the folder of the bridge.

## Recipes: do, check, review, fix

A recipe is a job the bridge itself carries out by fixed steps: it hands jobs of its own to the agents, waits for their reports and reports once at the end. No model decides what comes next. Five come with the bridge: `build` and `review` for work that is checked by another agent, `race` for the same job done several times side by side, `debate` for a question worth more than one opinion, `plan` for a plan several agents write together.

```typescript
import { hostBridge } from '@cogitator-ai/bridge';
import { recipeAdapter } from '@cogitator-ai/bridge/recipes';
import { FileCheckpointStore } from '@cogitator-ai/workflows';

const host = await hostBridge({
  adapters: [claude, codex, recipeAdapter({ checkpoints: new FileCheckpointStore('./recipes') })],
});

await bridge.createJob({
  to: 'recipe',
  body: 'Add a rate limiter to the gateway. Cover the burst case.',
  recipe: {
    name: 'build',
    input: { to: 'claude', checks: [{ command: 'pnpm test' }], rounds: 2 },
  },
});
```

**The conductor.** `recipeAdapter()` adds an agent without a model to the bridge, the conductor, under the harness word `recipe`. A job that names a `recipe` goes to a conductor of its own, and the jobs it hands out are part of that job: its budget and its deadline hold for all of them, canceling it cancels them, and whoever started the recipe may look at their work with `diff` and, once the recipe has reported, take it with `accept`. Letter ids that start with `recipe-` or `relay-` are the conductor's own. The conductor has no rules of its own. A check of a step and a call an agent asks leave for are judged by the rules of whoever started the recipe: what those allow without asking is allowed, the rest is the person's to allow. A question of an agent that works on a step is passed on to whoever started the recipe, and the answer back, each quoted as the words of who wrote them. A note of whoever started the recipe on its job reaches the agents that work on it right now. While a question waits for the person, the step that asked waits with it and is not failed by its clock. A recipe the conductor does not know, or an input it cannot start with, is refused when the job is handed over, with the reason. The worktree, the checks and the context of the work are named in the input of the recipe, not on its job.

**`build`: do, check, review, fix, check.** The text of the job is handed to `to` as a job in a git worktree of its own, with the `checks` of the input, which the bridge runs when the work is reported on. Then another agent reviews the work and names its findings. The reviewer judges the work against the job: what it notices beside the job, such as a fault that was there before in code the job had no need to change, is a finding of its own kind that holds nothing up (see Findings below). While a finding of the work at or above `threshold` is open or the checks do not pass, the author is sent back with the findings, the checks run again, and the reviewer looks again, `rounds` times at most. A round of fixes that leaves no fewer such findings open than there were before it ends the review even with rounds left: one more of the same would not end it, and the report says so. The one report at the end says how the review ended, round by round, carries the findings of the last review, lists apart what the reviews noticed beside the job, and names the job whose worktree holds the work. Its work is taken or dropped once the recipe has reported. A review that is not clean when the rounds run out does not fail the recipe: the work is there, and taking it is the caller's decision. A check the bridge did not run, because the rules do not allow it without asking, sends nobody back: the report says the result is not verified. The recipe fails when the work itself was not done, or no review of it was.

**`review`.** The same rounds for a job that is done already: `input.job` names it, and its author fixes what the review finds. Whoever handed that job over, carried it out, or started the recipe it was a step of may have it reviewed. The review and the fixes are done in the folder the job was done in. While a job still works on what another job left in its worktree, that worktree stays: `accept` and `reject` are refused until the review has reported or is canceled.

**`race`: the same job, side by side.** The text of the job goes to every agent of `to` at the same time, each in a git worktree of its own, with the `checks` of the input. The report lays the attempts side by side: which finished, what its checks showed, how much it changed. With a `judge`, another agent reads the attempts that finished and ends with the one it would take. The recipe takes none itself: whoever started it takes one with `accept` and drops the others with `reject`. The same harness word twice means two sessions of that harness. The bridge keeps two worktrees of a project in progress and starts two sessions at once (see the limits), so attempts beyond that wait their turn. An attempt the bridge refuses, and a judge it cannot reach, are said in the report, which still lays out the rest. The recipe fails when no attempt finished.

**`debate`: a question, round by round.** The rules are those of the `debate` strategy of [`@cogitator-ai/swarms`](https://www.npmjs.com/package/@cogitator-ai/swarms), with sessions of any harness as the debaters. In the first round each debater answers the question alone. From the second on each sees what the others said in the rounds before, answers them, and ends its turn with `STANCE: agree` or `STANCE: disagree`. The debate ends when every debater that took part agrees in the same round, or after `rounds` rounds: one that argued before and gives no answer now has not agreed. An `advocate` argues for, a `critic` against, any other `role` is told to the agent as it is. With a `moderator`, another agent sums the debate up: the positions, what is agreed and what is not, the strongest arguments and a recommendation. Without one the report carries the positions of the last round. No file is changed. Every debater reads the question whole in every round, so it takes 20000 characters at most, and debaters times rounds is 40 at most. A turn the bridge refuses to hand over, and a moderator it cannot reach, are said in the report, which still carries what the others said. The recipe fails when fewer than two debaters answered.

**`plan`: one plan of several minds.** The agents of `planners`, two to four, plan the same work. In the first step each writes a plan apart, as the report of its job: the bridge keeps the drafts as files only once all of them are in, so no planner starts from the plan of another. Each then reads the plans of the others, checks them against the code and reports a critique: what the other plan does better, what in it is wrong or missing, what lies beside the work. The first planner merges all of it into one plan, `plan.md`, and writes to `decisions.md` what it did with every point of the critiques. The others read both and end with `VERDICT: signed` or `VERDICT: objections`, each objection on a line `OBJECTION: <heading> - <what is wrong>`, and the merger answers the objections in the plan or declines them with its reason, `rounds` times at most. The recipe ends when every checker signs at the same check, when the rounds run out, when a round of answers leaves no fewer objections open than the one before, or when the merger gives no answer. What is still open then is in the report and under a heading of its own at the end of the plan, for whoever started the recipe to decide on. The files of a run lie in `.cogitator/plans/job-<number>` under the folder the recipe was started in, which git ignores, and `out` names where a copy of the plan goes: a path inside the repository at which nothing is yet, checked before any agent is asked. No planner is to change another file, and the report names what changed in the repository while the plan was written. A planner that wrote no draft takes no further part, and when the first planner leaves no plan the next one is asked to merge. The recipe fails when fewer than two planners wrote a draft, when nobody merged the drafts, or when nobody checked the merged plan: the plan of one agent is no joint plan. To have the plan built, hand it to `build` or `delegate` with the commands of its Checks section as the checks.

| Input               | Recipe   | What it says                                                                                                                       |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `to`                | `build`  | Who does the work: a harness word such as `claude`, for a session started for the job                                              |
| `job`               | `review` | The job whose work is reviewed                                                                                                     |
| `by`                | both     | Who reviews: an agent, or a harness word for a fresh session. Another harness than the author's by default                         |
| `rounds`            | both     | How many times the author is sent back at most: 2 by default, 1 for work of the type `fix`, 0 for a review that sends nothing back |
| `threshold`         | both     | The lightest finding worth sending back: `blocker`, `major` (the default), `minor` or `nit`                                        |
| `focus`             | both     | What the reviewer looks at above all                                                                                               |
| `checks`            | `build`  | The commands that show the result holds, run after the work and after every round of fixes                                         |
| `worktree`          | `build`  | `false` to have the work done in the caller's folder                                                                               |
| `context`           | `build`  | What the caller knows and the agent does not, as `createJob` takes it                                                              |
| `to`                | `race`   | Who does the job: two to six harness words, the same one twice for two sessions of one harness                                     |
| `checks`, `context` | `race`   | As for `build`, for every attempt                                                                                                  |
| `judge`             | `race`   | Who compares the attempts and says which to take, nobody by default                                                                |
| `debaters`          | `debate` | Who debates, two to six: each a harness word or an agent, or `{ to, role }`                                                        |
| `rounds`            | `debate` | How many rounds at most, 3 by default                                                                                              |
| `moderator`         | `debate` | Who sums the debate up, nobody by default                                                                                          |
| `planners`          | `plan`   | Who plans, two to four harness words or agents. The first merges                                                                   |
| `rounds`            | `plan`   | How many times the merger answers objections at most: 2 by default, from 0 to 5                                                    |
| `out`               | `plan`   | Where a copy of the plan goes: a path inside the repository at which nothing is yet                                                |
| `context`           | `plan`   | As for `build`, for every planner                                                                                                  |

**Findings.** A reviewer names what it found in the `findings` of its report, each with a severity (`blocker`, `major`, `minor`, `nit`), a line of what is wrong and, where it has one, the file and the line. An agent without the tools writes one line for each, `[major] src/limiter.ts:12 - The window never resets`, or the single line `[none]`: `parseFindings` reads them. An empty list says the review found nothing. A finding with `beside` set, `[beside major] src/cache.ts:9 - The cache was never bounded` in a line, is what the reviewer noticed beside the work under review: a fault that was there before the job in code it had no need to change, or a case the job does not ask for. It is not sent back to the author, does not hold the work up whatever it weighs, and does not count against the author: the report of the recipe lists such findings apart, for whoever started it to decide on. A report that names no findings in either form is not a clean review: the recipe then sends nothing back and hands the report on as it is. The findings of a report are kept on its job (`job.findings`) and shown under the report.

**Who does a later step.** The fixes go back to the author and the second look to the first reviewer when the bridge can wake them: `wakes(agent)` says whether a session waits for its mail or its harness wakes it for a letter. One that would only find the letter when a person opens it, such as a Codex thread that is open nowhere while no local daemon runs, is not waited for. A fresh session of the same harness gets the step then, with what it needs to know in the letter: what the job was, where the work lies, and what was found.

**Leave for what a step runs.** An agent that works on a step asks leave for a call its rules do not settle, and the rules that count are those of whoever started the recipe. A reviewer nearly always starts with `git diff` and the tests of the project, so allow those in the settings of the project (`Bash(git diff:*)`, `Bash(git status:*)`, `Bash(npm test:*)`) for a recipe to run without you. Agents like to run several of them as one line and cut the output short: a line such as `git status && git diff && npm test | tail -20` is allowed when every command of it is, so allow `Bash(tail:*)` and `Bash(head:*)` too. What they do not allow waits for you in `cogitator bridge asks`, and the step waits with it.

**After a restart.** Every run is a workflow of [`@cogitator-ai/workflows`](https://www.npmjs.com/package/@cogitator-ai/workflows), an optional peer dependency, with a checkpoint after each step. A step hands its job over under an id made of the run and the step, so a step that runs again finds the job it handed over the first time. With checkpoints that outlive the process (`FileCheckpointStore`), a dispatcher that is started again picks every open recipe up where it was, and nothing is done twice. `cogitator bridge serve` keeps them in `recipes` in the folder of the bridge. In memory, the default, a run that was cut off starts its steps over and still finds the jobs it handed over.

**A recipe of your own** is a workflow whose steps hand jobs over through the run:

```typescript
import { defineRecipe, recipeAdapter, type RecipeState } from '@cogitator-ai/bridge/recipes';
import { WorkflowBuilder } from '@cogitator-ai/workflows';
import { z } from 'zod';

const secondOpinion = defineRecipe({
  name: 'second-opinion',
  summary: 'The same question to two agents, both answers side by side',
  input: z.object({ to: z.array(z.string()).length(2) }),
  workflow: (input, run) =>
    new WorkflowBuilder<RecipeState & { first?: string }>('second-opinion')
      .initialState({})
      .addNode('first', async () => {
        const { report } = await run.handOver('first', { to: input.to[0], body: run.task });
        return { state: { first: report } };
      })
      .addNode(
        'second',
        async ({ state }) => {
          const { report } = await run.handOver('second', { to: input.to[1], body: run.task });
          return { state: { report: `${state.first}\n\n${report}` } };
        },
        { after: ['first'] }
      )
      .build(),
});

recipeAdapter({ recipes: [secondOpinion] });
```

`run.handOver(step, job)` resolves when the job is over, with its checks run, however it ended. A step runs again when the dispatcher stopped in the middle of it, so keep what a step learned in the state, and lay rounds out as steps of their own, one after another, each of which looks at the state and does nothing when it is not needed.

## The scoreboard, and leaving the choice to the bridge

The bridge keeps what became of every job that ended, and says from it who a job should go to.

A job has a type, one word such as `code`, `fix`, `review`, `docs` or `research`, and `general` when it names none. The steps of the recipes name theirs: `build` and `race` hand the work over as `code` unless the job of the recipe says otherwise, fixes as `fix`, reviews as `review`, the judge of a race as `judge`, the turns of a debate as `debate`, the steps of a plan as `plan`.

```typescript
await bridge.createJob({ to: 'codex', body: 'Fix the burst limit', type: 'fix' });

const results = await bridge.results({ type: 'fix' });
// [{ job: 12, agent: 'codex@app', harness: 'codex', type: 'fix', outcome: 'good',
//    grounds: ['its checks passed'], verified: true, durationMs: 240000, letters: 3, person: 0 }]
```

**What a result rests on.** An agent saying it is done is no evidence. A job is `bad` when its agent failed it, when one of its checks ran and did not pass, or when a review of its work found a blocker or a major finding in the work itself: what a review noticed beside the job counts against nobody. Otherwise it is `good` when its checks passed, a review found nothing that heavy, or its changes were taken out of its worktree with `accept`. A job that ended with none of that is `unknown`, and counts neither for nor against anybody. Work that was dropped says nothing either: in a race every attempt but one is dropped. A check the bridge left out is no failure of the work, and taking a worktree that holds no change confirms nothing. Neither do checks that pass in a worktree the job changed nothing in: they passed before it began. Canceled jobs are not kept, and neither is the job of a recipe: its steps are jobs of their own.

A failure counts against an agent only when it was the agent's doing: it reported the job as failed, it went silent (did not take the job, answer what it owed an answer to, or report after it was reminded), or the job ran out of its time. A session the bridge could not start, a budget of letters both sides used up, a caller or a person that did not answer: these end a job as `failed` and its result as `unknown`. The record of the job says which it was in `failure`.

A review counts on the job it reviews. The recipes say which job that is. A review handed over by hand names it, which only a party to that job or whoever handed it over may do:

```typescript
await bridge.createJob({ to: 'claude:new', body, type: 'review', reviewOf: 12 });
```

Its findings are read from the `findings` of its report, or from lines of the form `[severity] file:line - what is wrong` in the text. A review that fails, or says nothing the bridge reads, counts for nothing. Neither does a review by the agent that did the work, or one that agent had made of its own work: nobody rates itself. The first 20 reviews of a job are the ones kept, so a later one cannot push a finding out.

A result also says how long the job took, how many letters it used, and how many times it needed the person: a letter of it waited for them, or its agent waited for one at its own window. A wait at a window counts on every job the session carries out, since the bridge cannot tell which of them the dialog is for.

**`suggest`.** It rates every harness the bridge can start a session of: the share of its jobs that held among those somebody checked, with the 95% Wilson interval of that share (`wilsonCI` of [`@cogitator-ai/evals`](https://www.npmjs.com/package/@cogitator-ai/evals)). That interval keeps its width when every job went the same way: five out of five is 57% to 100%, not a certainty. Harnesses are ordered by the lower end of their interval, what each is good for at least, so three clean jobs do not outrank forty out of forty-two. Where the lower ends are the same, the higher upper end goes first: a harness nobody checked yet may still be anything, and comes before one that is known to do badly.

```
$ cogitator bridge suggest code
How code jobs of the last 60 days went:
  codex   12 of 14 held (86%, 60%-96%). median 4 min, 3.2 letters and 0.1 calls for the person a job  <- auto takes this one
  claude  7 of 10 held (70%, 40%-89%). median 6 min, 4 letters and 0 calls for the person a job
codex: 12 of 14 held (86%, 60%-96%) over code jobs. Against claude 7 of 10 held (70%, 40%-89%). The intervals overlap: the difference is not established, this is the better guess
```

It does not claim to know more than it does. While a harness a job can go to has finished fewer than 5 jobs, the one that has done the fewest takes the next: otherwise the first harness would get every job and the others would never be known. The reason says that this is a trial, not a rating. After that a harness needs 5 checked jobs to be rated. When no harness a job can go to has that many of the type asked for, the jobs of every type decide, and the reason says so. When those are too few as well, the answer is "not enough data", and the order of the adapters decides. Results older than 60 days are left out: the models and the harnesses behind an agent change.

**`auto`.** A job handed to `auto` goes to the harness `suggest` names for its type: to its session in the project when there is one that wakes for a letter, to a fresh one otherwise, and always to a fresh one with `auto:new`. A session the caller works for is never taken: it waits for the caller, and would then be waited for by it. When the bridge can start no session of the first choice right now, the next one takes the job. A review (`reviewOf`) goes to another harness than the one that did the work whenever there is one. `createJob` says why in `routed`, the record of the job keeps it, and the tools and the command line show it. `auto` is an address like any other, so it also names who does the work of a `build`, who reviews it, and the seats of a race.

```typescript
const { job, routed } = await bridge.createJob({ to: 'auto', body, type: 'code' });
// job.to: 'codex@app'
// routed: 'codex: 12 of 14 held (86%, 60%-96%) over code jobs. Against claude ...'
```

## When an agent runs out of its limit

A subscription has limits, and a model provider refuses a key that sent too much. The bridge takes that for what it is: no failure of the job, and no reason to stop.

It learns of a limit from what the harness itself says, never from what an agent wrote:

- **Codex.** A thread the bridge started with `codex exec` ends its turn with the words of Codex (`You've hit your usage limit. Try again at 3:07 PM.`), which the adapter reads from the failure of the turn.
- **Claude Code.** `cogitator bridge install` and every session the bridge starts carry a `StopFailure` hook for the errors `rate_limit` and `billing_error`, which Claude Code runs when a turn ends on one (`cogitator bridge limited`). The time the limit is over is read from the text Claude Code shows (`resets 3:45pm`), the only place it tells it.
- **Hosted agents.** A turn that fails with a rate limit or a used-up quota of its provider: `limitOfError` reads the error codes of the Cogitator runtime and nothing else, since a turn also fails with what tools and other services said. `hostedAdapter({ limitOf })` takes your own reading, such as `limitOf` on the message of an agent behind ACP.

What happens then:

1. The harness is noted as out of its limit until the time it named, or for 30 minutes when it named none, after which the bridge simply tries it again. Of two limits the longer one stays: a session that names no time cuts none short. `status()` lists these in `limited`, `cogitator bridge status` and `cogitator bridge limits` show them, and the person is told once.
2. No job goes to it meanwhile: `auto` passes it over, `suggest` says why, and a job addressed to it is refused with `limit_reached` and the time it is back.
3. The jobs the session was carrying out go to a fresh session of another harness, the one `suggest` names for their type. It works in the same folder, the worktree of the job when it has one, and is told who had the job before and to look at what is there first. Whoever handed the job over gets a note and has nothing to do: the job keeps its number and its letters, gets its time anew, and `redirects` on its record says who had it. Jobs the old agent had handed on from inside it are canceled. When a session carried several jobs, their new sessions start one after another, no more at once than the bridge starts otherwise.
4. A job nobody else can take fails, and not by the doing of its agent: the scoreboard holds it against nobody.

A step of a recipe that would go back to an agent whose harness is out of its limit goes to a fresh session of whoever takes jobs instead.

The limit is forgotten when its time is over, when an agent of that harness finishes a job, which shows it works again, or when you say so: `cogitator bridge limits --clear codex`.

A Claude Code session whose turn ended on its limit runs no hook that waits for mail, so nothing wakes it until a person opens it again. The bridge takes it out of its address book until then, and it is back with its first call.

**A harness of last resort.** `routing.fallback` names harnesses that take a job only when no other can: `auto` tries them after every other harness, whether those ran into their limits or have no session to give right now, and a job whose agent ran into its limit goes to them last. `suggest` lists them at the end and says so. That is the place for an agent that costs money by the call, such as a hosted agent on an API key, next to agents on a subscription.

```typescript
const host = await hostBridge({
  adapters: [
    claude,
    codex,
    hostedAdapter({ harness: 'qwen', open: cogitatorSessions({ runtime, agent }) }),
  ],
  routing: { fallback: ['qwen'] },
});
```

On the command line: `cogitator bridge serve --fallback codex`, or `COGITATOR_BRIDGE_FALLBACK`.

What the bridge cannot see: a Codex thread a person opened, since nothing tells the bridge how its turn ended, and a Claude Code session without the hook. Their jobs end the way silent jobs do, by the reply timeout.

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

The one who asked does not get the answer as mail: it waits for it with `verdict({ letter })`, which answers the moment the request is decided. A request whose job ends first counts as refused. One that stops waiting takes its request back with `withdraw({ letter })`: nobody is asked to decide it any more, and an answer that comes late is refused instead of looking as if it let the call through. The same call may be asked for again once it was allowed, and is held back as a repeat once it was refused.

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

| Limit             | Default     | What happens                                                                                                                                             |
| ----------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depth             | 3           | A job handed over from inside a job from inside a job is the deepest. One more is refused                                                                |
| Letters per job   | 60          | The job fails, both sides are told. The report that ends the job always goes through                                                                     |
| Time per job      | 4 hours     | The job fails, both sides are told                                                                                                                       |
| Reply timeout     | 30 minutes  | The one who owes an answer, or did not pick a job up, is reminded. After as long again the job fails                                                     |
| Jobs out          | 20          | An agent with that many jobs still in progress cannot hand over another                                                                                  |
| Jobs per hour     | 60          | Handing over faster is refused as a loop                                                                                                                 |
| Sessions starting | 2           | No more sessions are started at once                                                                                                                     |
| Silence           | 12 hours    | A session with no job in progress is taken for gone, unless its harness lists it or its hook waits                                                       |
| Session check     | 1 minute    | How often a harness that can list its sessions is asked which of them still run                                                                          |
| Window notice     | 10 minutes  | An agent that waits for a person at its own window is said so to whoever handed it a job, and not again within this time                                 |
| Person's answer   | 4 hours     | The person is reminded of a letter that waits for them. After as long again the job fails                                                                |
| Delivery          | 5 attempts  | Retried with a growing wait, then left for the inbox                                                                                                     |
| Worktrees         | 2           | A third job of the project that asks for a worktree of its own is refused while two are in progress                                                      |
| Check             | 10 minutes  | A check that runs longer is ended with everything it started, and fails                                                                                  |
| Worktree kept     | 7 days      | The worktree of a finished job nobody took or dropped is removed, its work kept under a ref                                                              |
| Context           | 6000 tokens | The block the bridge adds under a job keeps to it: files are cut or only named, notes stop when it is full                                               |
| Context wait      | 10 seconds  | A job whose context could not be put together in that time is handed over without it                                                                     |
| Report reminder   | 1 minute    | A session that has waited for mail that long with a job it has not reported on is reminded to report. No reaction within the reply timeout fails the job |
| Limit retry       | 30 minutes  | A harness that ran into its limit and named no time for it takes no job that long, then is tried again                                                   |
| Scoreboard window | 60 days     | A job that ended longer ago is left out of the scoreboard                                                                                                |
| Scored jobs       | 5           | A harness with fewer jobs of a known outcome is not rated: the scoreboard says there is not enough to tell                                               |

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

The command line hosts such agents without any code: `cogitator bridge serve --agent qwen=ollama/qwen3-coder:30b --agent ds=deepseek/deepseek-chat` runs a coding agent of the runtime on each model, under the word before the `=`. It works in the folder of its job (the worktree, when the job has one), reads and changes files there without asking, as the Claude Code sessions the bridge starts do, and asks through the bridge for every other call. That makes a cheap or a local model a worker like any other: `build qwen "Add the parser" --by claude` has it write the draft and Claude Code review it, and `serve --fallback qwen` keeps it for when the agents on a subscription ran out of their limits.

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
import { MCPServer } from '@cogitator-ai/mcp/server';
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

## The agents, offered to the outside

The bridge reaches the agents of one machine. `@cogitator-ai/bridge/outward` puts them behind the two doors other agents already knock on: an [A2A](https://a2a-protocol.org) service and the tools of an MCP server. A message or a tool call from outside becomes a job of the bridge, and the report of the agent is the answer. It needs `@cogitator-ai/core`.

```typescript
import { A2AServer } from '@cogitator-ai/a2a';
import { a2aHono } from '@cogitator-ai/a2a/hono';
import { Hono } from 'hono';
import { serveAgents } from '@cogitator-ai/mcp';
import { bridgePaths } from '@cogitator-ai/bridge';
import { bridgeAgents } from '@cogitator-ai/bridge/outward';

const outward = await bridgeAgents({
  socketPath: bridgePaths().socket,
  project: process.cwd(),
  agents: ['codex', { to: 'claude:new', name: 'reviewer', description: 'Reviews a diff' }],
});

// an A2A service: each agent has a card and takes messages
const a2a = new A2AServer({
  agents: outward.agents,
  cogitator: outward.runtime,
  auth: { type: 'bearer', validate: async (token) => token === process.env.BRIDGE_DOOR_TOKEN },
});
new Hono().route('/', a2aHono(a2a));

// the tools of an MCP server: one for each agent
await serveAgents(outward.toolHost, Object.values(outward.agents));
```

`agents` takes what `delegate` takes: a harness, `claude:new`, `auto`, the name of a session. Without it every harness the bridge can start a session of is offered. The jobs are handed over in `project`, and each door is a session of its own in the book of the bridge (`outside@<project>`, `outside-2@<project>`), so `status`, `log` and the scoreboard show its jobs like any other and two doors never read each other's mail. `worktree: true` gives each job a git worktree of its own, `type` names them for the scoreboard, and `timeoutMs` takes a job back when it lasts longer. So does a caller that gives up: an aborted request, a tool call its client canceled, an A2A task canceled while its job runs. `close()` takes back every job the door still waits for.

A question of the agent pauses the run the way a question of a tool pauses a run of the runtime. Over A2A the task waits in `input-required` with the question, and the next message of the task is the answer. A new task in the same context means the caller moved on, and the job is taken back. A task canceled while it waits for an answer leaves its job waiting until the next message of its context, or until the bridge gives the job up. Over MCP a tool call cannot wait, so the answer of the tool says that the agent asks and names the thread, and a call with that `threadId` is the answer. One question waits at a time, a job that ended while its question waited answers with what it ended with, and when the bridge handed the job on to another agent in the meantime, the answer reaches that agent as a note.

`serveAgents` also registers an `<agent>_resume` tool for each agent, for approvals a run of the runtime pauses on. A job of the bridge never does, so the tool only refuses. `cogitator bridge offer` leaves it out: it registers the first tool `agentTools(outward.toolHost, [agent])` returns for each agent.

Leave for a call is asked through the bridge as for any job: what the rules of the project allow without asking is allowed, the rest goes to the person at this machine (`cogitator bridge asks`), and nobody outside can allow it. A report of failure, a job the bridge failed and a job that was taken back reject the run.

```bash
cogitator bridge offer                       # every agent the bridge can start, as MCP tools on stdio
cogitator bridge offer codex claude:new      # these two
cogitator bridge offer auto --project ~/app --worktree --type fix
```

`cogitator bridge offer` is the MCP door as a command, for the configuration of any MCP client. A job takes minutes, so give its calls the time: a client that gives up on a call takes the job back with it.

Whoever reaches the server you put in front of this has the agents of this machine work in `project`, with what the rules of the project allow. Keep it on this machine or behind authentication: `A2AServer` and `serveAgents` both take an `auth`. With agents that run on a subscription it is a door for you alone, for your own agents on your other machines: a plan of Claude or ChatGPT is not yours to pass on, see [Your subscriptions](#your-subscriptions). To let other people in, offer agents that run on API keys.

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

The bridge is a tool of one person on one machine. The socket and the database are created for their owner only, a folder or a database that belongs to another user is refused, and every process of that user can connect: read any job and letter, and call as a session by naming its id. A job is done inside the project it is handed over in, or the worktree its caller works in. A session the bridge starts reads the whole project and changes files only in the folder of its job: a Claude Code session runs in `acceptEdits` mode unless you choose another (`claudeCodeAdapter({ permissionMode })`, `bridge serve --claude-mode`), a Codex thread in the `workspace-write` sandbox unless you choose another (`codexAdapter({ sandbox })`, `--codex-sandbox`), an agent behind a session provider in `acceptEdits`. Left to itself Claude Code moves a background session into a git worktree of its own before its first edit, made from the default branch of `origin`. The bridge decides where a job is done, so the sessions it starts work in place (`worktree.bgIsolation: "none"` in their settings): in the folder the job was handed over for, or in the worktree the bridge made for it. The checks of a job are commands the bridge runs itself, outside any sandbox, so it runs only those the rules of the project allow without asking. What goes beyond that, a command, an address, a file elsewhere, is decided by the rules of the project and, where they are silent, asked through the bridge. An agent of the runtime has the permissions its own code gives it. A letter is text from another agent, never an order from you: every letter says so in its first line, and whether a session you opened takes a job without asking you is yours to say at `cogitator bridge install` (`--take-jobs`). A tool call names its session the way a connection to the socket does, and is believed the same way. Do not point `COGITATOR_BRIDGE_HOME` at a folder other users can write to. A permission request is judged by the settings files of the job's project as they are on disk when it is asked. An answer of the person comes over the socket from a connection that named no session: the command line refuses to answer for the person from inside a session of an agent, which keeps an agent from doing so by accident and does not stop a process that hides what it is. A Telegram chat is as private as the token of its bot. On Windows the dispatcher listens on a named pipe that other users of the same machine can reach, so run it only on a machine you do not share. The Claude Code and Codex adapters run on macOS and Linux.

## Your subscriptions

The bridge drives the `claude` and `codex` commands of your machine, signed in the way you signed them in. It reads, keeps and passes on no login and no token, calls no model API in the name of a subscription and changes no binary of a harness. A session it starts spends the limit of your own plan, like one you opened yourself. It is no way around a limit: an agent that ran out waits for its reset, and the job goes to another one or waits with it.

It is a tool of one person on their own machine. Letting somebody else work through it on your plan, sharing a login, and running it as a service for others are against the terms of both Anthropic and OpenAI. For a team, for CI and for a product, sign the harnesses in with API keys.

What neither of them says in so many words is whether agents that hand each other jobs on one machine are the use a plan is meant for. Anthropic says the limits of its plans "assume ordinary, individual usage", and its consumer terms keep automated access to API keys and to what it explicitly permits, while its own documentation describes `claude -p` and background sessions under a plan. OpenAI documents `codex exec` under a ChatGPT sign-in and recommends API keys for automation in shared environments. Read the terms of your plans, they change. When in doubt, use API keys.

## Errors

Every refusal is a `BridgeError` with a `code` to branch on and a message written for the agent that gets it: `not_registered`, `unknown_agent`, `ambiguous_agent`, `no_session`, `unknown_job`, `unknown_letter`, `not_a_party`, `job_finished`, `invalid_letter`, `invalid_input`, `depth_exceeded`, `budget_exhausted`, `loop_detected`, `needs_person`, `no_person`, `no_worktree`, `worktree_limit`, `no_board`, `already_running`, `not_running`, `storage`.

## Documentation

Full guide: [cogitator.app/docs/bridge](https://cogitator.app/docs/bridge)

## Part of Cogitator

This package is part of the [Cogitator](https://github.com/cogitator-ai/Cogitator-AI) ecosystem, a self-hosted, production-grade AI agent runtime for TypeScript.

## License

MIT
