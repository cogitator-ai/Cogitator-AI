---
'@cogitator-ai/bridge': minor
'@cogitator-ai/cli': minor
---

A job is handed over with what its caller knows, and the agents of a project share a board of notes.

- **The handover.** `createJob({ context })`, the `context` of the `delegate` tool and the flags `--done`, `--constraint`, `--decision` and `--file` of `cogitator bridge delegate` name what done looks like, the constraints, the decisions and the files to start from. The bridge puts them under the job in one block and adds the named lines of those files and the notes of the board that fit, within `contextTokens` (6000 by default, `limits.contextTokens`). No model is called.
- **The board of facts.** `remember`, `recall` and `forget`, as calls of the dispatcher and the client, as tools and as commands of `cogitator bridge`. A note is a fact or a lesson of a project, kept with who said it, on which job and when, for the whole project or for the two agents of one job. An agent takes off its own notes, the person any. Nothing is deleted.
- **What a job leaves.** A report takes `lessons` (`report` tool, `send --kind report --lesson`), which go to the board under the name of the agent that reported, and the bridge notes how each job ended. A later job that is about the same gets them in its handover.
- `@cogitator-ai/bridge/memory`: `memoryBoard()` keeps the board with `@cogitator-ai/memory`, now an optional peer dependency. `hostBridge({ board })` takes any `FactBoard`. `cogitator bridge serve` keeps one in `memory.db` in the folder of the bridge.

The socket has three new methods, `facts/remember`, `facts/recall` and `facts/forget`: restart a dispatcher that runs. A bridge that was given no board refuses them with `no_board` and hands jobs over with what their caller named alone.
