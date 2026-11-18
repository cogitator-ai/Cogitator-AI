---
'@cogitator-ai/bridge': patch
---

Three things a run with agents on other models showed.

- A job whose checks pass in a worktree it changed nothing in no longer counts as confirmed on the scoreboard: the checks passed before it began. An agent that answers "Done" without doing anything is now `unknown` until a review says otherwise, not `good`.
- A permission request of a hosted runtime agent shows the call alone. It used to start with the description of the tool, a manual of several lines that says nothing of the call.
- `suggest` writes "1 call" and "1 letter".
