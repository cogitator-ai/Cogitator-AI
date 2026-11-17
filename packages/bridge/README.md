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

| Tool       | What it does                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `delegate` | Hands a job to `codex`, `claude` or an agent by name, with its context, its checks and, when asked, a worktree          |
| `build`    | Has a job done in a worktree, checked, reviewed by another agent and fixed by its author, in one go                     |
| `review`   | Has the work of a finished job reviewed by another agent, and its author fix what was found                             |
| `ask`      | Asks the other agent of a job a question. The answer wakes the session                                                  |
| `answer`   | Answers a question another agent asked, or decides its permission request: allow, deny, or leave it to the user         |
| `report`   | Reports the result of a job handed to this session, which ends the job, with its lessons and, of a review, its findings |
| `note`     | Tells the other agent something it need not answer                                                                      |
| `inbox`    | Reads the letters that wait, when nothing woke the session                                                              |
| `job`      | Shows one job: its state, and for a job of this session its latest letters                                              |
| `jobs`     | Lists the jobs this session handed over or carries out                                                                  |
| `cancel`   | Takes back a job this session handed over                                                                               |
| `diff`     | Shows what a job changed in the git worktree it was given: the files and the patch                                      |
| `accept`   | Takes the work of a finished job into the checkout of this session, staged and not committed, or as a branch            |
| `reject`   | Drops the work of a finished job with its worktree                                                                      |
| `remember` | Puts a note on the board of the project: a fact that cost time to find out, or what a job taught                        |
| `recall`   | Looks at the board: the notes that fit some words, or the newest, each with who said it                                 |
| `forget`   | Takes a note this session put on the board off it                                                                       |
| `agents`   | Lists the sessions the bridge knows in the project, and the agents it can start a session of                            |

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

A recipe is a job the bridge itself carries out by fixed steps: it hands jobs of its own to the agents, waits for their reports and reports once at the end. No model decides what comes next.

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

**`build`: do, check, review, fix, check.** The text of the job is handed to `to` as a job in a git worktree of its own, with the `checks` of the input, which the bridge runs when the work is reported on. Then another agent reviews the work and names its findings. While a finding at or above `threshold` is open or the checks do not pass, the author is sent back with the findings, the checks run again, and the reviewer looks again, `rounds` times at most. The one report at the end says how the review ended, round by round, carries the findings of the last review, and names the job whose worktree holds the work. Its work is taken or dropped once the recipe has reported. A review that is not clean when the rounds run out does not fail the recipe: the work is there, and taking it is the caller's decision. A check the bridge did not run, because the rules do not allow it without asking, sends nobody back: the report says the result is not verified. The recipe fails when the work itself was not done, or no review of it was.

**`review`.** The same rounds for a job that is done already: `input.job` names it, and its author fixes what the review finds. Whoever handed that job over, carried it out, or started the recipe it was a step of may have it reviewed. The review and the fixes are done in the folder the job was done in. While a job still works on what another job left in its worktree, that worktree stays: `accept` and `reject` are refused until the review has reported or is canceled.

| Input       | Recipe   | What it says                                                                                               |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `to`        | `build`  | Who does the work: a harness word such as `claude`, for a session started for the job                      |
| `job`       | `review` | The job whose work is reviewed                                                                             |
| `by`        | both     | Who reviews: an agent, or a harness word for a fresh session. Another harness than the author's by default |
| `rounds`    | both     | How many times the author is sent back at most, 2 by default, 0 for a review that sends nothing back       |
| `threshold` | both     | The lightest finding worth sending back: `blocker`, `major` (the default), `minor` or `nit`                |
| `focus`     | both     | What the reviewer looks at above all                                                                       |
| `checks`    | `build`  | The commands that show the result holds, run after the work and after every round of fixes                 |
| `worktree`  | `build`  | `false` to have the work done in the caller's folder                                                       |
| `context`   | `build`  | What the caller knows and the agent does not, as `createJob` takes it                                      |

**Findings.** A reviewer names what it found in the `findings` of its report, each with a severity (`blocker`, `major`, `minor`, `nit`), a line of what is wrong and, where it has one, the file and the line. An agent without the tools writes one line for each, `[major] src/limiter.ts:12 - The window never resets`, or the single line `[none]`: `parseFindings` reads them. An empty list says the review found nothing. A report that names no findings in either form is not a clean review: the recipe then sends nothing back and hands the report on as it is. The findings of a report are kept on its job (`job.findings`) and shown under the report.

**Who does a later step.** The fixes go back to the author and the second look to the first reviewer when the bridge can wake them: `wakes(agent)` says whether a session waits for its mail or its harness wakes it for a letter. One that would only find the letter when a person opens it, such as a Codex thread that is open nowhere while no local daemon runs, is not waited for. A fresh session of the same harness gets the step then, with what it needs to know in the letter: what the job was, where the work lies, and what was found.

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

| Limit             | Default     | What happens                                                                                                             |
| ----------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Depth             | 3           | A job handed over from inside a job from inside a job is the deepest. One more is refused                                |
| Letters per job   | 60          | The job fails, both sides are told. The report that ends the job always goes through                                     |
| Time per job      | 4 hours     | The job fails, both sides are told                                                                                       |
| Reply timeout     | 30 minutes  | The one who owes an answer, or did not pick a job up, is reminded. After as long again the job fails                     |
| Jobs out          | 20          | An agent with that many jobs still in progress cannot hand over another                                                  |
| Jobs per hour     | 60          | Handing over faster is refused as a loop                                                                                 |
| Sessions starting | 2           | No more sessions are started at once                                                                                     |
| Silence           | 12 hours    | A session with no job in progress is taken for gone, unless its harness lists it or its hook waits                       |
| Session check     | 1 minute    | How often a harness that can list its sessions is asked which of them still run                                          |
| Window notice     | 10 minutes  | An agent that waits for a person at its own window is said so to whoever handed it a job, and not again within this time |
| Person's answer   | 4 hours     | The person is reminded of a letter that waits for them. After as long again the job fails                                |
| Delivery          | 5 attempts  | Retried with a growing wait, then left for the inbox                                                                     |
| Worktrees         | 2           | A third job of the project that asks for a worktree of its own is refused while two are in progress                      |
| Check             | 10 minutes  | A check that runs longer is ended with everything it started, and fails                                                  |
| Worktree kept     | 7 days      | The worktree of a finished job nobody took or dropped is removed, its work kept under a ref                              |
| Context           | 6000 tokens | The block the bridge adds under a job keeps to it: files are cut or only named, notes stop when it is full               |
| Context wait      | 10 seconds  | A job whose context could not be put together in that time is handed over without it                                     |

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

## Errors

Every refusal is a `BridgeError` with a `code` to branch on and a message written for the agent that gets it: `not_registered`, `unknown_agent`, `ambiguous_agent`, `no_session`, `unknown_job`, `unknown_letter`, `not_a_party`, `job_finished`, `invalid_letter`, `invalid_input`, `depth_exceeded`, `budget_exhausted`, `loop_detected`, `needs_person`, `no_person`, `no_worktree`, `worktree_limit`, `no_board`, `already_running`, `not_running`, `storage`.

## Documentation

Full guide: [cogitator.app/docs/bridge](https://cogitator.app/docs/bridge)

## Part of Cogitator

This package is part of the [Cogitator](https://github.com/cogitator-ai/Cogitator-AI) ecosystem, a self-hosted, production-grade AI agent runtime for TypeScript.

## License

MIT
